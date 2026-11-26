use crate::ApiError;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch, Mutex},
    task::JoinHandle,
};

pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, ApiError>> + Send>>;

pub struct Callbacks {
    pub request: Arc<dyn Fn(String, Value) -> BoxFuture + Send + Sync>,
    pub initialize: Arc<dyn Fn() -> BoxFuture + Send + Sync>,
    pub retain: Arc<dyn Fn(String, bool) -> BoxFuture + Send + Sync>,
}

struct Client {
    initialized: bool,
    threads: HashSet<String>,
    sender: mpsc::UnboundedSender<Value>,
}
struct SessionState {
    clients: HashMap<String, Client>,
    retained: HashMap<String, HashSet<String>>,
}
struct Inner {
    callbacks: Callbacks,
    authorization: Vec<u8>,
    state: Mutex<SessionState>,
    shutdown: watch::Sender<bool>,
    closed: AtomicBool,
}

pub struct Gateway {
    inner: Arc<Inner>,
    pub descriptor: Value,
    pub descriptor_path: PathBuf,
    task: Mutex<Option<JoinHandle<Result<(), std::io::Error>>>>,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.inner.shutdown.send(true);
        // 异常路径也只删除本进程自己的描述文件，不覆盖后来启动的网关。
        if let Ok(bytes) = std::fs::read(&self.descriptor_path) {
            if let Ok(saved) = serde_json::from_slice::<Value>(&bytes) {
                if saved["pid"] == self.descriptor["pid"]
                    && saved["token"] == self.descriptor["token"]
                {
                    let _ = std::fs::remove_file(&self.descriptor_path);
                }
            }
        }
    }
}

