mod ai;
mod ai_process;
mod claims;
pub(crate) mod codex;
mod composer;
mod config;
mod jira;
mod planning;
mod routes;
mod security;
mod session;
mod store;
mod summary;
mod turn_owner;
mod validate;

pub use turn_owner::run as run_turn_owner;

use crate::{database::Database, ApiError};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, State, WebSocketUpgrade},
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
pub use config::Config;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex as AsyncMutex},
};

pub struct AppState {
    pub config: Config,
    database: Mutex<Database>,
    events: broadcast::Sender<Value>,
    pub store_write: AsyncMutex<()>,
    pub host_runtime: Mutex<Option<Value>>,
    pub client: reqwest::Client,
    pub ai_active: Mutex<HashMap<String, ai::ActiveTurn>>,
    pub ai_start: AsyncMutex<()>,
    pub ai_events: broadcast::Sender<Value>,
    pub native_reservations: Mutex<HashMap<String, Value>>,
    pub claim_gate: AsyncMutex<()>,
    pub summary_active: Mutex<HashSet<String>>,
    pub jira_gate: AsyncMutex<()>,
    pub jira_completion_gate: AsyncMutex<()>,
    pub jira_sync_generation: AtomicU64,
    pub jira_sync_accept: AtomicBool,
    pub jira_sync_result: Mutex<Option<(u64, Result<Value, ApiError>)>>,
    pub composer: Mutex<HashMap<String, composer::Catalog>>,
    pub planning_gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub app_servers: AsyncMutex<HashMap<String, Arc<codex::Connection>>>,
    shutdown: broadcast::Sender<()>,
}

impl AppState {
    pub fn open(config: Config) -> Result<Arc<Self>, ApiError> {
        std::fs::create_dir_all(&config.data_dir)?;
        let database = Database::open(&config.data_dir.join("panel.sqlite"))?;
        let (events, _) = broadcast::channel(256);
        let (ai_events, _) = broadcast::channel(512);
        let (shutdown, _) = broadcast::channel(1);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let state = Arc::new(Self {
            config,
            database: Mutex::new(database),
            events,
            store_write: AsyncMutex::new(()),
            host_runtime: Mutex::new(None),
            client,
            ai_active: Mutex::new(HashMap::new()),
            ai_start: AsyncMutex::new(()),
            ai_events,
            native_reservations: Mutex::new(HashMap::new()),
            claim_gate: AsyncMutex::new(()),
            summary_active: Mutex::new(HashSet::new()),
            jira_gate: AsyncMutex::new(()),
            jira_completion_gate: AsyncMutex::new(()),
            jira_sync_generation: AtomicU64::new(0),
            jira_sync_accept: AtomicBool::new(false),
            jira_sync_result: Mutex::new(None),
            composer: Mutex::new(HashMap::new()),
            planning_gates: Mutex::new(HashMap::new()),
            app_servers: AsyncMutex::new(HashMap::new()),
            shutdown,
        });
        claims::recover(&state)?;
        state.db("recoverJiraAutoCompletions", &[])?;
        Ok(state)
    }

    pub fn db(&self, method: &str, args: &[Value]) -> Result<Value, ApiError> {
        self.database
            .lock()
            .map_err(|_| ApiError::new(500, "DATABASE_LOCK", "Database lock was poisoned"))?
            .call(method, args)
    }

    pub fn emit(&self, kind: &str, mut value: Value) {
        value["type"] = json!(kind);
        value["at"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        if value.get("projectId").is_none() {
            if let Some(id) = value
                .pointer("/project/id")
                .or_else(|| value.pointer("/task/projectId"))
                .cloned()
            {
                value["projectId"] = id;
            }
        }
        if value.get("taskId").is_none() {
            if let Some(id) = value
                .pointer("/task/id")
                .or_else(|| value.pointer("/comment/taskId"))
                .or_else(|| value.pointer("/attachment/taskId"))
                .cloned()
            {
                value["taskId"] = id;
            }
        }
        let _ = self.events.send(value);
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        json_response(self.status, self.json())
    }
}

pub fn json_response(status: u16, mut value: Value) -> Response {
    fn hide_internal_revisions(value: &mut Value) {
        match value {
            Value::Object(object) => {
                // JS 的变更游标属性不可枚举；Rust 同样只用于内部增量计算，不增加公开字段。
                object.remove("changeRevision");
                for value in object.values_mut() {
                    hide_internal_revisions(value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    hide_internal_revisions(value);
                }
            }
            _ => {}
        }
    }
    hide_internal_revisions(&mut value);
    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(value),
    )
        .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

pub fn empty_response(status: u16) -> Response {
    let mut response = StatusCode::from_u16(status)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

pub fn methods(allowed: &[&str]) -> Response {
    let mut response = ApiError::new(
        405,
        "METHOD_NOT_ALLOWED",
        format!("Allowed methods: {}", allowed.join(", ")),
    )
    .into_response();
    response
        .headers_mut()
        .insert("allow", allowed.join(", ").parse().unwrap());
    response
}

pub fn json_body(headers: &HeaderMap, body: &[u8]) -> Result<Value, ApiError> {
    if security::header(headers, "content-type")
        .map(|s| s.split(';').next().unwrap().trim().to_ascii_lowercase())
        != Some("application/json".into())
    {
        return Err(ApiError::new(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Content-Type must be application/json",
        ));
    }
    if body.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_JSON",
            "Request body cannot be empty",
        ));
    }
    serde_json::from_slice(body)
        .map_err(|_| ApiError::new(400, "INVALID_JSON", "Request body must contain valid JSON"))
}

