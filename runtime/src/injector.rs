#[path = "injector/adapters.rs"]
mod adapters;
#[path = "injector/bridge.rs"]
mod bridge;
#[path = "injector/cdp.rs"]
mod cdp;
#[path = "injector/config.rs"]
mod config;
#[path = "injector/control.rs"]
mod control;
#[path = "injector/features.rs"]
mod features;
#[path = "injector/legacy.rs"]
mod legacy;
#[path = "injector/pets.rs"]
mod pets;
#[path = "injector/processes.rs"]
mod processes;
#[path = "injector/repository.rs"]
mod repository;
#[path = "injector/revisions.rs"]
mod revisions;
#[path = "injector/source_ast.rs"]
mod source_ast;
#[path = "injector/tabs.rs"]
mod tabs;
#[path = "injector/terminal.rs"]
mod terminal;
#[path = "injector/update_bindings.rs"]
mod update_bindings;

use crate::ApiError;
use base64::Engine;
use config::{Environment, Options};
use futures_util::{
    future::{BoxFuture, Shared},
    stream::FuturesUnordered,
    FutureExt, StreamExt,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::{
    process::Child,
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

static NOTIFICATIONS: OnceLock<broadcast::Sender<Value>> = OnceLock::new();

pub fn subscribe_notifications() -> broadcast::Receiver<Value> {
    NOTIFICATIONS
        .get_or_init(|| broadcast::channel(512).0)
        .subscribe()
}

pub async fn control_request(
    runtime_file: &Path,
    action: &str,
    mut payload: Value,
) -> Result<Value, ApiError> {
    if !payload.is_object() {
        return Err(ApiError::new(
            400,
            "CONTROL_REQUEST",
            "Control payload must be an object",
        ));
    }
    payload["action"] = json!(action);
    control::request(runtime_file, None, payload).await
}

fn emit(event: &str, mut data: Value) {
    data["launcherEvent"] = json!(event);
    println!("{data}");
}

struct Target {
    connection: cdp::Connection,
    _events: AbortTask,
    patches: Option<JoinHandle<()>>,
    retry: Arc<tokio::sync::Notify>,
    applying: Arc<AtomicBool>,
    adapting: Arc<AtomicBool>,
}

impl Target {
    fn obsolete(&self, present: bool) -> bool {
        self.connection.is_closed() || !present && !self.applying.load(Ordering::SeqCst)
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        if let Some(task) = &self.patches {
            task.abort();
        }
    }
}

async fn source(environment: &Environment) -> Result<(String, String), ApiError> {
    let script =
        tokio::fs::read_to_string(environment.app_root.join("inject/codex-panel.user.js")).await?;
    let mut digest = Sha256::new();
    digest.update(b"codex-panel-rust-injector-v1\0");
    digest.update(script.as_bytes());
    // 原生桥发生变化也必须更换注入标识，不能仅比较网页脚本。
    digest.update(include_bytes!("injector/bridge.rs"));
    digest.update(include_bytes!("injector/source_ast.rs"));
    digest.update(include_bytes!("injector/adapters.rs"));
    digest.update(include_bytes!("injector/features.rs"));
    digest.update(include_bytes!("injector/tabs.rs"));
    digest.update(include_bytes!("injector/terminal.rs"));
    digest.update(include_bytes!("injector/pets.rs"));
    digest.update(include_bytes!("injector/repository.rs"));
    digest.update(include_bytes!("injector/legacy.rs"));
    digest.update(include_bytes!("injector/update_bindings.rs"));
    for asset in [
        include_str!("injector/assets/legacy_tabs_runtime.js"),
        include_str!("injector/assets/legacy_ultrafast_access.js"),
        include_str!("injector/assets/legacy_ultrafast_model.js"),
        include_str!("injector/assets/app_server_0.js"),
        include_str!("injector/assets/automation_0.js"),
        include_str!("injector/assets/find_require.js"),
        include_str!("injector/assets/pet_selection.js"),
    ] {
        digest.update(asset.as_bytes());
    }
    for asset in [
        include_str!("injector/assets/rspack_runtime.js"),
        include_str!("injector/assets/tabs_runtime.js"),
        include_str!("injector/assets/pet_runtime.js"),
        include_str!("injector/assets/repository_runtime.js"),
        include_str!("injector/assets/settings_runtime.js"),
        include_str!("injector/assets/preference_runtime.js"),
        include_str!("injector/assets/terminal_runtime.js"),
    ] {
        digest.update(asset.as_bytes());
    }
    let hash = hex::encode(digest.finalize());
    let source=format!("window.__CODEX_PANEL_SOURCE_HASH__={};\nwindow.__CODEX_PANEL_MANAGED_ORIGIN__={};\nwindow.__CODEX_PANEL_HOST_CAPABILITY__={};\nwindow.__CODEX_PANEL_URL__={};\nwindow.__CODEX_PANEL_PRIVATE_FRAME__={};\n{}",
        json!(hash),json!(environment.origin()),json!(environment.capability),json!(environment.page_url()),environment.token.is_some(),script);
    Ok((hash, source))
}

async fn wait_renderer(cdp: &cdp::Connection) -> Result<(), ApiError> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(value) = cdp
            .evaluate(
                "({readyState:document.readyState,href:location.href})",
                None,
            )
            .await
        {
            if value["readyState"] == "complete"
                && value["href"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("app://"))
            {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(ApiError::new(
        504,
        "CODEX_RENDERER",
        "Timed out waiting for Codex renderer",
    ))
}

struct ConversationOperation {
    started: Instant,
    token: uuid::Uuid,
    future: Shared<BoxFuture<'static, Result<Value, ApiError>>>,
}

async fn bridge_events(
    cdp: cdp::Connection,
    initial_context: i64,
    environment: Environment,
    client: reqwest::Client,
    startup: Option<String>,
    policies: Arc<crate::automation::PolicyManager>,
) {
    let mut receiver = cdp.events();
    let mut context = initial_context;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    let operations = std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::<
        String,
        ConversationOperation,
    >::new()));
    let mut requests = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _=requests.join_next(),if !requests.is_empty()=>{},
            _=heartbeat.tick()=>{
                if cdp.is_closed(){break;}
                if let Err(error)=bridge::heartbeat(&cdp,context,&environment,startup.as_deref()).await {eprintln!("Panel heartbeat: {error}");}
            },
            message=receiver.recv()=>{
                let Ok(message)=message else {break;};
                if !cdp.owns_event(&message){continue;}
                match message["method"].as_str(){
                    Some("Page.loadEventFired")=>{
                        match bridge::install(&cdp,&environment).await {Ok(next)=>context=next,Err(error)=>eprintln!("Panel host bridge: {error}")}
                    },
                    Some("Runtime.bindingCalled")=>{
                        let params=&message["params"];
                        if params["name"]=="__codexPanelPlayPetAudioV1" {
                            if let (Some(id),Some(context))=(params["payload"].as_str().and_then(|value|value.parse::<u64>().ok()).filter(|id|*id>0&&*id<=9_999_999_999),params["executionContextId"].as_i64()) {
                                let _=cdp.send("Runtime.evaluate",json!({"expression":format!("globalThis.__codexPanelPetAnimations__?.playAudio({id})"),"contextId":context,"userGesture":true,"awaitPromise":true,"returnByValue":true})).await;
                            }
                            continue;
                        }
                        if params["executionContextId"].as_i64()!=Some(context){continue;}
                        let Some(payload)=params["payload"].as_str().filter(|s|s.len()<=16*1024*1024&&s.encode_utf16().count()<=4_194_304)else{continue;};
                        let Ok(request)=serde_json::from_str::<Value>(payload)else{continue;};
                        if params["name"]=="__codexPanelCodexNotificationV1" {
                            if request["hostId"].is_string()&&request["method"].is_string(){let _=NOTIFICATIONS.get_or_init(||broadcast::channel(512).0).send(request);}
                            continue;
                        }
                        if params["name"]!="__codexPanelHostV1"{continue;}
                        let (cdp,environment,client,operations,policies)=(cdp.clone(),environment.clone(),client.clone(),operations.clone(),policies.clone());
                        requests.spawn(async move {
                            let id=request["id"].clone();
                            let outcome=if request["action"]=="start-task-conversation" {
                                // 同一任务共享进行中的创建结果；不确定失败保留两分钟，避免 UI 重试生成第二个会话。
                                let key=request["taskId"].as_str().unwrap_or("").to_owned();
                                let(future,token)={
                                    let mut entries=operations.lock().await;
                                    entries.retain(|_,operation|operation.started.elapsed()<Duration::from_secs(120));
                                    let operation=entries.entry(key.clone()).or_insert_with(||{
                                        let cdp=cdp.clone();let environment=environment.clone();let client=client.clone();
                                        ConversationOperation{started:Instant::now(),token:uuid::Uuid::new_v4(),future:async move{bridge::handle(&cdp,context,&environment,&client,request,&policies).await}.boxed().shared()}
                                    });
                                    (operation.future.clone(),operation.token)
                                };
                                let result=future.await;
                                if !result.as_ref().err().is_some_and(|error|error.details.as_ref().is_some_and(|details|details["uncertain"]==true||details["threadId"].is_string())){
                                    let mut entries=operations.lock().await;
                                    if entries.get(&key).is_some_and(|operation|operation.token==token){entries.remove(&key);}
                                }
                                result
                            }else{bridge::handle(&cdp,context,&environment,&client,request,&policies).await};
                            let response=match outcome {
                                Ok(mut value)=>{if !value.is_object(){value=json!({"result":value});}value["id"]=id;value["ok"]=json!(true);value},
                                Err(error)=>{let mut response=json!({"id":id,"ok":false,"error":error.message});if let Some(details)=error.details{for key in ["threadId","uncertain"]{if let Some(value)=details.get(key){response[key]=value.clone();}}}response},
                            };
                            if let Err(error)=bridge::response(&cdp,context,&environment,response).await{eprintln!("Panel host response: {error}");}
                        });
                    },
                    Some("Inspector.detached")=>break,
                    _=>{},
                }
            }
        }
    }
}

