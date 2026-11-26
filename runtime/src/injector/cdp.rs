use crate::ApiError;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc, oneshot, Notify},
};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

type Pending = oneshot::Sender<Result<Value, ApiError>>;

struct Channel {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    outgoing: mpsc::Sender<Value>,
    events: broadcast::Sender<Value>,
    closed: AtomicBool,
    shutdown: Notify,
}

impl Channel {
    fn receive(&self, value: Value) {
        if let Some(id) = value["id"].as_u64() {
            if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                let result = if value.get("error").is_some() {
                    Err(ApiError::new(
                        502,
                        "CDP_ERROR",
                        value["error"]["message"]
                            .as_str()
                            .unwrap_or("CDP request failed"),
                    )
                    .with_details(value["error"].clone()))
                } else {
                    Ok(value["result"].clone())
                };
                let _ = sender.send(result);
            }
        } else {
            let _ = self.events.send(value);
        }
    }

    fn close(&self, detail: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shutdown.notify_waiters();
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(ApiError::new(502, "CDP_CLOSED", detail)));
        }
        let _ = self
            .events
            .send(json!({"method":"Inspector.detached","params":{"reason":detail}}));
    }
}

/// 同一传输上的命令按 id 配对，页面会话用 sessionId 隔离，避免并发 RPC 串线。
#[derive(Clone)]
pub struct Connection {
    channel: Arc<Channel>,
    session_id: Option<String>,
}

impl Connection {
    fn channel() -> (Arc<Channel>, mpsc::Receiver<Value>) {
        let (outgoing, receiver) = mpsc::channel(128);
        let (events, _) = broadcast::channel(512);
        (
            Arc::new(Channel {
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                outgoing,
                events,
                closed: AtomicBool::new(false),
                shutdown: Notify::new(),
            }),
            receiver,
        )
    }