async fn handle(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request<Body>,
) -> Response {
    let upgrade = upgrade.ok();
    let (parts, body) = request.into_parts();
    let extra =
        match security::assert_request(&state.config, &parts.headers).and_then(|configured| {
            if upgrade.is_some() {
                Ok((configured, HeaderMap::new()))
            } else {
                security::response_headers(&state.config, &parts.headers)
                    .map(|headers| (configured, headers))
            }
        }) {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        };
    let response = async {
        let original = parts.uri.path();
        let prefix = state.config.route_prefix();
        let path = if prefix.is_empty() || original == "/health" { original }
            else if original == prefix {
                let mut response = empty_response(301);
                let location = format!("{prefix}/{}", parts.uri.query().map(|q|format!("?{q}")).unwrap_or_default());
                response.headers_mut().insert("location",location.parse().map_err(|_|ApiError::new(400,"INVALID_PATH","Invalid redirect path"))?);
                return Ok(response);
            } else { original.strip_prefix(&format!("{prefix}/")).map(|tail|&original[prefix.len()..prefix.len()+tail.len()+1]).ok_or_else(||ApiError::new(404,"NOT_FOUND","Route not found"))? };
        if parts.method == Method::OPTIONS && extra.1.contains_key("access-control-allow-origin") { return Ok(empty_response(204)); }
        let local = path.starts_with("/api/local/") || path == "/api/device-workspaces" || path.ends_with("/development-contexts");
        if extra.0 && local { return Err(ApiError::new(409,"LOCAL_COMPANION_REQUIRED","This capability requires a device-local Taskboard origin")); }
        if path.starts_with("/api/local/") && !peer.ip().is_loopback() { return Err(ApiError::new(403,if path.starts_with("/api/local/ai"){"LOCAL_AI_LOOPBACK_REQUIRED"}else{"LOCAL_ONLY"},"This endpoint is only available on this device")); }
        if let Some(upgrade)=upgrade{
            if path!="/api/events"||parts.uri.query().is_some() {return Err(ApiError::new(404,"NOT_FOUND","WebSocket route not found"));}
            if !peer.ip().is_loopback(){return Err(ApiError::new(403,"LOCAL_ONLY","Cloud realtime is only available on this device"));}
            return routes::cloud_websocket(&state,upgrade).await;
        }
        if path == "/health" {
            if parts.method != Method::GET { return Ok(methods(&["GET"])); }
            return Ok(json_response(200, if state.config.instance_token.is_empty() {json!({"status":"ok"})}else{json!({"status":"ok","product":"codex-panel","version":state.config.version,"proof":security::proof(&state.config,&parts.headers)?})}));
        }
        let limit = if path.contains("/attachments") || path.ends_with("/turns") {25*1024*1024}else if path.ends_with("/readme"){3*1024*1024}else{1024*1024};
        let bytes = to_bytes(body,limit).await.map_err(|_|ApiError::new(413,"BODY_TOO_LARGE",format!("Request body cannot exceed {limit} bytes")))?;
        routes::dispatch(&state,&parts.method,path,parts.uri.query(),&parts.headers,&bytes,extra.0,peer).await
    }.await;
    let mut response = response.unwrap_or_else(IntoResponse::into_response);
    response.headers_mut().extend(extra.1);
    response
}