async fn attach(
    connection: cdp::Connection,
    source: &str,
    hash: &str,
    open: bool,
    environment: &Environment,
    options: &Options,
    client: &reqwest::Client,
    policies: Arc<crate::automation::PolicyManager>,
) -> Result<Target, ApiError> {
    wait_renderer(&connection).await?;
    let previous = bridge::status(&connection).await?;
    let registration = connection
        .send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source":format!("{source}\n//# sourceURL=codex-panel.user.js")}),
        )
        .await?;
    let context = bridge::install(&connection, environment).await?;
    let events = AbortTask(tokio::spawn(bridge_events(
        connection.clone(),
        context,
        environment.clone(),
        client.clone(),
        options.startup_token.clone(),
        policies,
    )));
    if let Some(identifier) = previous["scriptIdentifier"].as_str() {
        let _ = connection
            .send(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
            )
            .await;
    }
    connection.evaluate(source, None).await?;
    connection
        .evaluate(
            &format!(
                "window.__CODEX_PANEL_SCRIPT_IDENTIFIER__={}",
                registration["identifier"]
            ),
            None,
        )
        .await?;
    bridge::heartbeat(
        &connection,
        context,
        environment,
        options.startup_token.as_deref(),
    )
    .await?;
    let should_open = open || previous["pageVisible"] == true;
    if should_open {
        request_panel_open(&connection, Duration::from_secs(15)).await?;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let status = bridge::status(&connection).await?;
        if bridge::ready(&status, hash, options.startup_token.as_deref())
            && (!should_open || status["pageVisible"] == true && status["frameReady"] == true)
        {
            if let Some(path) = &options.screenshot {
                let screenshot = connection
                    .send("Page.captureScreenshot", json!({"format":"png"}))
                    .await?;
                let data = base64::engine::general_purpose::STANDARD
                    .decode(screenshot["data"].as_str().unwrap_or(""))
                    .map_err(|e| ApiError::new(502, "SCREENSHOT", e.to_string()))?;
                tokio::fs::write(path, data).await?;
            }
            let retry = Arc::new(tokio::sync::Notify::new());
            let applying = Arc::new(AtomicBool::new(false));
            let adapting = Arc::new(AtomicBool::new(true));
            let patches = Some(tokio::spawn(native_adapters(
                connection.clone(),
                source.to_owned(),
                environment.clone(),
                options.clone(),
                retry.clone(),
                applying.clone(),
                adapting.clone(),
            )));
            return Ok(Target {
                connection,
                _events: events,
                patches,
                retry,
                applying,
                adapting,
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(ApiError::new(
        504,
        "PANEL_INJECTION",
        "Codex 中的任务面板尚未就绪，请稍后重试。",
    ))
}

struct AbortTask(JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Avatar {
    connection: cdp::Connection,
    _events: AbortTask,
    _patches: AbortTask,
}

async fn attach_avatar(
    connection: cdp::Connection,
    hash: &str,
    environment: &Environment,
    options: &Options,
) -> Result<Avatar, ApiError> {
    connection.send("Page.enable", json!({})).await?;
    connection.send("Runtime.enable", json!({})).await?;
    wait_renderer(&connection).await?;
    let previous=connection.evaluate("({hash:globalThis.__codexPanelPetAnimationsInjectionHash__,script:globalThis.__codexPanelPetAnimationsScriptIdentifier__,prepared:Boolean(globalThis.__codexPanelRspack__&&globalThis.__codexPanelPetAnimations__)})",None).await?;
    let prepared = adapters::prepare_pets(&connection, &options.app_path, environment)
        .await?
        .ok_or_else(|| ApiError::new(422, "PET_ADAPTER", "此 Codex 版本的宠物窗口尚无兼容适配"))?;
    let patches = AbortTask(prepared.handler);
    if !prepared.status["features"]
        .as_array()
        .is_some_and(|features| {
            features
                .iter()
                .any(|feature| feature["id"] == "pets" && feature["phase"] == "prepared")
        })
    {
        return Err(ApiError::new(422, "PET_ADAPTER", "原生宠物模块未完成识别"));
    }
    let source = format!(
        "{}\nglobalThis.__codexPanelPetAnimationsInjectionHash__={};",
        prepared.source,
        json!(hash)
    );
    if let Some(identifier) = previous["script"].as_str() {
        let _ = connection
            .send(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
            )
            .await;
    }
    connection
        .send("Page.setBypassCSP", json!({"enabled":true}))
        .await?;
    let registration = connection
        .send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source":source}),
        )
        .await?;
    connection
        .send(
            "Runtime.addBinding",
            json!({"name":"__codexPanelPlayPetAudioV1"}),
        )
        .await?;
    if previous["prepared"] != true || previous["hash"] != hash {
        reload_renderer(&connection).await?;
    }
    connection.evaluate(&source, None).await?;
    let publish = format!(
        "globalThis.__codexPanelPetAnimationsScriptIdentifier__={}",
        registration["identifier"]
    );
    connection.evaluate(&publish, None).await?;
    let mut events = connection.events();
    let active = connection.clone();
    let events = AbortTask(tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if !active.owns_event(&event) {
                continue;
            }
            match event["method"].as_str() {
                Some("Page.loadEventFired") => {
                    let _ = active.evaluate(&publish, None).await;
                }
                Some("Runtime.bindingCalled")
                    if event["params"]["name"] == "__codexPanelPlayPetAudioV1" =>
                {
                    if let (Some(id), Some(context)) = (
                        event["params"]["payload"]
                            .as_str()
                            .and_then(|value| value.parse::<u64>().ok())
                            .filter(|id| *id > 0 && *id <= 9_999_999_999),
                        event["params"]["executionContextId"].as_i64(),
                    ) {
                        let _=active.send("Runtime.evaluate",json!({"expression":format!("globalThis.__codexPanelPetAnimations__?.playAudio({id})"),"contextId":context,"userGesture":true,"awaitPromise":true,"returnByValue":true})).await;
                    }
                }
                Some("Inspector.detached") => break,
                _ => {}
            }
        }
    }));
    Ok(Avatar {
        connection,
        _events: events,
        _patches: patches,
    })
}

