#![cfg(unix)]
use axum::{
    extract::{ws::Message, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    sync::{Arc, Mutex},
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
}
#[derive(Clone)]
struct Fake {
    page: Arc<Mutex<Page>>,
    port: u16,
}

async fn targets(State(state): State<Fake>) -> Json<Value> {
    Json(
        json!([{"id":"fake","type":"page","url":"app://-/index.html","webSocketDebuggerUrl":format!("ws://127.0.0.1:{}/devtools/page/fake",state.port)}]),
    )
}
async fn websocket(State(state): State<Fake>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    state.page.lock().unwrap().connections += 1;
    upgrade.on_upgrade(move|socket|async move{
        let(mut out,mut input)=socket.split();
        while let Some(Ok(Message::Text(text)))=input.next().await{
            let request:Value=serde_json::from_str(text.as_str()).unwrap();
            let result=match request["method"].as_str().unwrap_or(""){
                "Page.getFrameTree"=>json!({"frameTree":{"frame":{"id":"frame","url":"app://-/index.html"}}}),
                "Page.createIsolatedWorld"=>json!({"executionContextId":1}),
                "Page.addScriptToEvaluateOnNewDocument"=>json!({"identifier":"test-script"}),
                "Page.setBypassCSP"=>{state.page.lock().unwrap().csp_bypassed=request["params"]["enabled"]==true;json!({})},
                "Runtime.evaluate"=>{
                    let expression=request["params"]["expression"].as_str().unwrap();let mut page=state.page.lock().unwrap();
                    if let Some(hash)=regex::Regex::new(r#"window\.__CODEX_PANEL_SOURCE_HASH__="([a-f0-9]+)""#).unwrap().captures(expression){page.hash=hash[1].into();page.mounted=true;}
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
                    else if expression.contains("sourceHash: window.__codexPanelInjection__"){json!({"sourceHash":page.hash,"startupToken":page.startup,"entryMounted":page.mounted,"heartbeatAt":page.heartbeat,"pageVisible":page.visible,"frameReady":page.visible&&page.csp_bypassed})}
                    else if expression.contains("__codexPanelInjection__"){json!(true)}else{Value::Null};
                    if waiting_for_navigation{json!({"exceptionDetails":{"exception":{"description":"Error: 无法连接 Codex 原生导航，请等待页面加载后重试"}}})}
                    else{json!({"result":{"type":"object","value":value}})}
                }
                _=>json!({}),
            };
            if out.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.is_err(){break;}
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injector_cli_publishes_owned_control_and_cleans_shutdown() {
    run_smoke(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injector_startup_waits_for_navigation_and_allows_private_frame_scripts() {
    run_smoke(true).await;
}

async fn run_smoke(delayed_navigation: bool) {
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Fake {
        page: Arc::new(Mutex::new(Page {
            navigation_waits: if delayed_navigation { 2 } else { 0 },
            ..Page::default()
        })),
        port,
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
            .arg(root.join("Mock.app"))
            .args(if delayed_navigation {
                vec!["--open"]
            } else {
                vec![]
            })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
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