impl Gateway {
    pub async fn start(
        data_directory: &Path,
        executable: &Path,
        callbacks: Callbacks,
    ) -> Result<Self, ApiError> {
        if !data_directory.is_absolute() || !executable.is_absolute() {
            return Err(ApiError::new(
                400,
                "SHARED_SESSION_PATH",
                "共享会话的数据目录和 CLI 路径必须是绝对路径",
            ));
        }
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (shutdown, _) = watch::channel(false);
        let inner = Arc::new(Inner {
            callbacks,
            authorization: format!("Bearer {token}").into_bytes(),
            state: Mutex::new(SessionState {
                clients: HashMap::new(),
                retained: HashMap::new(),
            }),
            shutdown,
            closed: AtomicBool::new(false),
        });
        let descriptor = json!({"version":1,"pid":std::process::id(),"port":port,"token":token,"executable":executable});
        let descriptor_path = data_directory.join("shared-session.json");
        let temporary = data_directory.join(format!(
            "shared-session.json.{}.{}.tmp",
            std::process::id(),
            &token[..8]
        ));
        tokio::fs::create_dir_all(data_directory).await?;
        let saved = async {
            use tokio::io::AsyncWriteExt;
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).await?;
            file.write_all(format!("{descriptor}\n").as_bytes()).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &descriptor_path).await?;
            Ok::<_, std::io::Error>(())
        }
        .await;
        if let Err(error) = saved {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        let mut stop = inner.shutdown.subscribe();
        let app = Router::new().fallback(accept).with_state(inner.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    while !*stop.borrow() {
                        if stop.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await
        });
        Ok(Self {
            inner,
            descriptor,
            descriptor_path,
            task: Mutex::new(Some(task)),
        })
    }

    pub async fn publish(&self, notification: Value) {
        let Some(method) = notification["method"].as_str() else {
            return;
        };
        let thread = notification
            .pointer("/params/threadId")
            .or_else(|| notification.pointer("/params/thread/id"))
            .and_then(Value::as_str);
        let message = json!({"method":method,"params":notification["params"]});
        let mut state = self.inner.state.lock().await;
        for client in state.clients.values() {
            if client.initialized && thread.map_or(true, |thread| client.threads.contains(thread)) {
                let _ = client.sender.send(message.clone());
            }
        }
        if ["thread/closed", "thread/archived", "thread/deleted"].contains(&method) {
            if let Some(thread) = thread {
                let clients = state.clients.keys().cloned().collect::<Vec<_>>();
                for id in clients {
                    let _ = unsubscribe_locked(&self.inner, &mut state, &id, thread).await;
                }
            }
        }
    }

    pub async fn close(&self) -> Result<(), ApiError> {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.inner.shutdown.send(true);
        let mut failure = None;
        {
            let mut state = self.inner.state.lock().await;
            let ids = state.clients.keys().cloned().collect::<Vec<_>>();
            for id in ids {
                if let Err(error) = release_client_locked(&self.inner, &mut state, &id).await {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        if let Some(task) = self.task.lock().await.take() {
            task.await
                .map_err(|e| ApiError::new(500, "SHARED_SESSION_CLOSE", e.to_string()))??;
        }
        remove_descriptor(&self.descriptor_path, &self.descriptor).await?;
        failure.map_or(Ok(()), Err)
    }
}

async fn remove_descriptor(path: &Path, descriptor: &Value) -> Result<(), ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let saved: Value = serde_json::from_slice(&bytes)?;
            if saved["pid"] == descriptor["pid"] && saved["token"] == descriptor["token"] {
                tokio::fs::remove_file(path).await?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn accept(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let supplied = headers
        .get("authorization")
        .map(|v| v.as_bytes())
        .unwrap_or(&[]);
    if headers.contains_key("origin")
        || supplied.len() != inner.authorization.len()
        || !bool::from(supplied.ct_eq(&inner.authorization))
        || inner.closed.load(Ordering::SeqCst)
    {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    match upgrade {
        Ok(upgrade) => upgrade
            .max_message_size(16 * 1024 * 1024)
            .max_frame_size(16 * 1024 * 1024)
            .on_upgrade(move |socket| client(inner, socket)),
        Err(error) => error.into_response(),
    }
}

fn failure(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut error = json!({"code":code,"message":message.into()});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"id":id,"error":error})
}

async fn client(inner: Arc<Inner>, socket: WebSocket) {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, mut outbound) = mpsc::unbounded_channel();
    inner.state.lock().await.clients.insert(
        id.clone(),
        Client {
            initialized: false,
            threads: HashSet::new(),
            sender: sender.clone(),
        },
    );
    let (mut output, mut input) = socket.split();
    let mut shutdown = inner.shutdown.subscribe();
    let mut writer_shutdown = inner.shutdown.subscribe();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _=writer_shutdown.changed()=>{let _=output.send(Message::Close(None)).await;break;}
                response=outbound.recv()=>match response{Some(response)=>{if output.send(Message::Text(response.to_string().into())).await.is_err(){break;}},None=>break}
            }
        }
    });
    loop {
        tokio::select! {
            _=shutdown.changed()=>break,
            message=input.next()=>{
                let message=match message{Some(Ok(Message::Text(text)))=>text,Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,Some(Ok(Message::Ping(_)))|Some(Ok(Message::Pong(_)))=>continue,_=>{let _=sender.send(failure(Value::Null,-32700,"无效的 JSON 请求",None));continue;}};
                let message=match serde_json::from_str::<Value>(&message){Ok(message)=>message,Err(_)=>{let _=sender.send(failure(Value::Null,-32700,"无效的 JSON 请求",None));continue;}};
                let inner=inner.clone();let id=id.clone();let sender=sender.clone();
                tokio::spawn(async move{let response=process(&inner,&id,message).await;if let Some(response)=response{let _=sender.send(response);}});
            }
        }
    }
    let mut state = inner.state.lock().await;
    let _ = release_client_locked(&inner, &mut state, &id).await;
    writer.abort();
}

