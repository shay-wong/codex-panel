#![cfg(unix)]
use axum::{
    extract::{ws::Message, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Default)]
struct Page {
    hash: String,
    heartbeat: i64,
    startup: Option<String>,
    mounted: bool,
    visible: bool,
    csp_bypassed: bool,
    navigation_waits: usize,
    open_attempts: usize,
    connections: usize,
    script_sequence: usize,
    scripts: BTreeMap<String, String>,
    script_identifier: Option<String>,
    native_revision: Option<String>,
    native_prepared: Value,
    reloads: usize,
    reload_delay_ms: u64,
    reloading: bool,
    hidden_target_polls: usize,
    fetch_enabled: bool,
    fetch_enables: usize,
    fetch_disables: usize,
    fulfilled_scripts: usize,
    rewritten_entry: bool,
}
#[derive(Clone)]
struct Fake {
    page: Arc<Mutex<Page>>,
    port: u16,
    disconnect: Arc<tokio::sync::Notify>,
}

async fn targets(State(state): State<Fake>) -> Json<Value> {
    {
        let mut page = state.page.lock().unwrap();
        if page.reloading {
            page.hidden_target_polls += 1;
            return Json(json!([]));
        }
    }
    Json(
        json!([{"id":"fake","type":"page","url":"app://-/index.html","webSocketDebuggerUrl":format!("ws://127.0.0.1:{}/devtools/page/fake",state.port)}]),
    )
}