pub async fn run(args: &[String]) -> Result<(), ApiError> {
    let config = Config::from_args(args)?;
    let address = format!("{}:{}", config.host, config.port);
    let listener = if let Some(fd) = config.listen_fd {
        #[cfg(unix)]
        {
            use std::os::fd::FromRawFd;
            if fd < 0 {
                return Err(ApiError::new(
                    400,
                    "INVALID_LISTEN_FD",
                    "Listener file descriptor cannot be negative",
                ));
            }
            // 继承描述符只移交一次所有权，保持启动器预留端口的契约。
            let listener = unsafe { std::net::TcpListener::from_raw_fd(fd) };
            listener.set_nonblocking(true)?;
            TcpListener::from_std(listener)?
        }
        #[cfg(not(unix))]
        {
            return Err(ApiError::new(
                400,
                "INVALID_LISTEN_FD",
                "Inherited Unix file descriptors are unavailable on this platform",
            ));
        }
    } else {
        TcpListener::bind(address).await?
    };
    let port = listener.local_addr()?.port();
    let state = AppState::open(config)?;
    let weak = Arc::downgrade(&state);
    tokio::spawn(async move {
        loop {
            let Some(state) = weak.upgrade() else { break };
            if let Err(error) = claims::tick(&state) {
                eprintln!("Claim queue: {}", error.message);
            }
            drop(state);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let weak = Arc::downgrade(&state);
    tokio::spawn(async move {
        loop {
            let Some(state) = weak.upgrade() else { break };
            if let Err(error) = jira::tick(&state).await {
                eprintln!("Jira: {}", error.message);
            }
            drop(state);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let weak = Arc::downgrade(&state);
    tokio::spawn(async move {
        loop {
            let Some(state) = weak.upgrade() else { break };
            match state.db("listProjectSummaries", &[]) {
                Ok(summaries) => {
                    for item in summaries.as_array().into_iter().flatten() {
                        if summary::due(item) {
                            if let Some(id) = item["projectId"].as_str() {
                                let _ = summary::refresh(&state, id).await;
                            }
                        }
                    }
                }
                Err(error) => eprintln!("Project summary: {}", error.message),
            }
            drop(state);
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
    let app = Router::new().fallback(handle).with_state(state.clone());
    println!("Codex Panel listening on http://127.0.0.1:{port}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
            match term {
                Ok(mut term) => {
                    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
                }
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = state.shutdown.send(());
        let runs = state
            .ai_active
            .lock()
            .map(|runs| runs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in runs {
            let _ = ai::interrupt(&state, &id).await;
        }
        let servers = state
            .app_servers
            .lock()
            .await
            .drain()
            .map(|(_, server)| server)
            .collect::<Vec<_>>();
        for server in servers {
            server.close().await;
        }
    })
    .await
    .map_err(ApiError::from)
}

pub(super) fn events(state: &AppState) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    let receiver = state.events.subscribe();
    let shutdown = state.shutdown.subscribe();
    let stream = futures_util::stream::unfold(
        (receiver, shutdown),
        |(mut receiver, mut shutdown)| async move {
            loop {
                let received =
                    tokio::select! {value=receiver.recv()=>value,_=shutdown.recv()=>return None};
                match received {
                    Ok(value) => {
                        let event = Event::default()
                            .event(value["type"].as_str().unwrap_or("message"))
                            .data(value.to_string());
                        return Some((
                            Ok::<_, std::convert::Infallible>(event),
                            (receiver, shutdown),
                        ));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(20))
                .text("keep-alive"),
        )
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}

pub(super) fn ai_events(state: &AppState, thread_id: &str) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::StreamExt;
    let receiver = state.ai_events.subscribe();
    let shutdown = state.shutdown.subscribe();
    let thread_id = thread_id.to_owned();
    let initial = futures_util::stream::once(async {
        Ok::<_, std::convert::Infallible>(
            Event::default()
                .event("ai.event")
                .data("{\"type\":\"ai.event\"}"),
        )
    });
    let stream = futures_util::stream::unfold(
        (receiver, thread_id, shutdown),
        |(mut receiver, thread_id, mut shutdown)| async move {
            loop {
                let received =
                    tokio::select! {value=receiver.recv()=>value,_=shutdown.recv()=>return None};
                match received {
                    Ok(value) if value["threadId"] == thread_id => {
                        let event = Event::default()
                            .event(value["type"].as_str().unwrap_or("ai.event"))
                            .data(value.to_string());
                        return Some((
                            Ok::<_, std::convert::Infallible>(event),
                            (receiver, thread_id, shutdown),
                        ));
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    let mut response = Sse::new(initial.chain(stream))
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(20))
                .text("keep-alive"),
        )
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