async fn sync_avatars(
    avatars: &mut BTreeMap<String, Avatar>,
    browser: Option<&cdp::Connection>,
    client: &reqwest::Client,
    environment: &Environment,
    options: &Options,
    hash: &str,
) -> Result<bool, ApiError> {
    let available = if let Some(browser) = browser {
        browser.send("Target.getTargets", json!({})).await?["targetInfos"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|target| cdp::is_avatar_target(target))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        processes::avatar_targets(client, options.port).await?
    };
    let ids = available
        .iter()
        .filter_map(|target| {
            target
                .get("id")
                .or_else(|| target.get("targetId"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    let obsolete = avatars
        .iter()
        .filter(|(id, avatar)| !ids.contains(&id.as_str()) || avatar.connection.is_closed())
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in obsolete {
        if let Some(avatar) = avatars.remove(&id) {
            if browser.is_some() {
                avatar.connection.detach().await;
            } else {
                avatar.connection.close();
            }
        }
    }
    let mut changed = false;
    for target in available {
        let id = target
            .get("id")
            .or_else(|| target.get("targetId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if avatars.contains_key(&id) {
            continue;
        }
        let connection = if let Some(browser) = browser {
            browser.attach(&id).await?
        } else {
            cdp::Connection::websocket(
                target["webSocketDebuggerUrl"].as_str().unwrap_or(""),
                options.port,
            )
            .await?
        };
        match attach_avatar(connection.clone(), hash, environment, options).await {
            Ok(avatar) => {
                avatars.insert(id, avatar);
                changed = true;
            }
            Err(error) => {
                if browser.is_some() {
                    connection.detach().await;
                } else {
                    connection.close();
                }
                return Err(error);
            }
        }
    }
    Ok(changed)
}

struct SharedGateway {
    gateway: Arc<crate::shared_session::Gateway>,
    _notifications: AbortTask,
}

async fn primary_connection(
    primary: &Arc<tokio::sync::Mutex<Option<cdp::Connection>>>,
) -> Result<cdp::Connection, ApiError> {
    primary
        .lock()
        .await
        .clone()
        .filter(|connection| !connection.is_closed())
        .ok_or_else(|| ApiError::new(409, "CODEX_NOT_READY", "共享会话正在等待 Codex 主窗口"))
}

async fn sync_shared_session(
    current: &mut Option<SharedGateway>,
    environment: &Environment,
    cli: Option<&Path>,
    primary: &Arc<tokio::sync::Mutex<Option<cdp::Connection>>>,
) -> Result<(), ApiError> {
    let enabled = crate::shared_session::read_enabled(
        environment.preferences_file.as_deref(),
        config::setting("SHARED_SESSION_BACKEND").as_deref() == Some("1"),
    )
    .await?;
    if !enabled {
        if let Some(shared) = current.take() {
            shared.gateway.close().await?;
        }
        return Ok(());
    }
    if current.is_some() {
        return Ok(());
    }
    let cli = cli.ok_or_else(|| {
        ApiError::new(409, "SHARED_SESSION_CLI", "找不到共享会话所需的 Codex CLI")
    })?;
    let request_primary = primary.clone();
    let initialize_primary = primary.clone();
    let retain_primary = primary.clone();
    let retained = Arc::new(tokio::sync::Mutex::new(
        BTreeMap::<String, cdp::Connection>::new(),
    ));
    let callbacks = crate::shared_session::Callbacks {
        request: Arc::new(move |method, params| {
            let primary = request_primary.clone();
            Box::pin(async move {
                bridge::rpc(
                    &primary_connection(&primary).await?,
                    "local",
                    &method,
                    params,
                    30000,
                )
                .await
            })
        }),
        initialize: Arc::new(move || {
            let primary = initialize_primary.clone();
            Box::pin(async move {
                primary_connection(&primary)
                    .await?
                    .evaluate(
                        &crate::shared_session::initialization_expression(include_str!(
                            "injector/assets/find_require.js"
                        )),
                        None,
                    )
                    .await
            })
        }),
        retain: Arc::new(move |thread, retain| {
            let primary = retain_primary.clone();
            let retained = retained.clone();
            Box::pin(async move {
                // 释放必须回到最初保留会话的窗口，不能误作用于后来打开的主窗口。
                let connection = if retain {
                    Some(primary_connection(&primary).await?)
                } else {
                    retained.lock().await.remove(&thread)
                };
                let Some(connection) = connection.filter(|connection| !connection.is_closed())
                else {
                    return Ok(Value::Null);
                };
                let value = connection
                    .evaluate(
                        &crate::shared_session::retention_expression(
                            include_str!("injector/assets/find_require.js"),
                            &thread,
                            retain,
                        ),
                        None,
                    )
                    .await?;
                if retain {
                    retained.lock().await.insert(thread, connection);
                }
                Ok(value)
            })
        }),
    };
    let gateway = Arc::new(
        crate::shared_session::Gateway::start(&environment.data_dir, cli, callbacks).await?,
    );
    let mut notifications = subscribe_notifications();
    let forwarding = gateway.clone();
    let notifications = AbortTask(tokio::spawn(async move {
        loop {
            match notifications.recv().await {
                Ok(value) if value["hostId"] == "local" => forwarding.publish(value).await,
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    }));
    *current = Some(SharedGateway {
        gateway,
        _notifications: notifications,
    });
    Ok(())
}

async fn reload_renderer(connection: &cdp::Connection) -> Result<(), ApiError> {
    let mut events = connection.events();
    connection
        .send("Page.reload", json!({"ignoreCache":true}))
        .await?;
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Ok(event) = events.recv().await {
            if connection.owns_event(&event) && event["method"] == "Page.loadEventFired" {
                return Ok(());
            }
        }
        Err(ApiError::new(
            502,
            "CDP_RELOAD",
            "Codex connection closed during reload",
        ))
    })
    .await
    .map_err(|_| ApiError::new(504, "CDP_RELOAD", "Timed out waiting for the Codex reload"))??;
    wait_renderer(connection).await
}

fn adapter_label(feature: &str) -> &str {
    match feature {
        "quota" => "账号额度限制",
        "ultrafast" => "Ultrafast",
        "dot" => "Dot 入口",
        "tabs" => "会话菜单",
        "queue" => "排队消息",
        "pets" => "宠物动画",
        "projectlessChat" => "无项目聊天",
        "repositoryBranchPrefix" => "仓库分支前缀",
        "settingsPresentation" => "设置界面",
        "terminal" => "底部终端",
        "nativeUpdate" => "Codex 更新",
        "nativeServices" => "原生服务",
        _ => feature,
    }
}

fn publish_adapter_progress(
    phase: &str,
    message: &str,
    features: &BTreeMap<String, Value>,
    progress: Option<f64>,
) {
    emit(
        "nativeAdaptersStatus",
        json!({"phase":phase,"message":message,"features":features.values().collect::<Vec<_>>(),"progress":progress}),
    );
}

async fn apply_native_descriptors(
    connection: &cdp::Connection,
    plan: &Value,
) -> Result<Vec<String>, ApiError> {
    if !["nativeUpdate", "nativeServices"].iter().any(|key| {
        plan[*key]
            .as_object()
            .is_some_and(|values| values.values().any(Value::is_object))
    }) {
        return Ok(Vec::new());
    }
    let descriptors = json!({"chunks":plan["chunks"],"nativeUpdate":plan["nativeUpdate"],"nativeServices":plan["nativeServices"]});
    let expression = format!(
        r#"(async()=>{{
        const load=await ({})();if(!load)return [];
        const descriptors={descriptors};let runtime=globalThis.__codexPanelRspack__;
        if(!runtime?.mergeDescriptors)runtime=globalThis.__codexPanelRspack__=({})({{patches:{{}},prepared:{{}},chunks:{{}},nativeUpdate:{{...runtime?.nativeUpdate}},nativeServices:{{...runtime?.nativeServices}}}});
        runtime.mergeDescriptors(descriptors,load);
        return ["nativeUpdate","nativeServices"].filter(key=>Object.values(descriptors[key]??{{}}).some(Boolean));
    }})()"#,
        include_str!("injector/assets/find_require.js"),
        include_str!("injector/assets/rspack_runtime.js")
    );
    Ok(connection
        .evaluate(&expression, None)
        .await?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}

fn consume_adapter_progress<'a>(
    connection: &'a cdp::Connection,
    event: Value,
    features: &mut BTreeMap<String, Value>,
    applications: &mut FuturesUnordered<BoxFuture<'a, (String, Result<Vec<String>, ApiError>)>>,
) {
    let phase = event["phase"].as_str().unwrap_or("");
    let feature = event["feature"].as_str().unwrap_or("");
    if phase == "feature" {
        let prepared = if matches!(feature, "nativeUpdate" | "nativeServices") {
            event["plan"][feature]
                .as_object()
                .is_some_and(|values| values.values().any(Value::is_object))
        } else {
            event["plan"]["prepared"][feature] == true
        };
        features.insert(feature.into(), json!({"feature":feature,"phase":if prepared{"prepared"}else{"failed"},"message":if prepared{"已适配，等待统一应用"}else{event["plan"]["errors"][feature].as_str().unwrap_or("未找到兼容的原生模块")}}));
        if prepared && matches!(feature, "nativeUpdate" | "nativeServices") {
            let plan = event["plan"].clone();
            let name = feature.to_owned();
            applications.push(async move { (name, apply_native_descriptors(connection, &plan).await) }.boxed());
            features.insert(feature.into(), json!({"feature":feature,"phase":"applying","message":"正在启用，其他模块继续适配"}));
        }
        publish_adapter_progress(
            "adapting",
            "已完成的模块已准备，其余模块继续适配。",
            features,
            event["percent"].as_f64(),
        );
        return;
    }
    let completed = event["completed"].as_u64();
    let total = event["total"].as_u64();
    let count = match (completed, total) {
        (Some(done), Some(total)) => format!("（{done}/{total}）"),
        _ => String::new(),
    };
    let module = event["moduleId"]
        .as_str()
        .map(|module| format!(" · 模块 {module}"))
        .unwrap_or_default();
    if !feature.is_empty() && phase == "adapt" {
        let message = format!("正在识别{}{count}{module}", adapter_label(feature));
        features.insert(
            feature.into(),
            json!({"feature":feature,"phase":"loading","message":message}),
        );
    }
    let message = match phase {
        "cache" => "正在检查此版本的适配缓存…".into(),
        "read" => format!(
            "正在读取 Codex 资源{count}{}",
            event["asset"]
                .as_str()
                .map(|name| format!(" · {name}"))
                .unwrap_or_default()
        ),
        "adapt" => "正在并发适配原生模块；Panel 已连接。".into(),
        "compose" => format!("正在合并已完成的模块{count}{module}"),
        "write" => "正在保存此版本的适配缓存…".into(),
        "prepared" => "适配已准备，正在应用…".into(),
        _ => "正在适配原生模块…".into(),
    };
    let progress = event["percent"]
        .as_f64()
        .or_else(|| match (completed, total) {
            (Some(done), Some(total)) if total > 0 => Some(done as f64 / total as f64 * 100.),
            _ => None,
        });
    publish_adapter_progress(
        if matches!(phase, "cache" | "read") {
            "reading"
        } else {
            "adapting"
        },
        &message,
        features,
        progress,
    );
}

fn complete_adapter_application(
    (feature, result): (String, Result<Vec<String>, ApiError>),
    features: &mut BTreeMap<String, Value>,
) {
    features.insert(feature.clone(), json!({"feature":feature,"phase":"prepared","message":"已适配，等待统一应用"}));
    match result {
        Ok(applied) => {
            for name in applied {
                features.insert(name.clone(), json!({"feature":name,"phase":"ready","message":"已启用"}));
            }
            publish_adapter_progress("adapting", "已完成的原生服务已启用，其余模块继续适配。", features, None);
        }
        Err(error) => eprintln!("Panel live native services: {}", error.message),
    }
}

async fn native_adapters(
    connection: cdp::Connection,
    base: String,
    environment: Environment,
    options: Options,
    retry: Arc<tokio::sync::Notify>,
    applying: Arc<AtomicBool>,
    adapting: Arc<AtomicBool>,
) {
    let mut handler: Option<AbortTask> = None;
    retry.notified().await;
    loop {
        let mut awaiting_tabs = false;
        adapting.store(true, Ordering::SeqCst);
        let mut features = BTreeMap::new();
        publish_adapter_progress(
            "reading",
            "Panel 已连接，正在后台准备原生模块…",
            &features,
            None,
        );
        let result = async {
            let previous = bridge::status(&connection).await?;
            let (send, mut receive) = mpsc::unbounded_channel();
            let progress: adapters::ProgressCallback = Arc::new(move |event| { let _ = send.send(event); });
            let preparation = adapters::prepare_with_progress(&connection, &options.app_path, &environment, progress);
            tokio::pin!(preparation);
            let mut applications = FuturesUnordered::new();
            let prepared = loop {
                tokio::select! {
                    result = &mut preparation => {
                        while let Ok(event) = receive.try_recv() { consume_adapter_progress(&connection, event, &mut features, &mut applications); }
                        break result?;
                    }
                    Some(event) = receive.recv() => consume_adapter_progress(&connection, event, &mut features, &mut applications),
                    Some(result) = applications.next(), if !applications.is_empty() => complete_adapter_application(result, &mut features),
                }
            };
            while let Some(result) = applications.next().await { complete_adapter_application(result, &mut features); }
            let prepared = match prepared { Some(prepared) => prepared, None => legacy::prepare(&connection, &options.app_path, &environment).await? };
            for feature in prepared.status["features"].as_array().into_iter().flatten() {
                let name = feature["feature"].as_str().or_else(|| feature["id"].as_str()).unwrap_or("");
                if features.get(name).is_none_or(|status| status["phase"] != "ready") { features.insert(name.into(), feature.clone()); }
            }
            handler = Some(AbortTask(prepared.handler));
            let source = format!("{}\n{base}", prepared.source);
            let registration = connection.send("Page.addScriptToEvaluateOnNewDocument", json!({"source":format!("{source}\n//# sourceURL=codex-panel.user.js")})).await?;
            if let Some(identifier) = previous["scriptIdentifier"].as_str() {
                let _ = connection.send("Page.removeScriptToEvaluateOnNewDocument", json!({"identifier":identifier})).await;
            }
            if previous["nativeAdaptersRevision"] != prepared.revision || previous["nativeAdaptersEntryWrapped"] == false {
                applying.store(true, Ordering::SeqCst);
                publish_adapter_progress("applying", "正在统一应用适配，刷新 Codex 界面一次…", &features, None);
                reload_renderer(&connection).await?;
            }
            connection.evaluate(&source, None).await?;
            connection.evaluate(&format!("window.__CODEX_PANEL_SCRIPT_IDENTIFIER__={}", registration["identifier"]), None).await?;
            if previous["pageVisible"] == true { request_panel_open(&connection, Duration::from_secs(15)).await?; }
            for feature in features.values_mut() {
                if feature["phase"] == "prepared" { feature["phase"] = json!("ready"); feature["message"] = json!("已启用"); }
            }
            let partial = features.values().any(|feature| feature["phase"] == "failed");
            publish_adapter_progress(if partial { "partial" } else { "ready" }, if partial { "已启用适配成功的模块；部分模块适配失败。" } else { "原生模块已全部启用，适配缓存已就绪。" }, &features, None);
            let tabs_prepared = features.get("tabs").is_some_and(|feature| feature["phase"] == "ready");
            let deadline = Instant::now() + Duration::from_secs(15);
            let tabs = if tabs_prepared {
                loop {
                    if bridge::status(&connection).await?["threadTabsReady"] == true { break true; }
                    if Instant::now() >= deadline || connection.is_closed() { break false; }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } else { false };
            awaiting_tabs = tabs_prepared && !tabs;
            emit("threadTabsStatus", json!({"phase":if tabs {"ready"} else {"failed"},"message":if tabs {"标签页和分栏菜单已加载"} else if tabs_prepared {"原生会话菜单或侧栏未生效，请重试加载"} else {"原生会话菜单尚未准备成功"}}));
            Ok::<_, ApiError>(())
        }.await;
        applying.store(false, Ordering::SeqCst);
        adapting.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            publish_adapter_progress("failed", &error.message, &features, None);
        }
        tokio::select! { _ = retry.notified() => {}, _ = async {
            while !connection.is_closed() {
                tokio::time::sleep(Duration::from_secs(1)).await;
                // 侧栏可能延迟挂载；失败后仍回读真实状态，恢复时同步更新启动器。
                if awaiting_tabs && bridge::status(&connection).await.is_ok_and(|status| status["threadTabsReady"] == true) {
                    emit("threadTabsStatus", json!({"phase":"ready","message":"标签页和分栏菜单已加载"}));
                    awaiting_tabs = false;
                }
            }
        } => break }
    }
    drop(handler);
}

async fn managed_status(
    targets: &BTreeMap<String, Target>,
    hash: &str,
    startup: Option<&str>,
) -> Result<Value, ApiError> {
    let applying = targets.values().any(|target| !target.connection.is_closed() && target.applying.load(Ordering::SeqCst));
    for (id, target) in targets {
        if target.connection.is_closed() {
            continue;
        }
        if let Ok(status) = bridge::status(&target.connection).await {
            if bridge::ready(&status, hash, startup) {
                return Ok(json!({"ready":true,"pageVisible":status["pageVisible"]==true,"threadTabsReady":status["threadTabsReady"]==true,"status":status,"targetId":id,"applyingNativeAdapters":applying}));
            }
        }
    }
    Ok(json!({"ready":false,"pageVisible":false,"applyingNativeAdapters":applying}))
}

async fn open_panel(
    targets: &BTreeMap<String, Target>,
    hash: &str,
    startup: Option<&str>,
) -> Result<Value, ApiError> {
    for (id, target) in targets {
        let status = bridge::status(&target.connection).await?;
        if !bridge::ready(&status, hash, startup) {
            continue;
        }
        request_panel_open(&target.connection, Duration::from_secs(2)).await?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let status = bridge::status(&target.connection).await?;
            if bridge::ready(&status, hash, startup) && status["pageVisible"] == true {
                emit("panelOpened", json!({"openPanelSignalOpened":true}));
                return Ok(json!({"ready":true,"opened":true,"targetId":id,"status":status}));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    Err(ApiError::new(
        409,
        "PANEL_NOT_READY",
        "Managed Panel renderer is not ready to open",
    ))
}

async fn request_panel_open(
    connection: &cdp::Connection,
    timeout: Duration,
) -> Result<(), ApiError> {
    let deadline = Instant::now() + timeout;
    loop {
        match connection
            .evaluate("window.__codexPanelInjection__?.open()", None)
            .await
        {
            Ok(_) => return Ok(()),
            // DOM 加载完成不代表 React 路由已挂载；保留同一个连接，等原生导航就绪再打开。
            Err(error)
                if error.code == "CODEX_EVALUATION_FAILED"
                    && error.message.contains("无法连接 Codex 原生导航")
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

struct UpdateCheck {
    started: Option<Instant>,
    result: Option<Value>,
    working: bool,
}

async fn control_action(
    request: &Value,
    targets: &BTreeMap<String, Target>,
    hash: &str,
    startup: Option<&str>,
    updates: &Arc<crate::codex_update::UpdateManager>,
    checks: &Arc<tokio::sync::Mutex<UpdateCheck>>,
) -> Result<Value, ApiError> {
    match request["action"].as_str().unwrap_or("") {
        "status" => {
            let mut result = managed_status(targets, hash, startup).await?;
            if let Ok(update) = update_action(
                &json!({"action":"codex-update-status"}),
                targets,
                updates,
                checks,
            )
            .await
            {
                for (key, value) in update
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, _)| key.starts_with("codexUpdate"))
                {
                    result[key] = value.clone();
                    if result["status"].is_object() {
                        result["status"][key] = value.clone();
                    }
                }
            }
            Ok(result)
        }
        "open" => open_panel(targets, hash, startup).await,
        "app-server" => {
            let target = targets
                .values()
                .find(|target| !target.connection.is_closed())
                .ok_or_else(|| {
                    ApiError::new(
                        409,
                        "CODEX_NOT_READY",
                        "Panel renderer injection is waiting for Codex",
                    )
                })?;
            bridge::rpc(
                &target.connection,
                request["hostId"].as_str().unwrap_or("local"),
                request["method"].as_str().unwrap_or(""),
                request.get("params").cloned().unwrap_or(json!({})),
                request["timeoutMs"].as_u64().unwrap_or(30000).min(120000),
            )
            .await
        }
        "interrupt-thread" => {
            let target = targets
                .values()
                .find(|target| !target.connection.is_closed())
                .ok_or_else(|| {
                    ApiError::new(
                        409,
                        "CODEX_NOT_READY",
                        "Panel renderer injection is waiting for Codex",
                    )
                })?;
            let host = request["codexHostId"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or_else(|| ApiError::new(400, "THREAD_BINDING", "Invalid native host"))?;
            let id = request["threadId"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or_else(|| ApiError::new(400, "THREAD_BINDING", "Invalid native thread"))?;
            let response = bridge::rpc(
                &target.connection,
                host,
                "thread/read",
                json!({"threadId":id,"includeTurns":true}),
                10000,
            )
            .await?;
            let turn = response["thread"]["turns"].as_array().and_then(|turns| {
                turns
                    .iter()
                    .rev()
                    .find(|turn| turn["status"] == "inProgress")
            });
            if let Some(turn) = turn.filter(|turn| turn["id"].is_string()) {
                bridge::rpc(
                    &target.connection,
                    host,
                    "turn/interrupt",
                    json!({"threadId":id,"turnId":turn["id"]}),
                    10000,
                )
                .await?;
                Ok(json!({"interrupted":true,"turnId":turn["id"]}))
            } else {
                Ok(json!({"interrupted":false}))
            }
        }
        "codex-update-status"
        | "check-codex-updates"
        | "download-codex-update"
        | "pause-codex-update"
        | "resume-codex-update"
        | "cancel-codex-update" => update_action(request, targets, updates, checks).await,
        "pet-selection" | "use-lumi" | "cancel-lumi" | "use-pet" | "cancel-pet" => {
            let target = targets
                .values()
                .find(|target| !target.connection.is_closed())
                .ok_or_else(|| {
                    ApiError::new(409, "CODEX_NOT_READY", "请先通过 Panel 连接 Codex")
                })?;
            let environment = Environment::read()?;
            let packs = crate::pets::read(&environment.data_dir, &environment.app_root).await?;
            let action = request["action"].as_str().unwrap();
            let pet = request["petId"].as_str();
            if matches!(action, "use-pet" | "cancel-pet")
                && !packs
                    .as_array()
                    .is_some_and(|packs| packs.iter().any(|pack| pack["petId"].as_str() == pet))
            {
                return Err(ApiError::new(
                    404,
                    "PET_NOT_FOUND",
                    "该宠物尚未导入，请刷新宠物列表",
                ));
            }
            let lumi = packs
                .as_array()
                .into_iter()
                .flatten()
                .filter(|pack| pack["builtinLumi"] == true)
                .map(|pack| pack["petId"].clone())
                .collect::<Vec<_>>();
            target
                .connection
                .evaluate(
                    &format!("globalThis.__codexPanelPetAnimations__?.setPacks({packs})"),
                    None,
                )
                .await?;
            let expression = format!(
                "(async()=>({})(await ({})(),{},{},{}))()",
                include_str!("injector/assets/pet_selection.js"),
                include_str!("injector/assets/find_require.js"),
                json!(action),
                json!(lumi),
                json!(pet)
            );
            let value = target.connection.evaluate(&expression, None).await?;
            if !value["petId"].is_null() && !value["petId"].is_string() {
                return Err(ApiError::new(
                    502,
                    "PET_SELECTION",
                    "Codex 未返回有效的宠物选择",
                ));
            }
            Ok(value)
        }
        "retry-thread-tabs" => {
            if targets.is_empty() {
                return Err(ApiError::new(
                    409,
                    "CODEX_NOT_READY",
                    "请先通过 Panel 连接 Codex",
                ));
            }
            for target in targets.values() {
                target.retry.notify_one();
            }
            Ok(json!({"retrying":true}))
        }
        _ => Err(ApiError::new(
            400,
            "CONTROL_ACTION",
            "Unsupported Panel control action",
        )),
    }
}

async fn update_action(
    request: &Value,
    targets: &BTreeMap<String, Target>,
    updates: &Arc<crate::codex_update::UpdateManager>,
    checks: &Arc<tokio::sync::Mutex<UpdateCheck>>,
) -> Result<Value, ApiError> {
    if !cfg!(target_os = "macos") {
        return Err(ApiError::new(
            400,
            "UPDATE_PLATFORM",
            "直接下载 Codex 更新目前仅支持 macOS",
        ));
    }
    let action = request["action"].as_str().unwrap_or("");
    let direct =
        match action {
            "pause-codex-update" => Some(updates.pause().await.ok_or_else(|| {
                ApiError::new(409, "UPDATE_STATE", "当前没有可暂停的 Codex 下载")
            })?),
            "resume-codex-update" => Some(updates.resume().await.ok_or_else(|| {
                ApiError::new(409, "UPDATE_STATE", "当前没有可继续的 Codex 下载")
            })?),
            "cancel-codex-update" => Some(updates.cancel().await?.ok_or_else(|| {
                ApiError::new(409, "UPDATE_STATE", "当前没有可取消的 Codex 下载")
            })?),
            _ => None,
        };
    let status = if let Some(status) = direct {
        status
    } else {
        let target = targets
            .values()
            .find(|target| !target.connection.is_closed())
            .ok_or_else(|| ApiError::new(409, "CODEX_NOT_READY", "请先通过 Panel 连接 Codex"))?;
        if action == "download-codex-update" {
            let native = update_bindings::native_state(&target.connection).await?;
            updates
                .begin(request["targetBuild"].as_str(), &native)
                .await?
        } else if action == "codex-update-status" && updates.current().await.is_some() {
            updates.current().await.unwrap()
        } else {
            let native = update_bindings::native_state(&target.connection)
                .await
                .unwrap_or(json!({"ready":false,"downloading":false,"progress":null}));
            let mut state = checks.lock().await;
            let expired = state
                .started
                .is_none_or(|started| started.elapsed() >= Duration::from_secs(15 * 60));
            let force = action == "check-codex-updates";
            if !state.working && (expired || force) {
                state.started = Some(Instant::now());
                state.result = None;
                state.working = true;
                let connection = target.connection.clone();
                let updates = updates.clone();
                let checks = checks.clone();
                tokio::spawn(async move {
                    let result=async{
                        let mut channel=update_bindings::read(&connection,"channel").await?;
                        if !channel["beta"].is_boolean(){return Err(ApiError::new(409,"UPDATE_CHANNEL","无法读取 Codex 更新频道"));}
                        let account=bridge::rpc(&connection,"local","account/read",json!({"refreshToken":false}),3000).await?;
                        channel["planType"]=account["account"].get("planType").cloned().unwrap_or(json!("unknown"));
                        let result=updates.check(channel).await?;
                        // 轮询缓存不复制私密清单，下载器独占保存本次校验过的 feed。
                        Ok::<_,ApiError>(json!({"status":result["status"],"installedVersion":result["installedVersion"],"versions":result["versions"]}))
                    }.await;
                    let mut state = checks.lock().await;
                    state.working = false;
                    state.result = Some(match result {
                        Ok(value) => value,
                        Err(error) => json!({"status":"error","error":error.message}),
                    });
                });
            }
            let result = state.result.clone().unwrap_or(Value::Null);
            drop(state);
            let message = if native["ready"] == true {
                "更新已下载，可安装并重新连接".to_owned()
            } else if native["downloading"] == true {
                "Codex 正在下载更新".to_owned()
            } else if result.is_null() {
                "正在检查更新…".into()
            } else {
                match result["status"].as_str() {
                    Some("available") => format!(
                        "当前版本 {}",
                        result["installedVersion"].as_str().unwrap_or("")
                    ),
                    Some("up_to_date") => "当前已是最新版".into(),
                    Some("no_delta") => "有新版本，官方未提供适用于当前构建的增量包".into(),
                    _ => format!(
                        "暂时无法检查更新{}",
                        result["error"]
                            .as_str()
                            .map(|value| format!("：{value}"))
                            .unwrap_or_default()
                    ),
                }
            };
            // 官方清单仅供管理器保留；前端只得到版本和显示状态。
            json!({"ready":native["ready"],"available":result["status"]=="available","downloading":native["downloading"],"checking":result.is_null()&&native["ready"]!=true&&native["downloading"]!=true,"message":message,"versions":if native["ready"]==true||native["downloading"]==true{json!([])}else{result["versions"].clone()}})
        }
    };
    let mut response = json!({"ready":true,"codexUpdateReady":status["ready"],"codexUpdateAvailable":status["available"],"codexUpdateDownloading":status["downloading"],"codexUpdatePhase":status.get("phase").cloned().unwrap_or(json!("")),"codexUpdateMessage":status["message"],"codexUpdateChecking":status.get("checking").cloned().unwrap_or(json!(false)),"codexUpdateVersions":status["versions"].as_array().cloned().unwrap_or_default()});
    if action == "codex-update-status" {
        let native = match targets
            .values()
            .find(|target| !target.connection.is_closed())
        {
            Some(target) => update_bindings::native_state(&target.connection)
                .await
                .unwrap_or(json!({"ready":false,"downloading":false})),
            None => json!({"ready":false,"downloading":false}),
        };
        // Launcher 用 ready 决定是否允许安装；RPC 成功不能代表更新包已经准备好。
        response["ready"] = json!(status["ready"] == true || native["ready"] == true);
        response["codexUpdateNativeReady"] = json!(native["ready"] == true);
        response["codexUpdateNativeDownloading"] = json!(native["downloading"] == true);
        response["codexUpdateStagedBuild"] = status["stagedBuild"].clone();
    }
    Ok(response)
}

async fn start_server(environment: &Environment, cli: Option<&Path>) -> Result<Child, ApiError> {
    let executable = std::env::current_exe()?;
    let mut command = tokio::process::Command::new(executable);
    command
        .arg("serve")
        .env("CODEX_PANEL_APP_ROOT", &environment.app_root)
        .env("CODEX_PANEL_DATA_DIR", &environment.data_dir)
        .env("CODEX_PANEL_PORT", environment.panel_port.to_string())
        .env("CODEX_PANEL_VERSION", &environment.version)
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    if let Some(token) = &environment.token {
        command.env("CODEX_PANEL_INSTANCE_TOKEN", token);
    }
    if let Some(secret) = &environment.secret {
        command.env("CODEX_PANEL_INSTANCE_SECRET", secret);
    }
    if let Some(cli) = cli {
        command.env("CODEX_EXECUTABLE", cli);
    }
    Ok(command.spawn()?)
}

async fn launch_codex(
    options: &Options,
    environment: &Environment,
) -> Result<(processes::ManagedProcess, Option<cdp::Connection>), ApiError> {
    let executable = processes::executable(options).await?;
    if options.pipe {
        let (child, connection) = processes::launch_pipe(&executable, environment).await?;
        Ok((processes::ManagedProcess::Child(child), Some(connection)))
    } else {
        Ok((
            processes::launch_tcp(&executable, options, environment).await?,
            None,
        ))
    }
}

pub async fn run(args: &[String]) -> Result<(), ApiError> {
    let mut options = Options::parse(args)?;
    let environment = Environment::read()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()?;
    if options.control.is_some() || options.stop_managed || options.stop_residents {
        let path = environment.runtime_file.as_deref().ok_or_else(|| {
            ApiError::new(
                400,
                "RUNTIME_FILE",
                "Managed control requires CODEX_PANEL_RUNTIME_FILE",
            )
        })?;
        let action = if options.stop_managed || options.stop_residents {
            "shutdown"
        } else {
            options.control.as_deref().unwrap()
        };
        let value = control::request(
            path,
            options.startup_token.as_deref(),
            json!({"action":action}),
        )
        .await?;
        println!("{value}");
        return Ok(());
    }
    if options.discover_port {
        let port = processes::discover_port(&client, options.port)
            .await
            .ok_or_else(|| {
                ApiError::new(404, "CDP_DISCOVERY", "No debuggable Codex window found")
            })?;
        println!("{}", json!({"port":port}));
        return Ok(());
    }
    if options.daemon {
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .arg("inject")
            .args(args.iter().filter(|arg| arg.as_str() != "--daemon"));
        if !options.watch {
            command.arg("--watch");
        }
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        println!(
            "{}",
            json!({"launcher":{"pid":child.id()},"port":options.port})
        );
        return Ok(());
    }
    let (hash, source) = source(&environment).await?;
    let updates = crate::codex_update::UpdateManager::new(
        options.app_path.clone(),
        environment.data_dir.clone(),
        environment.app_root.clone(),
    );
    let update_checks = Arc::new(tokio::sync::Mutex::new(UpdateCheck {
        started: None,
        result: None,
        working: false,
    }));
    if options.status || options.open_existing {
        if options.startup_token.is_none() {
            return Err(ApiError::new(
                400,
                "STARTUP_TOKEN",
                "Managed inspection requires --startup-token",
            ));
        }
        let mut targets = BTreeMap::new();
        for target in processes::main_targets(&client, options.port).await? {
            let connection = cdp::Connection::websocket(
                target["webSocketDebuggerUrl"].as_str().unwrap(),
                options.port,
            )
            .await?;
            targets.insert(
                target["id"].as_str().unwrap_or("").to_owned(),
                Target {
                    connection,
                    _events: AbortTask(tokio::spawn(async {})),
                    patches: None,
                    retry: Arc::new(tokio::sync::Notify::new()),
                    applying: Arc::new(AtomicBool::new(false)),
                    adapting: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let result = if options.open_existing {
            open_panel(&targets, &hash, options.startup_token.as_deref()).await?
        } else {
            managed_status(&targets, &hash, options.startup_token.as_deref()).await?
        };
        for target in targets.values() {
            target.connection.close();
        }
        if result["ready"] != true {
            return Err(ApiError::new(
                409,
                "PANEL_NOT_READY",
                "Panel renderer injection is not ready",
            ));
        }
        println!("{result}");
        return Ok(());
    }
    updates.restore().await?;
    if !options.pipe {
        if let Some(port) = processes::discover_port(&client, options.port).await {
            options.port = port;
        } else if options.refresh_if_running {
            println!(
                "{}",
                json!({"refreshed":[],"skipped":"No debuggable Codex window is running"})
            );
            return Ok(());
        }
    }
    let cli = processes::cli_executable(&options, &environment).await.ok();
    let policies = match &cli {
        Some(cli) => {
            crate::automation::PolicyManager::new_with_codex(
                &environment.data_dir,
                &std::env::current_exe()?,
                environment.runtime_file.as_deref(),
                cli.clone(),
            )
            .await?
        }
        None => {
            crate::automation::PolicyManager::new(
                &environment.data_dir,
                &std::env::current_exe()?,
                environment.runtime_file.as_deref(),
            )
            .await?
        }
    };
    let catalog =
        cli.as_ref()
            .zip(environment.preferences_file.as_ref())
            .map(|(cli, preferences)| {
                crate::models_adapter::CatalogAdapter::new(
                    cli.clone(),
                    environment.data_dir.clone(),
                    preferences.clone(),
                )
            });
    let mut preferences_revision = environment
        .preferences_file
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok());
    if let Some(catalog) = &catalog {
        // Codex 在启动时读取模型目录；完成同步后再启动，避免首个进程加载旧能力。
        if let Err(error) = catalog.sync().await {
            eprintln!("Panel Ultrafast catalog not ready: {error}; Codex will use the current configuration");
        }
    }
    let mut server = if bridge::health(&client, &environment).await.is_ok() {
        None
    } else {
        Some(start_server(&environment, cli.as_deref()).await?)
    };
    let service_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match bridge::health(&client, &environment).await {
            Ok(()) => break,
            Err(error) if Instant::now() >= service_deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    emit("serviceReady", json!({"panelServiceReady":true}));
    let (control_tx, mut control_rx) = mpsc::channel::<control::Request>(64);
    #[cfg(windows)]
    if options.watch {
        let sender = control_tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let action = match line.trim() {
                    "open" => "open",
                    "status" => "status",
                    "retry-thread-tabs" => "retry-thread-tabs",
                    "stop" => "shutdown",
                    _ => continue,
                };
                let (response, _) = tokio::sync::oneshot::channel();
                if sender
                    .blocking_send(control::Request {
                        value: json!({"action":action}),
                        response,
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        emit("openSignalReady", json!({"openPanelSignalReady":true}));
    }
    let mut descriptor = None;
    let mut control_task = None;
    if let (Some(file), Some(startup)) = (&environment.runtime_file, &options.startup_token) {
        let path = control::socket_path(file, startup);
        control_task = Some(control::listen(&path, startup, control_tx.clone()).await?);
        let value = control::Descriptor {
            version: 2,
            pid: std::process::id(),
            url: environment.base_url(),
            control_socket: path.to_string_lossy().into_owned(),
            startup_token: startup.clone(),
            transport: if options.pipe { "pipe" } else { "tcp" }.into(),
            port: (!options.pipe).then_some(options.port),
        };
        control::publish(file, &value).await?;
        descriptor = Some(value);
    }
    let mut browser = None;
    let mut codex: Option<processes::ManagedProcess> = None;
    if options.pipe {
        let executable = processes::executable(&options).await?;
        let (child, connection) = processes::launch_pipe(&executable, &environment).await?;
        codex = Some(processes::ManagedProcess::Child(child));
        browser = Some(connection);
    } else if processes::main_targets(&client, options.port)
        .await
        .map_or(true, |targets| targets.is_empty())
        && options.launch
        && !processes::codex_running(&options).await
    {
        let executable = processes::executable(&options).await?;
        codex = Some(processes::launch_tcp(&executable, &options, &environment).await?);
    }
    let mut targets = BTreeMap::<String, Target>::new();
    let mut avatars = BTreeMap::<String, Avatar>::new();
    let primary = Arc::new(tokio::sync::Mutex::new(None));
    let mut shared = None;
    let mut shared_error = String::new();
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    let mut open_pending = options.open;
    let mut restart_pending = false;
    let mut pets_revision = None;
    let mut stop = false;
    let mut last_error = String::new();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut open_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined2())?;
    loop {
        tokio::select! {
            _=tokio::signal::ctrl_c()=>stop=true,
            _=async { #[cfg(unix)] {terminate.recv().await;} #[cfg(not(unix))] {std::future::pending::<()>().await;} }=>stop=true,
            _=async { #[cfg(unix)] {open_signal.recv().await;} #[cfg(not(unix))] {std::future::pending::<()>().await;} }=>open_pending=true,
            request=control_rx.recv()=>{
                if let Some(request)=request {
                    let result=if request.value["action"]=="shutdown"{stop=true;Ok(json!({"stopping":true}))}
                        else if request.value["action"]=="open"&&!targets.values().any(|target|!target.connection.is_closed()){
                            open_pending=true;Ok(json!({"ready":false,"opening":true}))
                        }else{control_action(&request.value,&targets,&hash,options.startup_token.as_deref(),&updates,&update_checks).await};
                    #[cfg(windows)]
                    if request.value["action"]=="open"&&result.is_ok(){if let Some(pid)=codex.as_ref().and_then(processes::ManagedProcess::id){if let Err(error)=crate::windows_codex::activate_windows_window(pid).await{eprintln!("Panel foreground: {error}");}}}
                    let _=request.response.send(result);
                }
            },
            _=ticker.tick()=>{
                if let Some(child)=server.as_mut(){if child.try_wait()?.is_some(){server=Some(start_server(&environment,cli.as_deref()).await?);}}
                let revision=environment.preferences_file.as_ref().and_then(|path|std::fs::metadata(path).ok()).and_then(|metadata|metadata.modified().ok());
                if revision!=preferences_revision{preferences_revision=revision;if let Some(catalog)=&catalog{let catalog=catalog.clone();tokio::spawn(async move{if let Err(error)=catalog.sync().await{eprintln!("Panel Ultrafast catalog: {error}");}});}}
                let exited=if let Some(process)=codex.as_mut(){process.exited().await?}else{None};
                if let Some(status)=exited{
                    codex=None;
                    for target in targets.values(){if browser.is_some(){target.connection.detach().await;}else{target.connection.close();}}
                    for avatar in avatars.values(){if browser.is_some(){avatar.connection.detach().await;}else{avatar.connection.close();}}
                    targets.clear();avatars.clear();if let Some(connection)=browser.take(){connection.close();}
                    *primary.lock().await=None;
                    // 正常退出保持待机；只有用户再次打开或自有进程异常退出才重新启动。
                    restart_pending=!status&&!cfg!(windows);
                    emit("waitingForCodex",json!({"normalExit":status}));
                }
                if codex.is_none()&&options.launch&&(open_pending||restart_pending)&&!processes::codex_running(&options).await{
                    match launch_codex(&options,&environment).await{
                        Ok((child,connection))=>{codex=Some(child);browser=connection;restart_pending=false;},
                        Err(error)=>{if last_error!=error.message{emit("waitingForCodex",json!({"message":error.message}));last_error=error.message;}}
                    }
                }
                let available=if let Some(browser)=&browser {
                    browser.send("Target.getTargets",json!({})).await.map(|value|value["targetInfos"].as_array().cloned().unwrap_or_default().into_iter().filter(cdp::is_main_target).collect::<Vec<_>>())
                }else{processes::main_targets(&client,options.port).await};
                match available {
                    Ok(available)=>{
                        let ids=available.iter().filter_map(|target|target.get("id").or_else(||target.get("targetId")).and_then(Value::as_str)).collect::<Vec<_>>();
                        let obsolete=targets.iter().filter(|(id,target)|target.obsolete(ids.contains(&id.as_str()))).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                        for id in obsolete{if let Some(target)=targets.remove(&id){if browser.is_some(){target.connection.detach().await;}else{target.connection.close();}}}
                        for target in available {
                            let id=target.get("id").or_else(||target.get("targetId")).and_then(Value::as_str).unwrap_or("").to_owned();
                            if targets.contains_key(&id){continue;}
                            let connection=if let Some(browser)=&browser{browser.attach(&id).await}else{cdp::Connection::websocket(target["webSocketDebuggerUrl"].as_str().unwrap_or(""),options.port).await};
                            let result=match connection {Ok(connection)=>{
                                let result=attach(connection.clone(),&source,&hash,open_pending,&environment,&options,&client,policies.clone()).await;
                                if result.is_err(){if browser.is_some(){connection.detach().await;}else{connection.close();}}result
                            },Err(error)=>Err(error)};
                            match result {
                                Ok(target)=>{
                                    let policy_manager=policies.clone();let rpc=bridge::native_automation_rpc(&target.connection);
                                    tokio::spawn(async move{if let Err(error)=policy_manager.restore(rpc).await{eprintln!("Panel automation policy restore: {}",error.message);}});
                                    let start_adapters=target.retry.clone();
                                    targets.insert(id,target);last_error.clear();
                                    #[cfg(windows)]if open_pending{if let Some(pid)=codex.as_ref().and_then(processes::ManagedProcess::id){if let Err(error)=crate::windows_codex::activate_windows_window(pid).await{eprintln!("Panel foreground: {error}");}}}
                                    open_pending=false;
                                    emit("injected",json!({"panelManagedReady":true}));
                                    start_adapters.notify_one();
                                },
                                Err(error)=>if last_error!=error.message{emit("waitingForCodex",json!({"message":error.message}));last_error=error.message;},
                            }
                        }
                        if open_pending&&!targets.is_empty(){if open_panel(&targets,&hash,options.startup_token.as_deref()).await.is_ok(){
                            #[cfg(windows)]if let Some(pid)=codex.as_ref().and_then(processes::ManagedProcess::id){if let Err(error)=crate::windows_codex::activate_windows_window(pid).await{eprintln!("Panel foreground: {error}");}}
                            open_pending=false;
                        }}
                        *primary.lock().await=targets.values().find(|target|!target.connection.is_closed()).map(|target|target.connection.clone());
                        if let Err(error)=sync_shared_session(&mut shared,&environment,cli.as_deref(),&primary).await{
                            if shared_error!=error.message{eprintln!("Panel shared session: {}",error.message);shared_error=error.message;}
                        }else{shared_error.clear();}
                        if !targets.values().any(|target|target.adapting.load(Ordering::SeqCst)) {
                            match sync_avatars(&mut avatars,browser.as_ref(),&client,&environment,&options,&hash).await{
                                Ok(true)=>pets_revision=None,Ok(false)=>{},Err(error)=>eprintln!("Panel avatar: {}",error.message),
                            }
                        }
                        let index=environment.data_dir.join("pet-animations/index.json");
                        let revision=(std::fs::metadata(index).ok().and_then(|metadata|metadata.modified().ok()),preferences_revision);
                        if pets_revision.as_ref()!=Some(&revision){
                            match crate::pets::read(&environment.data_dir,&environment.app_root).await{
                                Ok(packs)=>{
                                    let preferences=match &environment.preferences_file{Some(path)=>tokio::fs::read(path).await.ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).unwrap_or(Value::Null),None=>Value::Null};
                                    let expression=format!("globalThis.__codexPanelPetAnimations__?.setPacks({packs});globalThis.__codexPanelPetAnimations__?.setSoundEnabled({});",preferences["petSounds"]!=false);
                                    let mut success=true;
                                    for connection in targets.values().map(|target|&target.connection).chain(avatars.values().map(|avatar|&avatar.connection)){if connection.evaluate(&expression,None).await.is_err(){success=false;}}
                                    if success{pets_revision=Some(revision);}
                                },Err(error)=>eprintln!("Panel pet sync: {}",error.message),
                            }
                        }
                        let status=managed_status(&targets,&hash,options.startup_token.as_deref()).await?;emit("managedStatus",json!({"panelManagedStatus":status}));
                        if !options.watch {if targets.is_empty(){return Err(ApiError::new(409,"PANEL_INJECTION","No compatible Codex main window could be injected"));}break;}
                    },
                    Err(error)=>{
                        if !options.watch{return Err(error);}
                        if last_error!=error.message{emit("waitingForCodex",json!({"message":error.message}));last_error=error.message;}
                        if options.attach_existing&&!options.pipe {
                            if let Some(port)=processes::discover_port(&client,options.port).await{options.port=port;
                                if let (Some(file),Some(descriptor))=(&environment.runtime_file,descriptor.as_mut()){descriptor.port=Some(port);control::publish(file,descriptor).await?;}
                            }
                        }
                    }
                }
            }
        }
        if stop {
            break;
        }
    }
    policies.close();
    if let Some(shared) = shared {
        shared.gateway.close().await?;
    }
    for avatar in avatars.values() {
        if browser.is_some() {
            avatar.connection.detach().await;
        } else {
            avatar.connection.close();
        }
    }
    for target in targets.values() {
        if browser.is_some() {
            target.connection.detach().await;
        } else {
            target.connection.close();
        }
    }
    if let Some(browser) = browser {
        browser.close();
    }
    if let Some(task) = control_task {
        task.abort();
    }
    if let (Some(file), Some(descriptor)) = (&environment.runtime_file, &descriptor) {
        control::remove(file, descriptor).await?;
        #[cfg(unix)]
        {
            let _ = tokio::fs::remove_file(&descriptor.control_socket).await;
        }
    }
    if let Some(mut child) = server {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        {
            let _ = child.start_kill();
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
    if let Some(catalog) = catalog {
        catalog.close().await;
    }
    // Codex 属于用户应用，关闭 Panel 只释放控制连接，不终止应用本身。
    drop(codex);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn connected_status_keeps_launcher_fields_when_update_check_has_no_versions() {
        let (client, server) = tokio::io::duplex(16384);
        let (reader, writer) = tokio::io::split(client);
        let connection = cdp::Connection::pipe(reader, writer);
        let peer = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server);
            let mut reader = BufReader::new(reader);
            loop {
                let mut bytes = Vec::new();
                if reader.read_until(0, &mut bytes).await.unwrap() == 0 { break; }
                bytes.pop();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let expression = request["params"]["expression"].as_str().unwrap();
                let value = if expression.contains("window.__codexPanelInjection__") {
                    json!({"sourceHash":"fixture","startupToken":null,"entryMounted":true,"pageVisible":true,"threadTabsReady":true,"heartbeatAt":chrono::Utc::now().timestamp_millis()})
                } else { json!({"needsNativeUpdateBinding":true}) };
                writer.write_all(format!("{}\0", json!({"id":request["id"],"result":{"result":{"value":value}}})).as_bytes()).await.unwrap();
            }
        });
        let target = Target {
            connection: connection.clone(),
            _events: AbortTask(tokio::spawn(async {})), patches: None,
            retry: Arc::new(tokio::sync::Notify::new()),
            applying: Arc::new(AtomicBool::new(false)), adapting: Arc::new(AtomicBool::new(false)),
        };
        let targets = BTreeMap::from([("fixture".into(), target)]);
        let directory = tempfile::tempdir().unwrap();
        let updates = crate::codex_update::UpdateManager::new(directory.path().join("Codex.app"), directory.path().join("data"), directory.path().join("assets"));
        for result in [None, Some(json!({"status":"error","error":"Native update binding unavailable"})), Some(json!({"status":"up_to_date","versions":[]}))] {
            let checks = Arc::new(tokio::sync::Mutex::new(UpdateCheck { started: Some(Instant::now()), result, working: false }));
            let status = control_action(&json!({"action":"status"}), &targets, "fixture", None, &updates, &checks).await.unwrap();
            assert_eq!(status["ready"], true);
            assert_eq!(status["pageVisible"], true);
            assert_eq!(status["threadTabsReady"], true);
            assert_eq!(status["status"]["pageVisible"], true);
            assert_eq!(status["codexUpdateVersions"], json!([]));
        }
        assert_eq!(managed_status(&BTreeMap::new(), "fixture", None).await.unwrap()["pageVisible"], false);
        connection.close();
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn live_adapter_applications_do_not_block_each_other_or_progress() {
        let (client, server) = tokio::io::duplex(16384);
        let (reader, writer) = tokio::io::split(client);
        let connection = cdp::Connection::pipe(reader, writer);
        let (first_sent, first_received) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut first_sent = Some(first_sent);
            let (reader, mut writer) = tokio::io::split(server);
            let mut reader = BufReader::new(reader);
            let mut requests = Vec::new();
            for index in 0..2 {
                let mut bytes = Vec::new();
                reader.read_until(0, &mut bytes).await.unwrap();
                bytes.pop();
                requests.push(serde_json::from_slice::<Value>(&bytes).unwrap());
                if index == 0 { first_sent.take().unwrap().send(()).unwrap(); }
            }
            for (request, feature) in requests.into_iter().zip(["nativeServices", "nativeUpdate"]).rev() {
                assert_eq!(request["method"], "Runtime.evaluate");
                let mut response = json!({"id":request["id"],"result":{"result":{"value":[feature]}}}).to_string().into_bytes();
                response.push(0);
                writer.write_all(&response).await.unwrap();
            }
        });
        let mut applications = FuturesUnordered::new();
        let mut features = BTreeMap::new();
        consume_adapter_progress(&connection, json!({"phase":"feature","feature":"nativeServices","plan":{"nativeServices":{"desktopServices":{"id":"services"}},"nativeUpdate":{},"chunks":{}}}), &mut features, &mut applications);
        tokio::pin!(first_received);
        tokio::select! {
            result = &mut first_received => result.unwrap(),
            _ = applications.next() => panic!("application must remain pending before its CDP response"),
        }
        consume_adapter_progress(&connection, json!({"phase":"adapt","feature":"terminal","completed":1,"total":2}), &mut features, &mut applications);
        assert_eq!(features["terminal"]["phase"], "loading");
        assert_eq!(features["nativeServices"]["phase"], "applying");
        consume_adapter_progress(&connection, json!({"phase":"feature","feature":"nativeUpdate","plan":{"nativeServices":{},"nativeUpdate":{"updater":{"id":"update"}},"chunks":{}}}), &mut features, &mut applications);
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(result) = applications.next().await { complete_adapter_application(result, &mut features); }
        }).await.expect("both CDP requests must be sent before either response is returned");
        assert_eq!(features["nativeServices"]["phase"], "ready");
        assert_eq!(features["nativeUpdate"]["phase"], "ready");
        connection.close();
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn applying_reload_retains_a_temporarily_missing_target() {
        let (client, _peer) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(client);
        let connection = cdp::Connection::pipe(reader, writer);
        let applying = Arc::new(AtomicBool::new(true));
        let target = Target {
            connection,
            _events: AbortTask(tokio::spawn(async {})),
            patches: None,
            retry: Arc::new(tokio::sync::Notify::new()),
            applying: applying.clone(),
            adapting: Arc::new(AtomicBool::new(false)),
        };
        assert!(!target.obsolete(false));
        applying.store(false, Ordering::SeqCst);
        assert!(target.obsolete(false));
        assert!(!target.obsolete(true));
        applying.store(true, Ordering::SeqCst);
        target.connection.close();
        assert!(target.obsolete(false));
    }

    #[tokio::test]
    async fn opening_does_not_retry_unrelated_renderer_errors() {
        let (client, server) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(client);
        let connection = cdp::Connection::pipe(reader, writer);
        let peer = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server);
            let mut reader = BufReader::new(reader);
            let mut command = Vec::new();
            reader.read_until(0, &mut command).await.unwrap();
            command.pop();
            let request: Value = serde_json::from_slice(&command).unwrap();
            let mut response = json!({"id":request["id"],"result":{"exceptionDetails":{"exception":{"description":"TypeError: unexpected renderer failure"}}}}).to_string().into_bytes();
            response.push(0);
            writer.write_all(&response).await.unwrap();
            let mut next = Vec::new();
            let repeated =
                tokio::time::timeout(Duration::from_millis(200), reader.read_until(0, &mut next))
                    .await;
            assert!(
                !matches!(repeated, Ok(Ok(length)) if length > 0),
                "unrelated errors must not be retried"
            );
        });
        let result = request_panel_open(&connection, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(result.code, "CODEX_EVALUATION_FAILED");
        assert!(result.message.contains("unexpected renderer failure"));
        connection.close();
        peer.await.unwrap();
    }
}
