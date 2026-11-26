use crate::ApiError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, oneshot, Mutex},
};

type Pending = HashMap<u64, oneshot::Sender<Result<Value, ApiError>>>;

pub struct Connection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<Pending>,
    next: AtomicU64,
    pub notifications: broadcast::Sender<Value>,
}

impl Connection {
    pub async fn is_running(&self) -> bool {
        matches!(self.child.lock().await.try_wait(), Ok(None))
    }
    pub async fn start(executable: &Path, workspace: &Path) -> Result<Arc<Self>, ApiError> {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--stdio"])
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (name, _) in std::env::vars() {
            if name.starts_with("CODEX_PANEL_") || name.starts_with("CODEX_TASKBOARD_") {
                command.env_remove(name);
            }
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::new(503, "CODEX_UNAVAILABLE", "Codex executable was not found")
            } else {
                ApiError::new(502, "CODEX_START_FAILED", error.to_string())
            }
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stdin is unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stdout is unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stderr is unavailable")
        })?;
        let (notifications, _) = broadcast::channel(512);
        let connection = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            notifications,
        });
        let weak = Arc::downgrade(&connection);
        tokio::spawn(async move {
            let mut input = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                let read = input.read_until(b'\n', &mut line).await;
                let Some(connection) = weak.upgrade() else {
                    break;
                };
                match read {
                    Ok(0) | Err(_) => {
                        connection.fail_pending("Codex app-server exited").await;
                        break;
                    }
                    Ok(_) if line.len() > 4 * 1024 * 1024 => {
                        connection
                            .fail_pending("Codex app-server output exceeded its limit")
                            .await;
                        let _ = connection.child.lock().await.start_kill();
                        break;
                    }
                    Ok(_) => {}
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message["id"]
                    .as_u64()
                    .filter(|_| message.get("method").is_none())
                {
                    if let Some(pending) = connection.pending.lock().await.remove(&id) {
                        let response = if message.get("error").is_some() {
                            Err(ApiError::new(
                                502,
                                "CODEX_REQUEST_FAILED",
                                message
                                    .pointer("/error/message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex rejected the request"),
                            )
                            .with_details(message["error"].clone()))
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = pending.send(response);
                    }
                } else if let Some(method) = message["method"].as_str() {
                    if let Some(id) = message.get("id") {
                        let _=connection.write(json!({"id":id,"error":{"code":-32601,"message":format!("Unsupported server request '{method}'")}})).await;
                    } else {
                        let _ = connection.notifications.send(message);
                    }
                }
            }
        });
        tokio::spawn(async move {
            let mut input = stderr;
            let mut buffer = [0u8; 4096];
            // 必须持续排空 stderr，避免子进程在错误管道写满时阻塞。
            while let Ok(count) = input.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
            }
        });
        connection.request("initialize",json!({"clientInfo":{"name":"codex-panel","title":"Codex Panel","version":"0.1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}})).await?;
        connection.write(json!({"method":"initialized"})).await?;
        Ok(connection)
    }

    async fn write(&self, value: Value) -> Result<(), ApiError> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&bytes).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ApiError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ApiError::new(
                502,
                "CODEX_DISCONNECTED",
                "Codex app-server disconnected",
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(ApiError::new(
                    504,
                    "CODEX_REQUEST_TIMEOUT",
                    format!("Codex request '{method}' timed out"),
                ))
            }
        }
    }

    async fn fail_pending(&self, message: &str) {
        for (_, sender) in self.pending.lock().await.drain() {
            let _ = sender.send(Err(ApiError::new(502, "CODEX_DISCONNECTED", message)));
        }
        let _ = self
            .notifications
            .send(json!({"method":"app-server/terminated","params":{"message":message}}));
    }

    pub async fn close(&self) {
        let _ = self.stdin.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(1), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        self.fail_pending("Codex app-server closed").await;
    }
}

pub fn executable() -> Result<PathBuf, ApiError> {
    for name in [
        "CODEX_BIN",
        "CODEX_PANEL_CODEX_EXECUTABLE",
        "CODEX_EXECUTABLE",
    ] {
        if let Some(path) = std::env::var_os(name).filter(|p| !p.is_empty()) {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    if cfg!(target_os = "macos") {
        for app in ["/Applications/Codex.app", "/Applications/ChatGPT.app"] {
            for suffix in [
                "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
                "Contents/Resources/codex",
            ] {
                let path = Path::new(app).join(suffix);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            let candidate = path.join(if cfg!(windows) { "codex.exe" } else { "codex" });
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(ApiError::new(
        503,
        "CODEX_UNAVAILABLE",
        "Codex executable was not found",
    ))
}