fn observe_source(page: &mut Page, expression: &str) {
    if let Some(hash) = regex::Regex::new(r#"window\.__CODEX_PANEL_SOURCE_HASH__="([a-f0-9]+)""#)
        .unwrap()
        .captures(expression)
    {
        page.hash = hash[1].into();
        page.mounted = true;
    }
    if let Some(revision) =
        regex::Regex::new(r#"globalThis\.__codexPanelNativeAdaptersRevision__="([a-f0-9]+)""#)
            .unwrap()
            .captures(expression)
    {
        page.native_revision = Some(revision[1].into());
    }
    if let Some((_, plan)) = expression.split_once("const plan=") {
        if let Some(Ok(plan)) = serde_json::Deserializer::from_str(plan)
            .into_iter::<Value>()
            .next()
        {
            page.native_prepared = plan["prepared"].clone();
        }
    }
    if let Some(identifier) =
        regex::Regex::new(r#"window\.__CODEX_PANEL_SCRIPT_IDENTIFIER__="([^"]+)""#)
            .unwrap()
            .captures(expression)
    {
        page.script_identifier = Some(identifier[1].into());
    }
}

async fn websocket(State(state): State<Fake>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    state.page.lock().unwrap().connections += 1;
    upgrade.on_upgrade(move|socket|async move{
        let(mut out,mut input)=socket.split();
        let loaded=Arc::new(tokio::sync::Notify::new());
        loop {
            let message=tokio::select! {
                _=state.disconnect.notified()=>{let _=out.send(Message::Close(None)).await;break;},
                _=loaded.notified()=>{
                    {
                        let mut page=state.page.lock().unwrap();
                        page.reloading=false;
                        let scripts=page.scripts.values().cloned().collect::<Vec<_>>();
                        for source in scripts{observe_source(&mut page,&source);}
                    }
                    if out.send(Message::Text(json!({"method":"Page.loadEventFired","params":{"timestamp":1}}).to_string().into())).await.is_err(){break;}
                    continue;
                },
                message=input.next()=>message,
            };
            let Some(Ok(Message::Text(text)))=message else{break;};
            let request:Value=serde_json::from_str(text.as_str()).unwrap();
            let result=match request["method"].as_str().unwrap_or(""){
                "Page.getFrameTree"=>json!({"frameTree":{"frame":{"id":"frame","url":"app://-/index.html"}}}),
                "Page.createIsolatedWorld"=>json!({"executionContextId":1}),
                "Page.addScriptToEvaluateOnNewDocument"=>{
                    let mut page=state.page.lock().unwrap();page.script_sequence+=1;
                    let identifier=format!("test-script-{}",page.script_sequence);
                    page.scripts.insert(identifier.clone(),request["params"]["source"].as_str().unwrap().into());
                    json!({"identifier":identifier})
                },
                "Page.removeScriptToEvaluateOnNewDocument"=>{
                    state.page.lock().unwrap().scripts.remove(request["params"]["identifier"].as_str().unwrap());json!({})
                },
                "Page.setBypassCSP"=>{state.page.lock().unwrap().csp_bypassed=request["params"]["enabled"]==true;json!({})},
                "Fetch.enable"=>{let mut page=state.page.lock().unwrap();page.fetch_enabled=true;page.fetch_enables+=1;json!({})},
                "Fetch.disable"=>{let mut page=state.page.lock().unwrap();page.fetch_enabled=false;page.fetch_disables+=1;json!({})},
                "Fetch.fulfillRequest"=>{
                    let source=base64::engine::general_purpose::STANDARD.decode(request["params"]["body"].as_str().unwrap()).unwrap();
                    let delay={let mut page=state.page.lock().unwrap();page.fulfilled_scripts+=1;page.rewritten_entry=String::from_utf8(source).unwrap().contains("wrapFactories");page.reload_delay_ms};
                    let loaded=loaded.clone();tokio::spawn(async move{tokio::time::sleep(Duration::from_millis(delay)).await;loaded.notify_one();});
                    json!({})
                },
                "Page.reload"=>{
                    let mut page=state.page.lock().unwrap();page.reloads+=1;page.reloading=true;page.mounted=false;page.visible=false;page.hash.clear();
                    json!({})
                },
                "Runtime.evaluate"=>{
                    let expression=request["params"]["expression"].as_str().unwrap();let mut page=state.page.lock().unwrap();
                    observe_source(&mut page,expression);
                    if expression.contains("__codexPanelHostHeartbeatV1"){
                        if let Some(value)=regex::Regex::new(r#""at":(\d+)"#).unwrap().captures(expression){page.heartbeat=value[1].parse().unwrap();}
                        if let Some(value)=regex::Regex::new(r#""startupToken":"([^"]+)""#).unwrap().captures(expression){page.startup=Some(value[1].into());}
                    }
                    let waiting_for_navigation=if expression.contains("__codexPanelInjection__?.open()") {
                        page.open_attempts+=1;
                        if page.navigation_waits>0{
                            page.navigation_waits-=1;
                            true
                        }else{
                            // 私有 iframe 可写入 HTML，但父页 CSP 未绕过时模块不会执行，不能就绪。
                            page.visible=page.csp_bypassed;
                            false
                        }
                    }else{false};
                    let value=if expression.contains("readyState:document.readyState"){json!({"readyState":"complete","href":"app://-/index.html"})}
                    else if expression.contains("document.querySelectorAll('script[type=\"module\"][src]')"){json!(["app://-/assets/main.js"])}
                    else if expression.contains("sourceHash: window.__codexPanelInjection__"){json!({"sourceHash":page.hash,"startupToken":page.startup,"entryMounted":page.mounted,"heartbeatAt":page.heartbeat,"pageVisible":page.visible,"frameReady":page.visible&&page.csp_bypassed,"scriptIdentifier":page.script_identifier,"nativeAdaptersRevision":page.native_revision,"nativeAdaptersPrepared":page.native_prepared,"threadTabsReady":true})}
                    else if expression.contains("__codexPanelInjection__"){json!(true)}else{Value::Null};
                    if waiting_for_navigation{json!({"exceptionDetails":{"exception":{"description":"Error: 无法连接 Codex 原生导航，请等待页面加载后重试"}}})}
                    else{json!({"result":{"type":"object","value":value}})}
                }
                _=>json!({}),
            };
            if out.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.is_err(){break;}
            if request["method"]=="Page.reload"{
                let enabled=state.page.lock().unwrap().fetch_enabled;
                assert!(enabled,"reload must retain native Fetch interception");
                if out.send(Message::Text(json!({"method":"Fetch.requestPaused","params":{"requestId":"reload-main","request":{"url":"app://-/assets/main.js"},"resourceType":"Script","responseStatusCode":200,"responseHeaders":[{"name":"content-type","value":"text/javascript"}]}}).to_string().into())).await.is_err(){break;}
            }
        }
    })
}

struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Default)]
struct EventLog {
    events: Mutex<VecDeque<Value>>,
    invalid: AtomicBool,
}
impl EventLog {
    fn capture(stdout: std::process::ChildStdout) -> Arc<Self> {
        let log = Arc::new(Self::default());
        let captured = log.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let read = reader.by_ref().take(64 * 1024).read_until(b'\n', &mut line);
                let Ok(length) = read else {
                    captured.invalid.store(true, Ordering::SeqCst);
                    break;
                };
                if length == 0 {
                    break;
                }
                if line.last() != Some(&b'\n') {
                    captured.invalid.store(true, Ordering::SeqCst);
                    break;
                }
                let Ok(event) = serde_json::from_slice(&line) else {
                    captured.invalid.store(true, Ordering::SeqCst);
                    break;
                };
                let mut events = captured.events.lock().unwrap();
                if events.len() == 256 {
                    events.pop_front();
                }
                events.push_back(event);
            }
        });
        log
    }

    fn snapshot(&self) -> Vec<Value> {
        assert!(
            !self.invalid.load(Ordering::SeqCst),
            "injector stdout must contain bounded JSONL events"
        );
        self.events.lock().unwrap().iter().cloned().collect()
    }
}