async fn process(inner: &Inner, client_id: &str, message: Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = message["method"].as_str().filter(|_| message.is_object()) else {
        return Some(failure(id, -32600, "无效的请求", None));
    };
    if message.get("id").is_none() {
        return None;
    }
    if !id.is_string() && !id.is_number() {
        return Some(failure(Value::Null, -32600, "无效的请求 ID", None));
    }
    if method == "initialize" {
        let mut state = inner.state.lock().await;
        let Some(client) = state.clients.get_mut(client_id) else {
            return None;
        };
        if client.initialized {
            return Some(failure(id, -32600, "连接已经初始化", None));
        }
        return match (inner.callbacks.initialize)().await {
            Ok(result) => {
                client.initialized = true;
                Some(json!({"id":id,"result":result}))
            }
            Err(error) => Some(failure(id, -32603, error.message, error.details)),
        };
    }
    if !inner
        .state
        .lock()
        .await
        .clients
        .get(client_id)
        .is_some_and(|c| c.initialized)
    {
        return Some(failure(id, -32002, "连接尚未初始化", None));
    }
    if [
        "userVerification/enroll",
        "userVerification/delete",
        "userVerification/verify",
        "userVerification/cancel",
    ]
    .contains(&method)
    {
        return Some(failure(
            id,
            -32600,
            "本机身份验证仅可在 Codex App 中完成",
            None,
        ));
    }
    if method == "thread/start" || method == "thread/fork" {
        return Some(failure(
            id,
            -32600,
            "共享模式用于继续已有会话，请先在 Codex App 中创建或分叉会话，再从共享 CLI 选择。",
            None,
        ));
    }
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    if method == "thread/unsubscribe" {
        let thread = params["threadId"].as_str().unwrap_or("");
        let mut state = inner.state.lock().await;
        return Some(
            match unsubscribe_locked(inner, &mut state, client_id, thread).await {
                Ok(found) => {
                    json!({"id":id,"result":{"status":if found{"unsubscribed"}else{"notSubscribed"}}})
                }
                Err(error) => failure(id, -32603, error.message, error.details),
            },
        );
    }
    let resume = if method == "thread/resume" {
        params["threadId"].as_str().map(str::to_owned)
    } else {
        None
    };
    let subscribed = if let Some(thread) = &resume {
        inner
            .state
            .lock()
            .await
            .clients
            .get(client_id)
            .is_some_and(|c| c.threads.contains(thread))
    } else {
        false
    };
    if let Some(thread) = &resume {
        let mut state = inner.state.lock().await;
        if let Err(error) = subscribe_locked(inner, &mut state, client_id, thread).await {
            return Some(failure(id, -32603, error.message, error.details));
        }
    }
    let result = (inner.callbacks.request)(method.into(), params).await;
    match result {
        Ok(result) => {
            if let Some(resume) = &resume {
                if let Some(actual) = result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .filter(|actual| *actual != resume)
                {
                    let mut state = inner.state.lock().await;
                    if let Err(error) = subscribe_locked(inner, &mut state, client_id, actual).await
                    {
                        return Some(failure(id, -32603, error.message, error.details));
                    }
                }
            }
            Some(json!({"id":id,"result":result}))
        }
        Err(error) => {
            if !subscribed {
                if let Some(thread) = &resume {
                    let mut state = inner.state.lock().await;
                    let _ = unsubscribe_locked(inner, &mut state, client_id, thread).await;
                }
            }
            Some(failure(
                id,
                error.code.parse().unwrap_or(-32603),
                error.message,
                error.details,
            ))
        }
    }
}

async fn subscribe_locked(
    inner: &Inner,
    state: &mut SessionState,
    id: &str,
    thread: &str,
) -> Result<(), ApiError> {
    if !state.clients.contains_key(id) {
        return Err(ApiError::new(
            409,
            "SHARED_SESSION_CLOSED",
            "共享 CLI 连接已经关闭",
        ));
    }
    if state.clients[id].threads.contains(thread) {
        return Ok(());
    }
    if !state.retained.contains_key(thread) {
        (inner.callbacks.retain)(thread.into(), true).await?;
        state.retained.insert(thread.into(), HashSet::new());
    }
    state.retained.get_mut(thread).unwrap().insert(id.into());
    state
        .clients
        .get_mut(id)
        .unwrap()
        .threads
        .insert(thread.into());
    Ok(())
}

async fn unsubscribe_locked(
    inner: &Inner,
    state: &mut SessionState,
    id: &str,
    thread: &str,
) -> Result<bool, ApiError> {
    if !state
        .clients
        .get_mut(id)
        .is_some_and(|client| client.threads.remove(thread))
    {
        return Ok(false);
    }
    if let Some(subscribers) = state.retained.get_mut(thread) {
        subscribers.remove(id);
        if subscribers.is_empty() {
            // 最后一个 CLI 离开后才释放原生租约；锁同时阻止新订阅越过释放操作。
            let result = (inner.callbacks.retain)(thread.into(), false).await;
            state.retained.remove(thread);
            result?;
        }
    }
    Ok(true)
}