    pub async fn websocket(value: &str, port: u16) -> Result<Self, ApiError> {
        validate_websocket(value, port)?;
        let (socket, _) = tokio_tungstenite::connect_async(value)
            .await
            .map_err(|e| ApiError::new(502, "CDP_CONNECT", e.to_string()))?;
        let (mut sink, mut stream) = socket.split();
        let (channel, mut outgoing) = Self::channel();
        let writer_channel = channel.clone();
        tokio::spawn(async move {
            loop {
                let value = tokio::select! {_=writer_channel.shutdown.notified()=>break,value=outgoing.recv()=>match value{Some(value)=>value,None=>break}};
                if sink
                    .send(Message::Text(value.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            writer_channel.close("CDP WebSocket writer closed");
            let _ = sink.close().await;
        });
        let reader_channel = channel.clone();
        tokio::spawn(async move {
            loop {
                let message = tokio::select! {_=reader_channel.shutdown.notified()=>break,value=stream.next()=>match value{Some(value)=>value,None=>break}};
                match message {
                    Ok(Message::Text(text)) => match serde_json::from_str(text.as_ref()) {
                        Ok(value) => reader_channel.receive(value),
                        Err(_) => {
                            reader_channel.close("Invalid CDP JSON response");
                            break;
                        }
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            reader_channel.close("CDP WebSocket closed");
        });
        Ok(Self {
            channel,
            session_id: None,
        })
    }

    pub fn pipe<R, W>(reader: R, mut writer: W) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (channel, mut outgoing) = Self::channel();
        let writer_channel = channel.clone();
        tokio::spawn(async move {
            loop {
                let value = tokio::select! {_=writer_channel.shutdown.notified()=>break,value=outgoing.recv()=>match value{Some(value)=>value,None=>break}};
                let mut message = value.to_string().into_bytes();
                message.push(0);
                if writer.write_all(&message).await.is_err() {
                    break;
                }
            }
            writer_channel.close("CDP pipe writer closed");
        });
        let reader_channel = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            loop {
                let mut bytes = Vec::new();
                match tokio::select! {_=reader_channel.shutdown.notified()=>break,value=reader.read_until(0,&mut bytes)=>value}
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                // CDP 源码结果可能很大；仍为单条消息设置上限，防止异常宿主耗尽内存。
                if bytes.len() > 256 * 1024 * 1024 {
                    break;
                }
                if bytes.last() == Some(&0) {
                    bytes.pop();
                }
                match serde_json::from_slice(&bytes) {
                    Ok(value) => reader_channel.receive(value),
                    Err(_) => break,
                }
            }
            reader_channel.close("CDP pipe closed");
        });
        Self {
            channel,
            session_id: None,
        }
    }

    pub fn is_closed(&self) -> bool {
        self.channel.closed.load(Ordering::SeqCst)
    }
    pub fn close(&self) {
        self.channel.close("CDP connection closed by owner");
    }
    pub fn events(&self) -> broadcast::Receiver<Value> {
        self.channel.events.subscribe()
    }
    pub fn owns_event(&self, event: &Value) -> bool {
        event.get("sessionId").and_then(Value::as_str) == self.session_id.as_deref()
    }

    pub async fn send(&self, method: &str, params: Value) -> Result<Value, ApiError> {
        self.send_timeout(method, params, Duration::from_secs(30))
            .await
    }

    pub async fn send_timeout(
        &self,
        method: &str,
        params: Value,
        duration: Duration,
    ) -> Result<Value, ApiError> {
        if self.is_closed() {
            return Err(ApiError::new(502, "CDP_CLOSED", "CDP connection closed"));
        }
        let id = self.channel.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.channel.pending.lock().unwrap().insert(id, sender);
        let mut value = json!({"id":id,"method":method,"params":params});
        if method != "Target.getTargets" {
            if let Some(session) = &self.session_id {
                value["sessionId"] = json!(session);
            }
        }
        if self.channel.outgoing.send(value).await.is_err() {
            self.channel.pending.lock().unwrap().remove(&id);
            return Err(ApiError::new(502, "CDP_CLOSED", "CDP command queue closed"));
        }
        match tokio::time::timeout(duration, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ApiError::new(
                502,
                "CDP_CLOSED",
                "CDP response queue closed",
            )),
            Err(_) => {
                self.channel.pending.lock().unwrap().remove(&id);
                Err(ApiError::new(
                    504,
                    "CDP_TIMEOUT",
                    format!("Timed out waiting for CDP {method}"),
                ))
            }
        }
    }

    pub async fn evaluate(
        &self,
        expression: &str,
        context: Option<i64>,
    ) -> Result<Value, ApiError> {
        let mut params = json!({"expression":expression,"awaitPromise":true,"returnByValue":true});
        if let Some(context) = context {
            params["contextId"] = json!(context);
        }
        let response = self.send("Runtime.evaluate", params).await?;
        if let Some(exception) = response.get("exceptionDetails") {
            return Err(ApiError::new(
                502,
                "CODEX_EVALUATION_FAILED",
                exception["exception"]["description"]
                    .as_str()
                    .or_else(|| exception["text"].as_str())
                    .unwrap_or("Codex evaluation failed"),
            )
            .with_details(exception.clone()));
        }
        Ok(response["result"]["value"].clone())
    }

    pub async fn attach(&self, target_id: &str) -> Result<Self, ApiError> {
        let response = self
            .send(
                "Target.attachToTarget",
                json!({"targetId":target_id,"flatten":true}),
            )
            .await?;
        let session = response["sessionId"]
            .as_str()
            .ok_or_else(|| ApiError::new(502, "CDP_SESSION", "Missing CDP session id"))?;
        Ok(Self {
            channel: self.channel.clone(),
            session_id: Some(session.into()),
        })
    }

    pub async fn detach(&self) {
        if let Some(session) = &self.session_id {
            let root = Self {
                channel: self.channel.clone(),
                session_id: None,
            };
            let _ = root
                .send("Target.detachFromTarget", json!({"sessionId":session}))
                .await;
        }
    }
}

pub fn validate_websocket(value: &str, port: u16) -> Result<Url, ApiError> {
    let url = Url::parse(value)
        .map_err(|_| ApiError::new(400, "CDP_URL", "Invalid CDP WebSocket URL"))?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(port)
        || !url.path().starts_with("/devtools/page/")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::new(
            400,
            "CDP_URL",
            "Rejected unexpected Codex CDP target URL",
        ));
    }
    Ok(url)
}