fn write_archive(app: &Path) {
    let html = "<script type=\"module\" src=\"/assets/main.js\"></script>";
    let main = "function load(id){return table[id]}const table={};load.m=table;export{load as __webpack_require__}";
    // 复用 adapters 的 factory archive 和 settings_presentation 的已知成功输入。
    let chunk = "export const __rspack_esm_ids=[42],__webpack_modules__={12:function(m,e,r){let appServices=null;function setAppServices(value){appServices=value}r.d(e,{appServices:()=>appServices,setAppServices:()=>setAppServices})},settings:function(a,b,c){function Settings(){React.useState(0);return gate('3561799561')}}};";
    let mut files = json!({});
    let mut bytes = Vec::new();
    for (name, source) in [
        ("index.html", html),
        ("assets/main.js", main),
        ("assets/chunk.js", chunk),
    ] {
        let entry = json!({"offset":bytes.len().to_string(),"size":source.len()});
        bytes.extend_from_slice(source.as_bytes());
        if let Some((directory, file)) = name.split_once('/') {
            files[directory]["files"][file] = entry;
        } else {
            files[name] = entry;
        }
    }
    let header = serde_json::to_vec(&json!({"files":{"webview":{"files":files}}})).unwrap();
    let mut archive = vec![0u8; 16];
    archive[4..8].copy_from_slice(&((header.len() + 8) as u32).to_le_bytes());
    archive[12..16].copy_from_slice(&(header.len() as u32).to_le_bytes());
    archive.extend(header);
    archive.extend(bytes);
    let directory = app.join("Contents/Resources");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("app.asar"), archive).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injector_cli_publishes_owned_control_and_cleans_shutdown() {
    run_smoke(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injector_startup_waits_for_navigation_and_allows_private_frame_scripts() {
    run_smoke(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injector_adapts_after_connecting_and_reuses_revision_across_reconnect() {
    run_smoke(false, true).await;
}

async fn run_smoke(delayed_navigation: bool, adapt_modules: bool) {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    tokio::fs::create_dir(root.join("inject")).await.unwrap();
    tokio::fs::write(
        root.join("inject/codex-panel.user.js"),
        "window.__codexPanelInjection__ = {};",
    )
    .await
    .unwrap();
    let data = root.join("data");
    tokio::fs::create_dir(&data).await.unwrap();
    let app = root.join("Mock.app");
    if adapt_modules {
        write_archive(&app);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Fake {
        page: Arc::new(Mutex::new(Page {
            navigation_waits: if delayed_navigation { 2 } else { 0 },
            reload_delay_ms: if adapt_modules { 2200 } else { 0 },
            ..Page::default()
        })),
        port,
        disconnect: Arc::new(tokio::sync::Notify::new()),
    };
    let router = Router::new()
        .route("/json/list", get(targets))
        .route("/devtools/page/fake", get(websocket))
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .with_state(state.clone());
    let fake_server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let descriptor = data.join("launcher-runtime.json");
    // 使用假的应用路径与既有 mock 服务，绝不启动用户 Codex 或读取用户配置。
    let mut child = Child(
        Command::new(env!("CARGO_BIN_EXE_codex-panel-runtime"))
            .env_clear()
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("CODEX_HOME", root.join("codex"))
            .env("CODEX_PANEL_APP_ROOT", root)
            .env("CODEX_PANEL_DATA_DIR", &data)
            .env("CODEX_PANEL_RUNTIME_FILE", &descriptor)
            .env("CODEX_PANEL_PORT", port.to_string())
            .env("CODEX_PANEL_SHARED_SESSION_BACKEND", "0")
            .current_dir(root)
            .args([
                "inject",
                "--watch",
                "--port",
                &port.to_string(),
                "--startup-token",
                "isolated-smoke-token",
                "--app-path",
            ])
            .arg(&app)
            .args(if delayed_navigation {
                vec!["--open"]
            } else {
                vec![]
            })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let log = EventLog::capture(child.0.stdout.take().unwrap());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut ready = false;
    while tokio::time::Instant::now() < deadline {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "injector exited before becoming ready"
        );
        if descriptor.exists() {
            if let Ok(status) = exchange(&descriptor, "status").await {
                if status["ready"] == true {
                    ready = true;
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert!(ready, "mock renderer did not become ready");
    if adapt_modules {
        verify_adapters(&mut child, &state, &descriptor, &log).await;
    }
    if delayed_navigation {
        let page = state.page.lock().unwrap();
        assert!(
            page.csp_bypassed,
            "must enable CSP bypass before the private iframe loads"
        );
        assert!(
            page.visible,
            "startup open must succeed after native navigation becomes ready"
        );
        assert_eq!(
            page.open_attempts, 3,
            "retry only the two known navigation readiness failures"
        );
        assert_eq!(
            page.connections, 1,
            "transient navigation readiness must retain the CDP connection"
        );
    }
    let saved: Value =
        serde_json::from_slice(&tokio::fs::read(&descriptor).await.unwrap()).unwrap();
    assert_eq!(saved["pid"], child.0.id());
    let opened = exchange(&descriptor, "open").await.unwrap();
    assert_eq!(opened["status"]["pageVisible"], true);
    exchange(&descriptor, "shutdown").await.unwrap();
    for _ in 0..100 {
        if child.0.try_wait().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(child.0.try_wait().unwrap().is_some());
    assert!(!descriptor.exists());
    assert!(!data.join(".codex-panel.sock").exists());
    fake_server.abort();
}

fn adapters_finished(event: &Value) -> bool {
    event["launcherEvent"] == "nativeAdaptersStatus"
        && matches!(event["phase"].as_str(), Some("ready" | "partial"))
        && event["features"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|feature| {
                feature["feature"] == "settingsPresentation" && feature["phase"] == "ready"
            })
}

async fn wait_adapters(child: &mut Child, log: &EventLog, count: usize) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        assert!(child.0.try_wait().unwrap().is_none(), "injector exited");
        let events = log.snapshot();
        if events
            .iter()
            .filter(|event| adapters_finished(event))
            .count()
            >= count
        {
            return events;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "native module adaptation did not finish: {events:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn verify_adapters(child: &mut Child, state: &Fake, descriptor: &Path, log: &EventLog) {
    let events = wait_adapters(child, log, 1).await;
    let connected = events
        .iter()
        .position(|event| {
            event["launcherEvent"] == "injected" && event["panelManagedReady"] == true
        })
        .expect("base injection must publish its connected state");
    let adapting = events
        .iter()
        .position(|event| event["launcherEvent"] == "nativeAdaptersStatus")
        .expect("background adaptation must publish progress");
    assert!(
        connected < adapting,
        "base connection must precede background adaptation"
    );
    assert!(
        events.iter().any(|event| {
            event["launcherEvent"] == "nativeAdaptersStatus"
                && event["progress"].is_number()
                && event["features"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|feature| {
                        feature["feature"] == "settingsPresentation"
                            && matches!(feature["phase"].as_str(), Some("loading" | "prepared"))
                    })
        }),
        "progress must identify the module being adapted: {events:?}"
    );
    let status = exchange(descriptor, "status").await.unwrap();
    assert_eq!(status["ready"], true, "base connection must remain ready");
    let revision = {
        let page = state.page.lock().unwrap();
        assert_eq!(
            page.reloads, 1,
            "all prepared modules share one renderer reload"
        );
        assert!(
            page.hidden_target_polls > 0,
            "fixture must observe the transiently absent target"
        );
        assert_eq!(
            page.connections, 1,
            "a target missing during reload must retain its CDP session"
        );
        assert_eq!(
            page.fulfilled_scripts, 1,
            "the retained Fetch handler must serve the reloaded entry"
        );
        assert!(
            page.rewritten_entry,
            "the served entry must wrap native module factories"
        );
        assert!(page.fetch_enabled);
        assert_eq!(page.fetch_disables, 0);
        page.native_revision
            .clone()
            .expect("native adapter revision")
    };

    // 模拟真正断线后重连，保留 renderer 中的版本和已应用模块。
    state.disconnect.notify_one();
    wait_adapters(child, log, 2).await;
    let status = exchange(descriptor, "status").await.unwrap();
    assert_eq!(status["ready"], true);
    let page = state.page.lock().unwrap();
    assert_eq!(page.connections, 2, "fixture must reconnect exactly once");
    assert_eq!(page.native_revision.as_deref(), Some(revision.as_str()));
    assert_eq!(
        page.reloads, 1,
        "reconnecting with the same revision must not reload again"
    );
    assert_eq!(
        page.fetch_enables, 2,
        "the new connection must install its Fetch handler"
    );
    assert!(page.fetch_enabled);
}

async fn exchange(
    path: &std::path::Path,
    action: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let saved: Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    let mut stream =
        tokio::net::UnixStream::connect(saved["controlSocket"].as_str().unwrap()).await?;
    stream
        .write_all(
            format!(
                "{}\n",
                json!({"action":action,"startupToken":saved["startupToken"]})
            )
            .as_bytes(),
        )
        .await?;
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        BufReader::new(stream).read_line(&mut line),
    )
    .await??;
    let response: Value = serde_json::from_str(&line)?;
    if response["ok"] != true {
        return Err(response.to_string().into());
    }
    Ok(response["result"].clone())
}
