use super::config::identifier;
use crate::ApiError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

const MAX_MESSAGE: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub version: u32,
    pub pid: u32,
    pub url: String,
    pub control_socket: String,
    pub startup_token: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

pub struct Request {
    pub value: Value,
    pub response: oneshot::Sender<Result<Value, ApiError>>,
}

pub fn socket_path(runtime: &Path, startup: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let digest = hex::encode(Sha256::digest(
            format!("{}\0{startup}", runtime.display()).as_bytes(),
        ));
        PathBuf::from(format!(r"\\.\pipe\codex-panel-{}", &digest[..32]))
    }
    #[cfg(not(windows))]
    {
        let _ = startup;
        runtime
            .parent()
            .unwrap_or(Path::new("."))
            .join(".codex-panel.sock")
    }
}

pub fn read_descriptor(path: &Path) -> Result<Descriptor, ApiError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ApiError::new(
            400,
            "RUNTIME_DESCRIPTOR",
            "Panel runtime descriptor must be a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::getuid() } || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(ApiError::new(
                403,
                "RUNTIME_DESCRIPTOR",
                "Panel runtime descriptor must belong to this user and be user-only",
            ));
        }
    }
    let descriptor: Descriptor = serde_json::from_slice(&std::fs::read(path)?)?;
    if descriptor.version != 2
        || descriptor.pid == 0
        || !identifier(&descriptor.startup_token, 100)
        || !matches!(descriptor.transport.as_str(), "tcp" | "pipe")
        || Path::new(&descriptor.control_socket) != socket_path(path, &descriptor.startup_token)
    {
        return Err(ApiError::new(
            400,
            "RUNTIME_DESCRIPTOR",
            "Invalid managed Panel runtime descriptor",
        ));
    }
    let url = url::Url::parse(&descriptor.url)
        .map_err(|_| ApiError::new(400, "RUNTIME_DESCRIPTOR", "Invalid Panel runtime URL"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::new(
            400,
            "RUNTIME_DESCRIPTOR",
            "Panel runtime URL must use IPv4 loopback",
        ));
    }
    Ok(descriptor)
}

pub async fn publish(path: &Path, descriptor: &Descriptor) -> Result<(), ApiError> {
    if descriptor.control_socket != socket_path(path, &descriptor.startup_token).to_string_lossy() {
        return Err(ApiError::new(
            400,
            "RUNTIME_DESCRIPTOR",
            "Panel control socket path does not match runtime descriptor",
        ));
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).await?;
    let mut bytes = serde_json::to_vec(descriptor)?;
    bytes.push(b'\n');
    file.write_all(&bytes).await?;
    file.sync_all().await?;
    drop(file);
    tokio::fs::rename(&temporary, path).await?;
    Ok(())
}

pub async fn remove(path: &Path, descriptor: &Descriptor) -> Result<(), ApiError> {
    match read_descriptor(path) {
        Ok(current)
            if current.pid == descriptor.pid
                && current.startup_token == descriptor.startup_token =>
        {
            tokio::fs::remove_file(path).await?;
        }
        Err(error) if !path.exists() => {
            let _ = error;
        }
        Err(error) => return Err(error),
        _ => {}
    }
    Ok(())
}

async fn handle_stream<S>(stream: S, token: String, sender: mpsc::Sender<Request>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut stream = BufReader::new(stream);
    let result = async {
        let mut bytes = Vec::new();
        loop {
            let available = stream.fill_buf().await?;
            if available.is_empty() {
                return Err(ApiError::new(
                    400,
                    "CONTROL_PROTOCOL",
                    "Truncated Panel control message",
                ));
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |i| i + 1);
            bytes.extend_from_slice(&available[..count]);
            stream.consume(count);
            if bytes.len() > MAX_MESSAGE {
                return Err(ApiError::new(
                    413,
                    "CONTROL_PROTOCOL",
                    "Panel control request is too large",
                ));
            }
            if bytes.last() == Some(&b'\n') {
                break;
            }
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if value["startupToken"].as_str() != Some(token.as_str()) {
            return Err(ApiError::new(
                403,
                "CONTROL_AUTH",
                "Panel startup token was rejected",
            ));
        }
        let (response, receiver) = oneshot::channel();
        sender
            .send(Request { value, response })
            .await
            .map_err(|_| ApiError::new(503, "CONTROL_CLOSED", "Panel control channel closed"))?;
        receiver
            .await
            .map_err(|_| ApiError::new(503, "CONTROL_CLOSED", "Panel control response closed"))?
    }
    .await;
    let value = match result {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(error) => json!({"ok":false,"error":error.message}),
    };
    let _ = stream
        .get_mut()
        .write_all(format!("{value}\n").as_bytes())
        .await;
}

pub async fn listen(
    path: &Path,
    token: &str,
    sender: mpsc::Sender<Request>,
) -> Result<tokio::task::JoinHandle<()>, ApiError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::getuid() } {
                return Err(ApiError::new(
                    403,
                    "CONTROL_SOCKET",
                    "Refusing to replace an unowned or non-socket control path",
                ));
            }
            // 只清理失联 socket；活跃的旧运行实例不能被新进程抢占。
            if tokio::net::UnixStream::connect(path).await.is_ok() {
                return Err(ApiError::new(
                    409,
                    "CONTROL_SOCKET",
                    "Panel control socket is already active",
                ));
            }
            tokio::fs::remove_file(path).await?;
        }
        let listener = tokio::net::UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let token = token.to_owned();
        Ok(tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(handle_stream(stream, token.clone(), sender.clone()));
            }
        }))
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path = path.to_owned();
        let token = token.to_owned();
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)?;
        Ok(tokio::spawn(async move {
            loop {
                if server.connect().await.is_err() {
                    break;
                }
                let next = match ServerOptions::new().create(&path) {
                    Ok(next) => next,
                    Err(_) => break,
                };
                tokio::spawn(handle_stream(server, token.clone(), sender.clone()));
                server = next;
            }
        }))
    }
}