pub fn is_main_target(target: &Value) -> bool {
    if target["type"] != "page" {
        return false;
    }
    let Some(value) = target["url"].as_str() else {
        return false;
    };
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let route = url
        .query_pairs()
        .find(|(k, _)| k == "initialRoute")
        .map(|(_, v)| v.into_owned());
    let initial = route.as_deref().unwrap_or("");
    if url.path() == "/detached-window.html"
        || initial == "/detached-window"
        || initial.starts_with("/detached-window/")
    {
        return false;
    }
    let page = route
        .as_deref()
        .and_then(|r| url.join(r).ok())
        .unwrap_or_else(|| url.clone());
    if page.path().starts_with("/space/")
        && page.path()[7..].split('/').count() == 1
        && page
            .query_pairs()
            .any(|(key, val)| key == "window" && val == "page")
    {
        return false;
    }
    !initial.starts_with("/global-dictation")
        && !initial.starts_with("/avatar-overlay")
        && (url.scheme() == "app" || target["title"] == "Codex")
}

pub fn is_avatar_target(target: &Value) -> bool {
    if target["type"] != "page" {
        return false;
    }
    let Some(value) = target["url"].as_str() else {
        return false;
    };
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "app" {
        return false;
    }
    let route = url
        .query_pairs()
        .find(|(key, _)| key == "initialRoute")
        .map(|(_, value)| value.into_owned());
    route
        .as_deref()
        .and_then(|route| url.join(route).ok())
        .is_some_and(|route| route.path() == "/avatar-overlay")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_scope_and_loopback_boundaries() {
        assert!(validate_websocket("ws://127.0.0.1:9229/devtools/page/a", 9229).is_ok());
        for url in [
            "ws://localhost:9229/devtools/page/a",
            "ws://127.0.0.1:9230/devtools/page/a",
            "ws://x@127.0.0.1:9229/devtools/page/a",
            "wss://127.0.0.1:9229/devtools/page/a",
        ] {
            assert!(validate_websocket(url, 9229).is_err());
        }
        assert!(is_main_target(
            &json!({"type":"page","url":"app://-/index.html","title":"Codex"})
        ));
        assert!(!is_main_target(
            &json!({"type":"page","url":"app://-/detached-window.html?initialRoute=%2Fdetached-window","title":"Codex"})
        ));
        assert!(!is_main_target(
            &json!({"type":"page","url":"app://-/index.html?initialRoute=%2Favatar-overlay","title":"Codex"})
        ));
        assert!(is_avatar_target(
            &json!({"type":"page","url":"app://-/index.html?initialRoute=%2Favatar-overlay","title":"Codex"})
        ));
        assert!(!is_avatar_target(
            &json!({"type":"page","url":"https://example.test/?initialRoute=%2Favatar-overlay"})
        ));
    }

    #[tokio::test]
    async fn pipe_correlates_responses_and_rejects_disconnect() {
        let (client, server) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(client);
        let cdp = Connection::pipe(reader, writer);
        let peer = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server);
            let mut reader = BufReader::new(reader);
            let mut first = Vec::new();
            reader.read_until(0, &mut first).await.unwrap();
            first.pop();
            let first: Value = serde_json::from_slice(&first).unwrap();
            let mut second = Vec::new();
            reader.read_until(0, &mut second).await.unwrap();
            second.pop();
            let second: Value = serde_json::from_slice(&second).unwrap();
            for command in [second, first] {
                let mut reply = json!({"id":command["id"],"result":{"method":command["method"]}})
                    .to_string()
                    .into_bytes();
                reply.push(0);
                writer.write_all(&reply).await.unwrap();
            }
        });
        let (left, right) = tokio::join!(
            cdp.send("Page.enable", json!({})),
            cdp.send("Runtime.enable", json!({}))
        );
        assert_eq!(left.unwrap()["method"], "Page.enable");
        assert_eq!(right.unwrap()["method"], "Runtime.enable");
        peer.await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(cdp.send("Page.reload", json!({})).await.is_err());
        cdp.close();
    }
}