async fn release_client_locked(
    inner: &Inner,
    state: &mut SessionState,
    id: &str,
) -> Result<(), ApiError> {
    let threads = state
        .clients
        .get(id)
        .map(|client| client.threads.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let mut failure = None;
    for thread in threads {
        if let Err(error) = unsubscribe_locked(inner, state, id, &thread).await {
            if failure.is_none() {
                failure = Some(error);
            }
        }
    }
    state.clients.remove(id);
    failure.map_or(Ok(()), Err)
}

const NATIVE_SOURCE: &str = include_str!("../../scripts/codex-shared-session-native.mjs");
fn declarations() -> String {
    NATIVE_SOURCE.replace("export async function", "async function")
}
pub fn initialization_expression(loader: &str) -> String {
    format!(
        "(async()=>{{{};return await readSharedSessionInitialization(await ({loader})());}})()",
        declarations()
    )
}
pub fn retention_expression(loader: &str, thread: &str, retain: bool) -> String {
    format!(
        "(async()=>{{{};return await retainSharedConversation({}, {}, {retain});}})()",
        declarations(),
        if retain {
            format!("await ({loader})()")
        } else {
            "null".into()
        },
        serde_json::to_string(thread).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    async fn connect(
        gateway: &Gateway,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = format!("ws://127.0.0.1:{}", gateway.descriptor["port"])
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", gateway.descriptor["token"].as_str().unwrap())
                .parse()
                .unwrap(),
        );
        connect_async(request).await.unwrap().0
    }
    async fn call(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        id: u64,
        method: &str,
        params: Value,
    ) -> Value {
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(message.to_text().unwrap()).unwrap()
    }
    #[tokio::test]
    async fn shared_gateway_keeps_one_native_lease_and_blocks_privileged_requests() {
        let directory = tempfile::tempdir().unwrap();
        let leases = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let callbacks = Callbacks {
            initialize: Arc::new(|| {
                Box::pin(async {
                    Ok(
                        json!({"userAgent":"codex/fixture","codexHome":"/fixture","platformFamily":"unix","platformOs":"macos"}),
                    )
                })
            }),
            request: {
                let calls = calls.clone();
                Arc::new(move |method, params| {
                    let calls = calls.clone();
                    Box::pin(async move {
                        calls.lock().await.push(method);
                        Ok(json!({"thread":{"id":params["threadId"]}}))
                    })
                })
            },
            retain: {
                let leases = leases.clone();
                Arc::new(move |thread, retain| {
                    let leases = leases.clone();
                    Box::pin(async move {
                        leases.lock().await.push((thread, retain));
                        Ok(Value::Null)
                    })
                })
            },
        };
        let gateway = Gateway::start(
            directory.path(),
            &std::env::current_exe().unwrap(),
            callbacks,
        )
        .await
        .unwrap();
        let mut first = connect(&gateway).await;
        let mut second = connect(&gateway).await;
        assert_eq!(
            call(&mut first, 1, "thread/resume", json!({"threadId":"thread"})).await["error"]
                ["code"],
            -32002
        );
        assert_eq!(
            call(&mut first, 2, "initialize", json!({})).await["result"]["userAgent"],
            "codex/fixture"
        );
        call(&mut second, 3, "initialize", json!({})).await;
        assert_eq!(
            call(&mut first, 4, "thread/start", json!({})).await["error"]["code"],
            -32600
        );
        assert_eq!(
            call(&mut first, 5, "userVerification/verify", json!({})).await["error"]["code"],
            -32600
        );
        call(&mut first, 6, "thread/resume", json!({"threadId":"thread"})).await;
        call(
            &mut second,
            7,
            "thread/resume",
            json!({"threadId":"thread"}),
        )
        .await;
        assert_eq!(*leases.lock().await, vec![("thread".into(), true)]);
        gateway.publish(json!({"method":"item/completed","params":{"threadId":"thread","item":{"text":"event"}}})).await;
        for socket in [&mut first, &mut second] {
            let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap()["method"],
                "item/completed"
            );
        }
        call(
            &mut first,
            8,
            "thread/unsubscribe",
            json!({"threadId":"thread"}),
        )
        .await;
        assert_eq!(leases.lock().await.len(), 1);
        call(
            &mut second,
            9,
            "thread/unsubscribe",
            json!({"threadId":"thread"}),
        )
        .await;
        assert_eq!(
            *leases.lock().await,
            vec![("thread".into(), true), ("thread".into(), false)]
        );
        assert_eq!(*calls.lock().await, vec!["thread/resume", "thread/resume"]);
        gateway.close().await.unwrap();
        assert!(!gateway.descriptor_path.exists());
    }

    #[tokio::test]
    async fn shared_gateway_rejects_browser_origin_before_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let gateway = Gateway::start(
            directory.path(),
            &std::env::current_exe().unwrap(),
            Callbacks {
                initialize: Arc::new(|| Box::pin(async { Ok(json!({})) })),
                request: Arc::new(|_, _| Box::pin(async { Ok(Value::Null) })),
                retain: Arc::new(|_, _| Box::pin(async { Ok(Value::Null) })),
            },
        )
        .await
        .unwrap();
        let mut request = format!("ws://127.0.0.1:{}", gateway.descriptor["port"])
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", gateway.descriptor["token"].as_str().unwrap())
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert("origin", "http://127.0.0.1".parse().unwrap());
        assert!(connect_async(request).await.is_err());
        gateway.close().await.unwrap();
    }
}