async fn exchange<S>(stream: S, request: &Value) -> Result<Value, ApiError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufReader::new(stream);
    stream
        .get_mut()
        .write_all(format!("{request}\n").as_bytes())
        .await?;
    let mut response = Vec::new();
    loop {
        let bytes = stream.fill_buf().await?;
        if bytes.is_empty() {
            return Err(ApiError::new(
                502,
                "CONTROL_PROTOCOL",
                "Panel control response ended early",
            ));
        }
        let length = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1);
        response.extend_from_slice(&bytes[..length]);
        stream.consume(length);
        if response.len() > MAX_MESSAGE {
            return Err(ApiError::new(
                502,
                "CONTROL_PROTOCOL",
                "Panel control response is too large",
            ));
        }
        if response.last() == Some(&b'\n') {
            break;
        }
    }
    let value: Value = serde_json::from_slice(&response)?;
    if value["ok"] != true {
        return Err(ApiError::new(
            502,
            "CONTROL_FAILED",
            value["error"]
                .as_str()
                .unwrap_or("Panel control request failed"),
        ));
    }
    Ok(value["result"].clone())
}

pub async fn request(
    path: &Path,
    startup: Option<&str>,
    mut request: Value,
) -> Result<Value, ApiError> {
    let descriptor = read_descriptor(path)?;
    if startup.is_some_and(|token| token != descriptor.startup_token) {
        return Err(ApiError::new(
            403,
            "CONTROL_AUTH",
            "Panel startup token does not match managed injector",
        ));
    }
    verify_process(&descriptor).await?;
    request["startupToken"] = json!(descriptor.startup_token);
    tokio::time::timeout(Duration::from_secs(15), async {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(&descriptor.control_socket).await?;
        #[cfg(windows)]
        let stream = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&descriptor.control_socket)?;
        exchange(stream, &request).await
    })
    .await
    .map_err(|_| {
        ApiError::new(
            504,
            "CONTROL_TIMEOUT",
            "Panel injector control request timed out",
        )
    })?
}

pub async fn verify_process(descriptor: &Descriptor) -> Result<(), ApiError> {
    let executable = std::env::current_exe()?.canonicalize()?;
    #[cfg(unix)]
    let output = super::processes::command("/bin/ps")
        .args(["-ww", "-p", &descriptor.pid.to_string(), "-o", "command="])
        .output()
        .await?;
    #[cfg(windows)]
    let output = super::processes::command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').CommandLine",
                descriptor.pid
            ),
        ])
        .output()
        .await?;
    let line = String::from_utf8_lossy(&output.stdout);
    if !output.status.success()
        || !line.contains(executable.to_string_lossy().as_ref())
        || !line.contains("inject")
        || !line.contains(&format!("--startup-token {}", descriptor.startup_token))
    {
        return Err(ApiError::new(
            403,
            "CONTROL_OWNERSHIP",
            format!(
                "Refusing to control unowned Panel injector {}",
                descriptor.pid
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descriptor_rejects_remote_urls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let mut descriptor = Descriptor {
            version: 2,
            pid: 1,
            url: "http://example.com".into(),
            control_socket: socket_path(&path, "test").to_string_lossy().into_owned(),
            startup_token: "test".into(),
            transport: "tcp".into(),
            port: Some(9229),
        };
        std::fs::write(&path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(read_descriptor(&path).is_err());
        descriptor.url = "http://127.0.0.1:47823/token".into();
        std::fs::write(&path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        assert!(read_descriptor(&path).is_ok());
    }
}
