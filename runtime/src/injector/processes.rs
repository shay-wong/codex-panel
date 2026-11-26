use super::{
    cdp::Connection,
    config::{Environment, Options},
};
use crate::ApiError;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};

pub enum ManagedProcess {
    Child(Child),
    #[cfg(windows)]
    Activated {
        pid: u32,
        executable: PathBuf,
        profile: PathBuf,
    },
}

impl ManagedProcess {
    #[cfg(windows)]
    pub fn id(&self) -> Option<u32> {
        match self {
            Self::Child(child) => child.id(),
            #[cfg(windows)]
            Self::Activated { pid, .. } => Some(*pid),
        }
    }
    pub async fn exited(&mut self) -> Result<Option<bool>, ApiError> {
        match self {
            Self::Child(child) => Ok(child.try_wait()?.map(|status| status.success())),
            #[cfg(windows)]
            Self::Activated {
                pid,
                executable,
                profile,
            } => {
                let running = crate::windows_codex::windows_codex_processes(executable)
                    .await?
                    .into_iter()
                    .any(|process| {
                        process.pid == *pid
                            && crate::windows_codex::profile_argument(&process.command, profile)
                    });
                Ok((!running).then_some(true))
            }
        }
    }
}

pub fn command(executable: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars() {
        if key.starts_with("CODEX_PANEL_") || key.starts_with("CODEX_TASKBOARD_") {
            command.env_remove(&key);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

pub async fn executable(options: &Options) -> Result<PathBuf, ApiError> {
    if let Some(path) = &options.app_executable {
        return validate_executable(path);
    }
    #[cfg(target_os = "macos")]
    {
        let plist = options.app_path.join("Contents/Info.plist");
        let output = command("/usr/bin/plutil")
            .args(["-extract", "CFBundleExecutable", "raw", "-o", "-"])
            .arg(&plist)
            .output()
            .await?;
        if !output.status.success() {
            return Err(ApiError::new(
                400,
                "CODEX_APP",
                format!(
                    "Unable to read {}: {}",
                    plist.display(),
                    String::from_utf8_lossy(&output.stderr)
                ),
            ));
        }
        let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if name.is_empty()
            || Path::new(&name).file_name().and_then(|s| s.to_str()) != Some(name.as_str())
        {
            return Err(ApiError::new(
                400,
                "CODEX_APP",
                "Invalid CFBundleExecutable",
            ));
        }
        validate_executable(&options.app_path.join("Contents/MacOS").join(name))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = if options.app_path == Path::new("/usr/bin/chatgpt") {
            PathBuf::from("/usr/lib/chatgpt/ChatGPT")
        } else {
            options.app_path.clone()
        };
        validate_executable(&path)
    }
}

pub async fn cli_executable(
    options: &Options,
    environment: &Environment,
) -> Result<PathBuf, ApiError> {
    if let Some(path) = std::env::var_os("CODEX_EXECUTABLE").filter(|value| !value.is_empty()) {
        return validate_executable(Path::new(&path));
    }
    if cfg!(target_os = "macos") {
        for suffix in [
            "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "Contents/Resources/codex",
        ] {
            let path = options.app_path.join(suffix);
            if path.is_file() {
                return validate_executable(&path);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let candidate = Path::new("/usr/lib/chatgpt/resources/codex");
        if candidate.is_file() {
            return validate_executable(candidate);
        }
    }
    #[cfg(windows)]
    {
        // Store 目录不能直接运行辅助 CLI；复用原缓存位置，连同沙箱辅助程序一起复制。
        let executable = executable(options).await?;
        let directory = executable.parent().unwrap_or(Path::new("."));
        let mut candidate = directory.join("resources/codex.exe");
        if !candidate.is_file() {
            candidate = directory.join("codex.exe");
        }
        if candidate.is_file() {
            if candidate
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("\\windowsapps\\")
            {
                let cache = environment.data_dir.join("codex-runtime");
                tokio::fs::create_dir_all(&cache).await?;
                for name in [
                    "codex.exe",
                    "codex-code-mode-host.exe",
                    "codex-command-runner.exe",
                    "codex-windows-sandbox-setup.exe",
                ] {
                    let source = candidate.parent().unwrap().join(name);
                    let source_meta = tokio::fs::metadata(&source).await?;
                    let destination = cache.join(name);
                    let copy = tokio::fs::metadata(&destination)
                        .await
                        .map_or(true, |metadata| {
                            metadata.len() != source_meta.len()
                                || metadata.modified().ok() != source_meta.modified().ok()
                        });
                    if copy {
                        tokio::fs::copy(&source, &destination).await?;
                        let modified = source_meta.modified()?;
                        tokio::fs::File::open(&destination)
                            .await?
                            .into_std()
                            .await
                            .set_modified(modified)?;
                    }
                }
                return validate_executable(&cache.join("codex.exe"));
            }
            return validate_executable(&candidate);
        }
    }
    #[cfg(not(windows))]
    let _ = environment;
    crate::server::codex::executable()
}

fn validate_executable(path: &Path) -> Result<PathBuf, ApiError> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(ApiError::new(
            400,
            "CODEX_APP",
            "Codex executable is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(ApiError::new(
                400,
                "CODEX_APP",
                "Codex executable is not runnable",
            ));
        }
    }
    Ok(path.to_owned())
}

pub async fn discover_ports(preferred: u16) -> Vec<u16> {
    let mut ports = vec![preferred];
    #[cfg(unix)]
    let output = command("/bin/ps").args(["-axo", "command="]).output().await;
    #[cfg(windows)]
    let output = command("powershell.exe").args(["-NoLogo","-NoProfile","-NonInteractive","-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Codex|ChatGPT)\\.exe$' } | Select-Object -ExpandProperty CommandLine"]).output().await;
    if let Ok(output) = output {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if !(line.contains("/ChatGPT.app/")
                    || line.contains("/Codex.app/")
                    || line.contains("/chatgpt/")
                    || line.to_lowercase().contains("codex.exe"))
                {
                    continue;
                }
                if let Some(tail) = line.split("--remote-debugging-port=").nth(1) {
                    let number: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(port) = number.parse::<u16>() {
                        if port > 0 && !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
            }
        }
    }
    ports
}

pub async fn main_targets(client: &reqwest::Client, port: u16) -> Result<Vec<Value>, ApiError> {
    page_targets(client, port, super::cdp::is_main_target).await
}

pub async fn avatar_targets(client: &reqwest::Client, port: u16) -> Result<Vec<Value>, ApiError> {
    page_targets(client, port, super::cdp::is_avatar_target).await
}

async fn page_targets(
    client: &reqwest::Client,
    port: u16,
    predicate: fn(&Value) -> bool,
) -> Result<Vec<Value>, ApiError> {
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await?;
    let value: Value = response.error_for_status()?.json().await?;
    let targets = value
        .as_array()
        .ok_or_else(|| ApiError::new(502, "CDP_TARGETS", "Codex target list is not an array"))?;
    let mut selected = Vec::new();
    for target in targets.iter().filter(|target| predicate(target)) {
        let websocket = target["webSocketDebuggerUrl"].as_str().ok_or_else(|| {
            ApiError::new(502, "CDP_TARGETS", "Codex target has no WebSocket URL")
        })?;
        super::cdp::validate_websocket(websocket, port)?;
        selected.push(target.clone());
    }
    Ok(selected)
}

pub async fn discover_port(client: &reqwest::Client, preferred: u16) -> Option<u16> {
    for port in discover_ports(preferred).await {
        if let Ok(targets) = main_targets(client, port).await {
            if !targets.is_empty() {
                return Some(port);
            }
        }
    }
    None
}

pub async fn codex_running(options: &Options) -> bool {
    #[cfg(unix)]
    {
        let _ = options;
        for name in ["ChatGPT", "Codex"] {
            if let Ok(status) = command("/usr/bin/pgrep")
                .args(["-x", name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
            {
                if status.success() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(windows)]
    {
        let Ok(executable) = executable(options).await else {
            return false;
        };
        crate::windows_codex::windows_codex_processes(&executable)
            .await
            .is_ok_and(|processes| !processes.is_empty())
    }
}

pub async fn launch_tcp(
    executable: &Path,
    options: &Options,
    environment: &Environment,
) -> Result<ManagedProcess, ApiError> {
    #[cfg(target_os = "macos")]
    {
        let app = executable
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .filter(|path| path.extension().is_some_and(|v| v == "app"))
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "CODEX_APP",
                    "Codex application executable is outside an App bundle",
                )
            })?;
        let mut cmd = command("/usr/bin/open");
        // GUI 的语言取自系统设置，避免继承构建终端的语言。
        for (key, _) in std::env::vars() {
            if key == "LANG" || key == "LANGUAGE" || key.starts_with("LC_") {
                cmd.env_remove(key);
            }
        }
        if std::env::var("CODEX_SPARKLE_ENABLED").as_deref() == Ok("false") {
            cmd.args(["--env", "CODEX_SPARKLE_ENABLED=false"]);
        }
        cmd.args(["-W", "-n", "-a"])
            .arg(app)
            .arg("--args")
            .arg(format!("--user-data-dir={}", environment.profile.display()))
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={}", options.port))
            .arg(format!(
                "--remote-allow-origins=http://127.0.0.1:{}",
                options.port
            ))
            .arg("--disable-features=LocalNetworkAccessForSubframeNavigations")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Ok(ManagedProcess::Child(cmd.spawn()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(windows)]
        if executable
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("\\windowsapps\\")
        {
            let pid = crate::windows_codex::activate_windows_codex(
                executable,
                &environment.profile,
                options.port,
            )
            .await?;
            return Ok(ManagedProcess::Activated {
                pid,
                executable: executable.into(),
                profile: environment.profile.clone(),
            });
        }
        Ok(ManagedProcess::Child(
            command(executable)
                .arg(format!("--user-data-dir={}", environment.profile.display()))
                .arg("--remote-debugging-address=127.0.0.1")
                .arg(format!("--remote-debugging-port={}", options.port))
                .arg(format!(
                    "--remote-allow-origins=http://127.0.0.1:{}",
                    options.port
                ))
                .arg("--disable-features=LocalNetworkAccessForSubframeNavigations")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        ))
    }
}

#[cfg(unix)]
pub async fn launch_pipe(
    executable: &Path,
    environment: &Environment,
) -> Result<(Child, Connection), ApiError> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
        let mut fds = [-1; 2];
        // 每个 FD 只交给一个 OwnedFd；spawn 后父进程关闭子端，EOF 才能准确传播。
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe {
            libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
            libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
        }
        Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
    }
    let (child_read, parent_write) = pipe()?;
    let (parent_read, child_write) = pipe()?;
    // 先复制到高位，避免原 FD 恰为 3/4 时 dup2 相互覆盖。
    let read_fd = unsafe { libc::fcntl(child_read.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    let write_fd = unsafe { libc::fcntl(child_write.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if read_fd < 0 || write_fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let read_fd = unsafe { OwnedFd::from_raw_fd(read_fd) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(write_fd) };
    let (read_raw, write_raw) = (read_fd.as_raw_fd(), write_fd.as_raw_fd());
    let mut cmd = command(executable);
    cmd.arg(format!("--user-data-dir={}", environment.profile.display()))
        .args([
            "--remote-debugging-pipe",
            "--disable-features=LocalNetworkAccessForSubframeNavigations",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(read_raw, 3) < 0 || libc::dup2(write_raw, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::fcntl(3, libc::F_SETFD, 0);
            libc::fcntl(4, libc::F_SETFD, 0);
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(child_read);
    drop(child_write);
    drop(read_fd);
    drop(write_fd);
    let reader = tokio::fs::File::from_std(std::fs::File::from(parent_read));
    let writer = tokio::fs::File::from_std(std::fs::File::from(parent_write));
    let browser = Connection::pipe(reader, writer);
    browser
        .send("Browser.getVersion", serde_json::json!({}))
        .await?;
    Ok((child, browser))
}

#[cfg(windows)]
pub async fn launch_pipe(_: &Path, _: &Environment) -> Result<(Child, Connection), ApiError> {
    Err(ApiError::new(
        400,
        "CDP_TRANSPORT",
        "Windows Codex uses TCP remote debugging",
    ))
}

pub async fn open_external(value: &str, reveal: bool) -> Result<(), ApiError> {
    #[cfg(target_os = "macos")]
    let mut cmd = command("/usr/bin/open");
    #[cfg(target_os = "macos")]
    if reveal {
        cmd.arg("-R");
    }
    #[cfg(target_os = "linux")]
    let mut cmd = command("xdg-open");
    #[cfg(windows)]
    let mut cmd = command("explorer.exe");
    #[cfg(windows)]
    if reveal {
        cmd.arg("/select,");
    }
    #[cfg(target_os = "linux")]
    let _ = reveal;
    let status = cmd
        .arg(value)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .await?;
    if !status.success() {
        return Err(ApiError::new(
            502,
            "OPEN_FAILED",
            "System rejected the open request",
        ));
    }
    Ok(())
}
