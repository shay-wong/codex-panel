#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use objc2_app_kit::NSRunningApplication;
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use std::collections::HashSet;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "macos")]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::{
    cmp::Ordering as CmpOrdering,
    collections::VecDeque,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "windows")]
use std::{
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, process::CommandExt},
    process::ChildStdin,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::{ActivationPolicy, Theme};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;
#[cfg(target_os = "windows")]
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, ERROR_SUCCESS, FILETIME, WAIT_OBJECT_0},
        System::{
            RestartManager::{
                RmEndSession, RmRegisterResources, RmShutdown, RmStartSession, CCH_RM_SESSION_KEY,
                RM_UNIQUE_PROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    },
};

const STOP_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const LAUNCHER_STOP_TIMEOUT: Duration = Duration::from_secs(36);
const RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const RECOVERY_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
];
const RELEASES_ENDPOINT: &str =
    "https://api.github.com/repos/shay-wong/codex-panel/releases?per_page=100";
const RELEASES_API_PATH: &str = "repos/shay-wong/codex-panel/releases?per_page=100";
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const UPDATE_FAILURE_CACHE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const GH_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const RENDERER_STATUS_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(any(target_os = "windows", target_os = "linux"))]
const RUNTIME_INTEGRITY_MANIFEST: &str = env!("CODEX_PANEL_RUNTIME_INTEGRITY_MANIFEST");
const PANEL_PREFERRED_PORT: u16 = 47823;
#[cfg(any(target_os = "macos", target_os = "linux"))]
const PANEL_LISTEN_FD: i32 = 5;

#[cfg(target_os = "macos")]
fn set_application_icon(theme: Theme) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = MainThreadMarker::new().ok_or("application icon update left the main thread")?;
    let bytes = match theme {
        Theme::Dark => include_bytes!("../ui/icon-dark.png").as_slice(),
        _ => include_bytes!("../ui/icon-light.png").as_slice(),
    };
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or("unable to decode the application icon")?;
    let application = NSApplication::sharedApplication(marker);
    unsafe { application.setApplicationIconImage(Some(&image)) };
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSnapshot {
    phase: String,
    message: String,
    update_message: String,
    update_available: bool,
    update_url: Option<String>,
    version: String,
    app_path: Option<String>,
    child_pid: Option<u32>,
    open_signal_pid: Option<u32>,
    open_request_pending: bool,
    embedded_visible: bool,
}

#[derive(Clone, Copy, Default)]
struct RendererStatus {
    ready: bool,
    page_visible: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPidRecord {
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPreferences {
    auto_connect_codex: bool,
    auto_open_panel: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUiState {
    snapshot: LauncherSnapshot,
    preferences: LauncherPreferences,
    autostart: bool,
    log_path: String,
    data_directory: String,
}

impl Default for LauncherPreferences {
    fn default() -> Self {
        Self {
            auto_connect_codex: true,
            auto_open_panel: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDescriptor {
    url: String,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    control_socket: Option<PathBuf>,
    #[serde(default)]
    startup_token: Option<String>,
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
#[derive(Deserialize)]
struct RuntimeIntegrityManifest {
    version: u32,
    files: Vec<RuntimeIntegrityEntry>,
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
#[derive(Deserialize)]
struct RuntimeIntegrityEntry {
    path: String,
    sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct GitHubRelease {
    #[serde(rename = "tag_name")]
    tag_name: String,
    #[serde(rename = "html_url")]
    html_url: String,
    draft: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PanelVersion {
    major: u64,
    minor: u64,
    patch: u64,
    fork: Option<u64>,
}

impl PanelVersion {
    fn parse(value: &str) -> Option<Self> {
        let normalized = value.trim().strip_prefix('v').unwrap_or(value.trim());
        let (core, fork) = match normalized.split_once("-fork.") {
            Some((core, fork)) if !fork.is_empty() => (core, Some(fork.parse().ok()?)),
            None => (normalized, None),
            _ => return None,
        };
        let mut components = core.split('.');
        let version = Self {
            major: components.next()?.parse().ok()?,
            minor: components.next()?.parse().ok()?,
            patch: components.next()?.parse().ok()?,
            fork,
        };
        components.next().is_none().then_some(version)
    }

    fn is_fork_tag(value: &str) -> bool {
        let Some(version) = Self::parse(value) else {
            return false;
        };
        value
            == format!(
                "v{}.{}.{}-fork.{}",
                version.major,
                version.minor,
                version.patch,
                version.fork.unwrap_or(0)
            )
            && version.fork.is_some_and(|fork| fork > 0)
    }
}

impl Ord for PanelVersion {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.fork, other.fork) {
                (None, None) => CmpOrdering::Equal,
                (None, Some(_)) => CmpOrdering::Greater,
                (Some(_), None) => CmpOrdering::Less,
                (Some(left), Some(right)) => left.cmp(&right),
            })
    }
}

impl PartialOrd for PanelVersion {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum ReleaseCheckResult {
    None,
    Current,
    Available { version: String, url: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum ReleaseCheckFailure {
    RateLimited { reset_at: Option<u64> },
    Message(String),
}

impl ReleaseCheckFailure {
    fn message(&self, now: u64, cached: bool) -> String {
        let message = match self {
            Self::RateLimited { reset_at } => {
                let retry_minutes = reset_at
                    .map(|reset| reset.saturating_sub(now).div_ceil(60))
                    .filter(|minutes| *minutes > 0);
                retry_minutes.map_or_else(
                    || "GitHub 匿名 API 请求额度已用完，请稍后重试。".into(),
                    |minutes| {
                        format!("GitHub 匿名 API 请求额度已用完，请在约 {minutes} 分钟后重试。")
                    },
                )
            }
            Self::Message(message) => message.clone(),
        };
        if cached {
            format!("上次自动检查失败，可手动重试：{message}")
        } else {
            message
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseCheckCache {
    checked_at: u64,
    result: Result<ReleaseCheckResult, ReleaseCheckFailure>,
}

struct LauncherState {
    child: Mutex<Option<u32>>,
    snapshot: Mutex<LauncherSnapshot>,
    status_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    service_control_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    restart_service_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    open_browser_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    intentional_stop: AtomicBool,
    update_flow_in_progress: AtomicBool,
    generation: AtomicU64,
    lifecycle: Mutex<()>,
    preferences: Mutex<LauncherPreferences>,
    preferences_path: PathBuf,
    recovery_failures: Mutex<VecDeque<Instant>>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    panel_listener: Mutex<Option<TcpListener>>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    codex_port: Mutex<Option<u16>>,
    #[cfg(target_os = "windows")]
    child_control: Mutex<Option<ChildStdin>>,
    #[cfg(target_os = "windows")]
    renderer_status: Mutex<Option<(Instant, RendererStatus)>>,
    _instance_lock: File,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

impl LauncherState {
    fn new(
        data_directory: PathBuf,
        log_path: PathBuf,
        preferences_path: PathBuf,
        preferences: LauncherPreferences,
        version: String,
        instance_lock: File,
    ) -> Self {
        Self {
            child: Mutex::new(None),
            snapshot: Mutex::new(LauncherSnapshot {
                phase: "starting".into(),
                message: "正在启动任务面板…".into(),
                update_message: "尚未检查更新。".into(),
                update_available: false,
                update_url: None,
                version,
                app_path: None,
                child_pid: None,
                open_signal_pid: None,
                open_request_pending: false,
                embedded_visible: false,
            }),
            status_menu: Mutex::new(None),
            service_control_menu: Mutex::new(None),
            restart_service_menu: Mutex::new(None),
            open_browser_menu: Mutex::new(None),
            intentional_stop: AtomicBool::new(false),
            update_flow_in_progress: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            preferences: Mutex::new(preferences),
            preferences_path,
            recovery_failures: Mutex::new(VecDeque::new()),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            panel_listener: Mutex::new(None),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            codex_port: Mutex::new(None),
            #[cfg(target_os = "windows")]
            child_control: Mutex::new(None),
            #[cfg(target_os = "windows")]
            renderer_status: Mutex::new(None),
            _instance_lock: instance_lock,
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path,
        }
    }
}

fn read_preferences(path: &Path) -> Result<LauncherPreferences, String> {
    match fs::read(path) {
        Ok(content) => serde_json::from_slice(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(LauncherPreferences::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_preferences(path: &Path, preferences: LauncherPreferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "偏好设置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    let content = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
    file.write_all(&content)
        .map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temporary_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(temporary_path, path).map_err(|error| error.to_string())
}

fn update_preferences(
    state: &LauncherState,
    update: impl FnOnce(&mut LauncherPreferences),
) -> Result<LauncherPreferences, String> {
    let mut preferences = state.preferences.lock().unwrap();
    let previous = *preferences;
    update(&mut preferences);
    if let Err(error) = write_preferences(&state.preferences_path, *preferences) {
        *preferences = previous;
        return Err(error);
    }
    Ok(*preferences)
}

fn process_environment_key_is_blocked(key: &str, case_insensitive: bool) -> bool {
    const BLOCKED: [&str; 7] = [
        "NODE_OPTIONS",
        "NODE_PATH",
        "NPM_CONFIG_NODE_OPTIONS",
        "BASH_ENV",
        "ENV",
        "ZDOTDIR",
        "CODEX_API_KEY",
    ];
    let normalized;
    let key = if case_insensitive {
        normalized = key.to_ascii_uppercase();
        normalized.as_str()
    } else {
        key
    };
    BLOCKED.contains(&key)
        || key.starts_with("CODEX_PANEL_")
        || key.starts_with("CODEX_TASKBOARD_")
        || key.starts_with("DYLD_")
        || key.starts_with("LD_")
}

fn sanitized_process_environment() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !process_environment_key_is_blocked(&key, cfg!(target_os = "windows"))
        })
        .collect()
}

fn next_recovery_delay(state: &LauncherState) -> Option<Duration> {
    let now = Instant::now();
    let mut failures = state.recovery_failures.lock().unwrap();
    while failures
        .front()
        .is_some_and(|failure| now.duration_since(*failure) >= RECOVERY_WINDOW)
    {
        failures.pop_front();
    }
    let delay = RECOVERY_DELAYS.get(failures.len()).copied()?;
    failures.push_back(now);
    Some(delay)
}

fn reset_recovery(state: &LauncherState) {
    state.recovery_failures.lock().unwrap().clear();
}

#[cfg(target_os = "macos")]
fn open_with_system(target: &str) -> Result<(), String> {
    let status = StdCommand::new("/usr/bin/open")
        .arg(target)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("无法打开 {target}"))
}

#[cfg(target_os = "windows")]
fn open_with_system(target: &str) -> Result<(), String> {
    let status = StdCommand::new("explorer.exe")
        .arg(target)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("无法打开 {target}"))
}

#[cfg(target_os = "linux")]
fn open_with_system(target: &str) -> Result<(), String> {
    let status = StdCommand::new("xdg-open")
        .arg(target)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("无法打开 {target}"))
}

fn panel_browser_url(state: &LauncherState) -> Result<String, String> {
    let runtime_path = state.data_directory.join("launcher-runtime.json");
    let descriptor: RuntimeDescriptor =
        serde_json::from_slice(&fs::read(&runtime_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    trusted_panel_browser_url(&descriptor.url)
}

fn trusted_panel_browser_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|error| error.to_string())?;
    let instance_token = url.path().strip_prefix('/').unwrap_or_default();
    let trusted_token = (16..=128).contains(&instance_token.len())
        && instance_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || !trusted_token
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Panel 运行地址不是可信的本机地址".into());
    }
    Ok(url.to_string())
}

fn trusted_release_url(value: &str, expected_tag: &str) -> bool {
    value == format!("https://github.com/shay-wong/codex-panel/releases/tag/{expected_tag}")
}

fn find_gh_executable() -> Option<PathBuf> {
    let binary = if cfg!(target_os = "windows") {
        "gh.exe"
    } else {
        "gh"
    };
    if let Some(path) = std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|path| path.join(binary))
            .find(|path| path.is_file())
    }) {
        return Some(path);
    }
    #[cfg(target_os = "macos")]
    {
        ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|path| path.join(r"GitHub CLI\gh.exe"))
            .filter(|path| path.is_file())
    }
    #[cfg(target_os = "linux")]
    {
        None
    }
}

fn releases_from_gh() -> Option<Vec<GitHubRelease>> {
    let mut child = StdCommand::new(find_gh_executable()?)
        .args([
            "api",
            "--hostname",
            "github.com",
            RELEASES_API_PATH,
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_HTTP_TIMEOUT", "8")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let stdout_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let deadline = Instant::now() + GH_CHECK_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                return None;
            }
        }
    };
    let output = stdout_reader.join().ok()?.ok()?;
    if !status.success() {
        return None;
    }
    serde_json::from_slice(&output).ok()
}

fn github_api_error_message(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    _now: u64,
) -> ReleaseCheckFailure {
    let rate_limited = status == reqwest::StatusCode::FORBIDDEN
        && headers
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            == Some("0");
    if rate_limited {
        let reset_at = headers
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        return ReleaseCheckFailure::RateLimited { reset_at };
    }
    ReleaseCheckFailure::Message(format!("更新服务返回 HTTP {status}"))
}

fn github_network_error_message(error: &reqwest::Error) -> ReleaseCheckFailure {
    ReleaseCheckFailure::Message(if error.is_timeout() {
        "连接 GitHub 超时，请检查网络后重试。".into()
    } else if error.is_connect() {
        "无法连接 GitHub，请检查网络或代理设置后重试。".into()
    } else {
        format!("GitHub 更新请求失败：{error}")
    })
}

fn release_check_result(
    current_version: &str,
    releases: Vec<GitHubRelease>,
) -> Result<ReleaseCheckResult, String> {
    let installed = PanelVersion::parse(current_version)
        .ok_or_else(|| format!("无法识别当前版本：{current_version}"))?;
    let latest = releases
        .into_iter()
        .filter(|release| {
            !release.draft
                && PanelVersion::is_fork_tag(&release.tag_name)
                && trusted_release_url(&release.html_url, &release.tag_name)
        })
        .filter_map(|release| {
            PanelVersion::parse(&release.tag_name).map(|version| (version, release))
        })
        .max_by_key(|(version, _)| *version);
    let Some((version, release)) = latest else {
        return Ok(ReleaseCheckResult::None);
    };
    if installed >= version {
        return Ok(ReleaseCheckResult::Current);
    }
    Ok(ReleaseCheckResult::Available {
        version: release.tag_name,
        url: release.html_url,
    })
}

fn cached_release_check(
    path: &Path,
    now: u64,
) -> Option<Result<ReleaseCheckResult, ReleaseCheckFailure>> {
    let cache: ReleaseCheckCache = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let cache_interval = match &cache.result {
        Ok(_) => UPDATE_CHECK_INTERVAL.as_secs(),
        Err(ReleaseCheckFailure::RateLimited {
            reset_at: Some(reset_at),
        }) => reset_at.checked_sub(cache.checked_at)?,
        Err(_) => UPDATE_FAILURE_CACHE_INTERVAL.as_secs(),
    };
    if now.checked_sub(cache.checked_at)? >= cache_interval {
        return None;
    }
    if let Ok(ReleaseCheckResult::Available { version, url }) = &cache.result {
        if !PanelVersion::is_fork_tag(version) || !trusted_release_url(url, version) {
            return None;
        }
    }
    Some(cache.result)
}

fn write_release_check_cache(
    path: &Path,
    checked_at: u64,
    result: &Result<ReleaseCheckResult, ReleaseCheckFailure>,
) -> Result<(), String> {
    let cache = ReleaseCheckCache {
        checked_at,
        result: result.clone(),
    };
    let content = serde_json::to_vec_pretty(&cache).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

async fn check_fork_release(
    current_version: &str,
) -> Result<ReleaseCheckResult, ReleaseCheckFailure> {
    if let Ok(Some(releases)) = tauri::async_runtime::spawn_blocking(releases_from_gh).await {
        return release_check_result(current_version, releases)
            .map_err(ReleaseCheckFailure::Message);
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(format!("codex-panel/{current_version}"))
        .build()
        .map_err(|error| ReleaseCheckFailure::Message(error.to_string()))?
        .get(RELEASES_ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| github_network_error_message(&error))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(ReleaseCheckResult::None);
    }
    if !response.status().is_success() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        return Err(github_api_error_message(
            response.status(),
            response.headers(),
            now,
        ));
    }
    let releases: Vec<GitHubRelease> = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|error| ReleaseCheckFailure::Message(error.to_string()))?,
    )
    .map_err(|error| {
        ReleaseCheckFailure::Message(format!("GitHub Release 响应格式无效：{error}"))
    })?;
    release_check_result(current_version, releases).map_err(ReleaseCheckFailure::Message)
}

#[cfg(target_os = "macos")]
fn verify_signed_component(
    path: &Path,
    expected_identifier: &str,
    expected_team: &str,
    deep: bool,
) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err(format!("拒绝符号链接：{}", path.display()));
    }
    let mut verify = StdCommand::new("/usr/bin/codesign");
    verify.args(["--verify", "--strict"]);
    if deep {
        verify.arg("--deep");
    }
    if !verify
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?
        .success()
    {
        return Err(format!("签名验证失败：{}", path.display()));
    }
    let output = StdCommand::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    let details = String::from_utf8_lossy(&output.stderr);
    if !details
        .lines()
        .any(|line| line == format!("Identifier={expected_identifier}"))
        || !details
            .lines()
            .any(|line| line == format!("TeamIdentifier={expected_team}"))
    {
        return Err(format!("签名身份不匹配：{}", path.display()));
    }
    Ok(())
}

fn reject_runtime_symlinks(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!("拒绝运行符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
                pending.push(entry.map_err(|error| error.to_string())?.path());
            }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn verified_runtime_relative_path(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 1_024
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("打包 runtime 清单路径无效：{value}"));
    }
    Ok(path)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn collect_protected_runtime_files(
    resource_directory: &Path,
    relative_directory: &Path,
    files: &mut HashSet<String>,
) -> Result<(), String> {
    let directory = resource_directory.join(relative_directory);
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!("拒绝运行符号链接：{}", path.display()));
        }
        let relative_path = path
            .strip_prefix(resource_directory)
            .map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_protected_runtime_files(resource_directory, relative_path, files)?;
        } else if metadata.is_file() {
            files.insert(relative_path.to_string_lossy().replace('\\', "/"));
        } else {
            return Err(format!("拒绝未知 runtime 文件类型：{}", path.display()));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn verify_runtime_integrity(
    resource_directory: &Path,
    node_path: &Path,
    manifest_json: &str,
) -> Result<(), String> {
    let manifest: RuntimeIntegrityManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    if manifest.version != 1 || manifest.files.is_empty() || manifest.files.len() > 10_000 {
        return Err("打包 runtime 完整性清单无效".into());
    }
    let node_name = node_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别打包 Node 文件名".to_string())?;
    let mut paths = HashSet::new();
    for entry in &manifest.files {
        let relative_path = verified_runtime_relative_path(&entry.path)?;
        if !paths.insert(entry.path.clone())
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!("打包 runtime 清单条目无效：{}", entry.path));
        }
        let path = if entry.path == node_name {
            node_path.to_path_buf()
        } else {
            resource_directory.join(relative_path)
        };
        let actual = sha256_file(&path)
            .map_err(|error| format!("无法校验打包 runtime {}：{error}", entry.path))?;
        if !actual.eq_ignore_ascii_case(&entry.sha256) {
            return Err(format!("打包 runtime 完整性校验失败：{}", entry.path));
        }
    }
    if !paths.contains(node_name) || !paths.contains("app/scripts/codex-injector.mjs") {
        return Err("打包 runtime 清单缺少启动入口".into());
    }
    let mut actual_protected_paths = HashSet::new();
    collect_protected_runtime_files(
        resource_directory,
        Path::new("app"),
        &mut actual_protected_paths,
    )?;
    collect_protected_runtime_files(
        resource_directory,
        Path::new("bin"),
        &mut actual_protected_paths,
    )?;
    let expected_protected_paths = paths
        .iter()
        .filter(|path| path.starts_with("app/") || path.starts_with("bin/"))
        .cloned()
        .collect::<HashSet<_>>();
    if actual_protected_paths != expected_protected_paths {
        return Err("打包 runtime 文件集合与完整性清单不匹配".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_launcher_runtime(resource_directory: &Path, node_path: &Path) -> Result<(), String> {
    let app_bundle = resource_directory
        .parent()
        .and_then(Path::parent)
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
        .ok_or_else(|| "无法定位 Codex Panel.app".to_string())?;
    if !StdCommand::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app_bundle)
        .status()
        .map_err(|error| error.to_string())?
        .success()
    {
        return Err("Codex Panel.app 签名验证失败，请重新运行 npm run codex:install".into());
    }
    reject_runtime_symlinks(&resource_directory.join("app"))?;
    reject_runtime_symlinks(node_path)
}

#[cfg(target_os = "windows")]
fn verify_launcher_runtime(resource_directory: &Path, node_path: &Path) -> Result<(), String> {
    verify_windows_launcher_signature()?;
    reject_runtime_symlinks(resource_directory)?;
    reject_runtime_symlinks(node_path)?;
    verify_runtime_integrity(resource_directory, node_path, RUNTIME_INTEGRITY_MANIFEST)
}

#[cfg(target_os = "linux")]
fn verify_launcher_runtime(resource_directory: &Path, node_path: &Path) -> Result<(), String> {
    reject_runtime_symlinks(resource_directory)?;
    reject_runtime_symlinks(node_path)?;
    verify_runtime_integrity(resource_directory, node_path, RUNTIME_INTEGRITY_MANIFEST)
}

#[cfg(target_os = "windows")]
fn windows_directory() -> Result<PathBuf, String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }

    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: The buffer is writable for the supplied length and remains alive for the call.
    let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err("无法定位受信任的 Windows 系统目录".into());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(target_os = "windows")]
fn verify_windows_launcher_signature() -> Result<(), String> {
    let expected = option_env!("CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT")
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            "当前 Windows 构建未配置 Codex Panel 代码签名，拒绝启动打包 runtime".to_string()
        })?;
    let windows = windows_directory()?;
    let powershell_directory = windows.join("System32/WindowsPowerShell/v1.0");
    let powershell = powershell_directory.join("powershell.exe");
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = StdCommand::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 1 }; [Console]::Out.Write($signature.SignerCertificate.Thumbprint)",
        ])
        .arg(executable)
        .env_clear()
        .env("SystemRoot", &windows)
        .env("WINDIR", &windows)
        .env("PATH", windows.join("System32"))
        .env("PSModulePath", powershell_directory.join("Modules"))
        .output()
        .map_err(|error| error.to_string())?;
    let actual = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !actual.trim().eq_ignore_ascii_case(expected) {
        return Err("Codex Panel Windows 签名验证失败，请重新安装正式签名版本".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_codex_app(path: &Path) -> Result<(), String> {
    verify_signed_component(path, "com.openai.codex", "2DC432GLL2", true)?;
    verify_signed_component(
        &path.join("Contents/Resources/codex"),
        "codex",
        "2DC432GLL2",
        false,
    )
}

#[cfg(target_os = "windows")]
fn verify_codex_app(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_codex_app(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(file))
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == Some(32) => Ok(None),
        Err(error) => Err(error),
    }
}

fn loopback_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

fn panel_loopback_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", PANEL_PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn panel_listener(state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let mut listener = state.panel_listener.lock().unwrap();
    if listener.is_none() {
        *listener = Some(panel_loopback_listener()?);
    }
    let listener = listener.as_ref().unwrap();
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    Ok((Some(listener.as_raw_fd()), port))
}

#[cfg(target_os = "windows")]
fn panel_listener(_state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let listener = panel_loopback_listener()?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok((None, port))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn codex_port(state: &LauncherState) -> Result<u16, String> {
    let mut port = state.codex_port.lock().unwrap();
    if let Some(port) = *port {
        return Ok(port);
    }
    let listener = loopback_listener()?;
    let selected = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    *port = Some(selected);
    Ok(selected)
}

fn status_menu_label(phase: &str) -> &'static str {
    match phase {
        "running" => "运行状态：正常",
        "waiting" => "运行状态：等待 Codex",
        "error" => "运行状态：异常",
        "stopped" => "运行状态：已停止",
        _ => "运行状态：启动中",
    }
}

fn update_snapshot(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: impl FnOnce(&mut LauncherSnapshot),
) -> LauncherSnapshot {
    let snapshot = {
        let mut snapshot = state.snapshot.lock().unwrap();
        update(&mut snapshot);
        snapshot.clone()
    };
    let status_menu = state.status_menu.lock().unwrap().clone();
    let service_control_menu = state.service_control_menu.lock().unwrap().clone();
    let restart_service_menu = state.restart_service_menu.lock().unwrap().clone();
    let open_browser_menu = state.open_browser_menu.lock().unwrap().clone();
    let menu_snapshot = snapshot.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(status_menu) = status_menu {
            let _ = status_menu.set_text(status_menu_label(&menu_snapshot.phase));
        }
        let running = menu_snapshot.child_pid.is_some();
        if let Some(service_control_menu) = service_control_menu {
            let _ = service_control_menu.set_text(if running {
                "停止服务"
            } else {
                "启动服务"
            });
        }
        if let Some(restart_service_menu) = restart_service_menu {
            let _ = restart_service_menu.set_enabled(running);
        }
        if let Some(open_browser_menu) = open_browser_menu {
            let _ = open_browser_menu.set_enabled(running);
        }
    });
    let _ = app.emit("launcher-status", snapshot.clone());
    snapshot
}

fn append_log(state: &LauncherState, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn show_error_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("关闭".into()))
        .blocking_show();
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Codex Panel 管理窗口不可用".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn find_codex_app(home_directory: &Path) -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/ChatGPT.app"),
        home_directory.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home_directory.join("Applications/Codex.app"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

#[cfg(target_os = "macos")]
fn ordinary_codex_process(app_path: &Path) -> Result<Option<u32>, String> {
    let app_name = app_path
        .file_stem()
        .ok_or_else(|| "无法识别 Codex App 名称".to_string())?;
    let executable = app_path.join("Contents/MacOS").join(app_name);
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = executable.to_string_lossy();
    let mut ordinary_pid = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let command = line[separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        if command.contains(" --remote-debugging-port=") {
            return Ok(None);
        }
        ordinary_pid = line[..separator].parse().ok();
    }
    Ok(ordinary_pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_is_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(target_os = "macos")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    let application =
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t)
            .ok_or_else(|| "无法找到正在运行的 Codex".to_string())?;
    if !application.terminate() {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn find_codex_app(_home_directory: &Path) -> Option<PathBuf> {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-AppxPackage -Name OpenAI.Codex).InstallLocation",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let install_location = String::from_utf8_lossy(&output.stdout);
    let candidate = PathBuf::from(install_location.trim())
        .join("app")
        .join("ChatGPT.exe");
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "windows")]
fn ordinary_codex_process(app_path: &Path, codex_profile: &Path) -> Result<Option<u32>, String> {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; $app = $env:CODEX_PANEL_CODEX_APP_PATH; $profile = $env:CODEX_PANEL_CODEX_PROFILE; $name = [IO.Path]::GetFileName($app); $all = @(Get-CimInstance Win32_Process -Filter \"Name = '$name'\" | Where-Object { $_.ExecutablePath -eq $app }); $pids = @{}; foreach ($item in $all) { $pids[[uint32]$item.ProcessId] = $true }; $process = $all | Where-Object { $command = [string]$_.CommandLine; $isRoot = -not $pids.ContainsKey([uint32]$_.ParentProcessId); $usesManagedProfile = $command.IndexOf('--user-data-dir', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0; $usesPrivateCdp = $command.IndexOf('--remote-debugging-pipe', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $command.IndexOf('--remote-debugging-port', [StringComparison]::OrdinalIgnoreCase) -ge 0; $isManaged = $usesManagedProfile -and $usesPrivateCdp; $isRoot -and -not $isManaged } | Select-Object -First 1; if ($null -ne $process) { [Console]::Out.Write($process.ProcessId) }",
        ])
        .env("CODEX_PANEL_CODEX_APP_PATH", app_path)
        .env("CODEX_PANEL_CODEX_PROFILE", codex_profile)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }
    let pid = String::from_utf8_lossy(&output.stdout);
    let pid = pid.trim();
    if pid.is_empty() {
        return Ok(None);
    }
    pid.parse()
        .map(Some)
        .map_err(|_| "无法检查正在运行的 Codex".to_string())
}

#[cfg(target_os = "windows")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .map_err(|error| error.to_string())?;
    let mut creation_time = FILETIME::default();
    let mut exit_time = FILETIME::default();
    let mut kernel_time = FILETIME::default();
    let mut user_time = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    }
    .is_err()
    {
        let _ = unsafe { CloseHandle(process) };
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let mut session = 0;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let started = unsafe { RmStartSession(&mut session, None, PWSTR(session_key.as_mut_ptr())) };
    if started != ERROR_SUCCESS {
        let _ = unsafe { CloseHandle(process) };
        return Err("无法请求 Codex 退出".to_string());
    }
    let application = RM_UNIQUE_PROCESS {
        dwProcessId: pid,
        ProcessStartTime: creation_time,
    };
    let registered = unsafe { RmRegisterResources(session, None, Some(&[application]), None) };
    let shutdown = if registered == ERROR_SUCCESS {
        unsafe { RmShutdown(session, 0, None) }
    } else {
        registered
    };
    let _ = unsafe { RmEndSession(session) };
    if shutdown != ERROR_SUCCESS {
        let _ = unsafe { CloseHandle(process) };
        return Err("Codex 没有接受退出请求".to_string());
    }

    let exited = unsafe {
        WaitForSingleObject(
            process,
            LAUNCHER_STOP_TIMEOUT.as_millis().try_into().unwrap(),
        )
    } == WAIT_OBJECT_0;
    let _ = unsafe { CloseHandle(process) };
    if exited {
        Ok(())
    } else {
        Err("Codex 尚未退出，任务面板没有启动".to_string())
    }
}

#[cfg(target_os = "linux")]
fn find_codex_app(_home_directory: &Path) -> Option<PathBuf> {
    let candidate = PathBuf::from("/usr/lib/chatgpt/ChatGPT");
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "linux")]
fn ordinary_codex_process(app_path: &Path, codex_profile: &Path) -> Result<Option<u32>, String> {
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = app_path.to_string_lossy();
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(pid_separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let Some(pid) = line[..pid_separator].parse::<u32>().ok() else {
            continue;
        };
        let parent_and_command = line[pid_separator..].trim_start();
        let Some(parent_separator) = parent_and_command.find(char::is_whitespace) else {
            continue;
        };
        let Some(parent_pid) = parent_and_command[..parent_separator].parse::<u32>().ok() else {
            continue;
        };
        let command = parent_and_command[parent_separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        processes.push((pid, parent_pid, command.to_string()));
    }

    let managed_profile = format!("--user-data-dir={}", codex_profile.display());
    Ok(processes
        .iter()
        .find(|(pid, parent_pid, command)| {
            !processes
                .iter()
                .any(|(candidate_pid, _, _)| candidate_pid == parent_pid && candidate_pid != pid)
                && !(command.contains(" --remote-debugging-pipe")
                    && command.contains(&format!(" {managed_profile}")))
        })
        .map(|(pid, _, _)| *pid))
}

#[cfg(target_os = "linux")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
}

#[cfg(target_os = "windows")]
fn missing_codex_app_message() -> String {
    "未找到官方 Codex App。请先从 Microsoft Store 安装。".to_string()
}

#[cfg(target_os = "linux")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT App。请先安装 Ubuntu x64 .deb。".to_string()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn send_process_group_signal(pid: u32, signal: i32) {
    unsafe {
        if libc::kill(-(pid as i32), signal) != 0 {
            libc::kill(pid as i32, signal);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_group_is_running(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

#[cfg(target_os = "windows")]
fn process_group_is_running(pid: u32) -> bool {
    StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
            ),
        ])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "macos")]
fn signal_pending_panel_open(app: &AppHandle, state: &Arc<LauncherState>) -> Result<(), String> {
    let snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending || snapshot.open_signal_pid.is_none() {
        return Ok(());
    }
    drop(snapshot);
    let result = send_injector_control_request(state, "open");
    let mut snapshot = state.snapshot.lock().unwrap();
    if let Ok(status) = &result {
        snapshot.open_request_pending = false;
        snapshot.embedded_visible = status.page_visible;
    } else {
        snapshot.open_signal_pid = None;
    }
    drop(snapshot);
    update_snapshot(app, state, |_| {});
    result.map(|_| ())
}

#[cfg(target_os = "linux")]
fn signal_pending_panel_open(app: &AppHandle, state: &Arc<LauncherState>) -> Result<(), String> {
    let mut snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    let Some(pid) = snapshot.open_signal_pid else {
        return Ok(());
    };
    if unsafe { libc::kill(pid as i32, libc::SIGUSR2) } != 0 {
        snapshot.open_signal_pid = None;
        return Err(std::io::Error::last_os_error().to_string());
    }
    drop(snapshot);
    update_snapshot(app, state, |_| {});
    Ok(())
}

fn apply_renderer_status(snapshot: &mut LauncherSnapshot, pid: u32, status: RendererStatus) {
    snapshot.embedded_visible = status.ready && status.page_visible;
    if status.ready {
        snapshot.phase = "running".into();
        snapshot.message = "Codex 连接和 Panel 注入已就绪。".into();
        snapshot.open_signal_pid = Some(pid);
    } else if snapshot.phase == "running" || snapshot.open_signal_pid == Some(pid) {
        snapshot.phase = "waiting".into();
        snapshot.message = "Panel 服务已启动，正在等待 Codex 连接。".into();
        snapshot.open_signal_pid = None;
    }
}

fn apply_waiting_for_codex(snapshot: &mut LauncherSnapshot) {
    snapshot.phase = "waiting".into();
    snapshot.message = "Panel 服务已启动，正在等待 Codex 连接。".into();
    snapshot.embedded_visible = false;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn monitor_renderer_readiness(
    app: AppHandle,
    state: Arc<LauncherState>,
    pid: u32,
    generation: u64,
) {
    thread::spawn(move || loop {
        thread::sleep(RENDERER_STATUS_INTERVAL);
        if state.generation.load(Ordering::SeqCst) != generation
            || state.child.lock().unwrap().as_ref() != Some(&pid)
        {
            return;
        }
        let status = query_renderer_status(&state);
        let needs_update = {
            let snapshot = state.snapshot.lock().unwrap();
            if status.ready {
                snapshot.phase != "running"
                    || snapshot.open_signal_pid != Some(pid)
                    || snapshot.embedded_visible != status.page_visible
            } else {
                snapshot.phase == "running"
                    || snapshot.open_signal_pid == Some(pid)
                    || snapshot.embedded_visible
            }
        };
        if needs_update {
            update_snapshot(&app, &state, |snapshot| {
                if state.generation.load(Ordering::SeqCst) == generation
                    && snapshot.child_pid == Some(pid)
                {
                    apply_renderer_status(snapshot, pid, status);
                }
            });
        }
        #[cfg(target_os = "macos")]
        if status.ready && state.snapshot.lock().unwrap().open_request_pending {
            if let Err(error) = signal_pending_panel_open(&app, &state) {
                append_log(&state, &format!("Panel open signal failed: {error}"));
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn send_injector_control_request(
    state: &LauncherState,
    action: &str,
) -> Result<RendererStatus, String> {
    let runtime_path = state.data_directory.join("launcher-runtime.json");
    let descriptor: RuntimeDescriptor =
        serde_json::from_slice(&fs::read(&runtime_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let child_pid = state
        .child
        .lock()
        .unwrap()
        .ok_or_else(|| "Panel 服务尚未启动".to_string())?;
    if descriptor.version != Some(2) || descriptor.pid != Some(child_pid) {
        return Err("Panel 控制信息与当前服务不匹配".into());
    }
    let expected_socket = state.data_directory.join(".codex-panel.sock");
    let control_socket = descriptor
        .control_socket
        .as_deref()
        .filter(|path| *path == expected_socket)
        .ok_or_else(|| "Panel 控制通道不是受管路径".to_string())?;
    let startup_token = descriptor
        .startup_token
        .as_deref()
        .filter(|token| {
            !token.is_empty()
                && token.len() <= 100
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(|| "Panel 启动 token 无效".to_string())?;
    let mut stream = UnixStream::connect(control_socket).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let mut request = serde_json::to_vec(&serde_json::json!({
        "action": action,
        "startupToken": startup_token,
    }))
    .map_err(|error| error.to_string())?;
    request.push(b'\n');
    stream
        .write_all(&request)
        .and_then(|_| stream.flush())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    let response: serde_json::Value =
        serde_json::from_str(&response).map_err(|error| error.to_string())?;
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let result = response.get("result");
        let status = RendererStatus {
            ready: result
                .and_then(|value| value.get("ready"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            page_visible: result
                .and_then(|value| value.get("status"))
                .and_then(|value| value.get("pageVisible"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        };
        if action == "open" && (!status.ready || !status.page_visible) {
            return Err("Panel injector 未确认页面实际可见".into());
        }
        Ok(status)
    } else {
        Err(response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Panel 控制请求失败")
            .to_string())
    }
}

#[cfg(target_os = "macos")]
fn query_renderer_status(state: &LauncherState) -> RendererStatus {
    send_injector_control_request(state, "status").unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn write_windows_control(state: &LauncherState, action: &str) -> Result<(), String> {
    let mut control = state.child_control.lock().unwrap();
    let control = control
        .as_mut()
        .ok_or_else(|| "Launcher control pipe is unavailable".to_string())?;
    control
        .write_all(format!("{action}\n").as_bytes())
        .and_then(|_| control.flush())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn query_renderer_status(state: &LauncherState) -> RendererStatus {
    let requested_at = Instant::now();
    if write_windows_control(state, "status").is_err() {
        return RendererStatus::default();
    }
    let deadline = requested_at + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Some((received_at, status)) = *state.renderer_status.lock().unwrap() {
            if received_at >= requested_at {
                return status;
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    RendererStatus::default()
}

#[cfg(target_os = "windows")]
fn signal_pending_panel_open(app: &AppHandle, state: &Arc<LauncherState>) -> Result<(), String> {
    let snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    drop(snapshot);
    let result = write_windows_control(state, "open");
    if result.is_err() {
        let mut snapshot = state.snapshot.lock().unwrap();
        snapshot.open_signal_pid = None;
    }
    update_snapshot(app, state, |_| {});
    result
}

fn wait_for_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_group_is_running(pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn terminate_process_group(pid: u32) {
    send_process_group_signal(pid, libc::SIGTERM);
    if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn terminate_process_group(pid: u32) {
    if process_group_is_running(pid) {
        let _ = StdCommand::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stop_launcher_process_group(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    if !wait_for_process_group_exit(pid, LAUNCHER_STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn stop_launcher_process_group(pid: u32) {
    terminate_process_group(pid);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("/bin/ps")
        .args(["-p", &record.pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    let command = command.trim_start();
    command.starts_with(&*record.node_path.to_string_lossy())
        && command.contains(&*record.injector_path.to_string_lossy())
}

#[cfg(target_os = "windows")]
fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').CommandLine",
                record.pid
            ),
        ])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    command.contains(&*record.node_path.to_string_lossy())
        && command.contains(r"scripts\codex-injector.mjs")
}

fn stop_recorded_child(state: &LauncherState) {
    let record = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok());
    if let Some(record) = record {
        if process_matches_record(&record) {
            stop_launcher_process_group(record.pid);
        }
    }
    let _ = fs::remove_file(&state.pid_record_path);
}

fn write_pid_record(
    state: &LauncherState,
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
) -> Result<(), String> {
    let record = LauncherPidRecord {
        pid,
        node_path,
        injector_path,
    };
    let content = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    fs::write(&state.pid_record_path, content).map_err(|error| error.to_string())
}

fn clear_pid_record(state: &LauncherState, pid: u32) {
    let matches = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok())
        .is_some_and(|record| record.pid == pid);
    if matches {
        let _ = fs::remove_file(&state.pid_record_path);
    }
}

fn stop_managed_child_locked(app: &AppHandle, state: &Arc<LauncherState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.intentional_stop.store(true, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    if let Some(mut control) = state.child_control.lock().unwrap().take() {
        let _ = control.write_all(b"stop\n").and_then(|_| control.flush());
    }
    if let Some(pid) = state.child.lock().unwrap().take() {
        append_log(state, &format!("Stopping launcher child {pid}"));
        #[cfg(target_os = "windows")]
        if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
            terminate_process_group(pid);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        stop_launcher_process_group(pid);
        clear_pid_record(state, pid);
    }
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
        snapshot.open_signal_pid = None;
        snapshot.open_request_pending = false;
        snapshot.embedded_visible = false;
    });
}

fn stop_managed_child(app: &AppHandle, state: &Arc<LauncherState>) {
    let _lifecycle = state.lifecycle.lock().unwrap();
    stop_managed_child_locked(app, state);
}

fn watch_launcher_output<R: std::io::Read + Send + 'static>(
    reader: R,
    is_stderr: bool,
    app: AppHandle,
    state: Arc<LauncherState>,
    pid: u32,
    generation: u64,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            append_log(&state, &line);
            if is_stderr && line.contains("Panel service remains available") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        apply_waiting_for_codex(snapshot);
                    }
                });
            } else if is_stderr && line.contains("Waiting for Codex") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        apply_waiting_for_codex(snapshot);
                    }
                });
            } else if !is_stderr && line.contains("Codex Panel listening") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
                    }
                });
            } else if !is_stderr && line.contains("\"panelServiceReady\":true") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "waiting".into();
                        snapshot.message = "Panel 服务已启动，正在等待 Codex 连接。".into();
                    }
                });
            } else if !is_stderr && line.contains("\"openPanelSignalReady\":true") {
                let snapshot = update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.open_signal_pid = Some(pid);
                    }
                });
                if snapshot.child_pid == Some(pid) && snapshot.open_signal_pid == Some(pid) {
                    if let Err(error) = signal_pending_panel_open(&app, &state) {
                        append_log(&state, &format!("Panel open signal failed: {error}"));
                    }
                }
            } else if !is_stderr && line.contains("\"openPanelSignalOpened\":true") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.open_request_pending = false;
                        snapshot.embedded_visible = true;
                    }
                });
            } else if !is_stderr && line.contains("\"panelManagedStatus\"") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    let status = value.get("panelManagedStatus");
                    let renderer_status = RendererStatus {
                        ready: status
                            .and_then(|value| value.get("ready"))
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        page_visible: status
                            .and_then(|value| value.get("pageVisible"))
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                    };
                    #[cfg(target_os = "windows")]
                    {
                        *state.renderer_status.lock().unwrap() =
                            Some((Instant::now(), renderer_status));
                    }
                    update_snapshot(&app, &state, |snapshot| {
                        if state.generation.load(Ordering::SeqCst) == generation
                            && snapshot.child_pid == Some(pid)
                        {
                            apply_renderer_status(snapshot, pid, renderer_status);
                        }
                    });
                }
            } else if !is_stderr && line.contains("\"panelManagedReady\":true") {
                let snapshot = update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        apply_renderer_status(
                            snapshot,
                            pid,
                            RendererStatus {
                                ready: true,
                                page_visible: snapshot.embedded_visible,
                            },
                        );
                    }
                });
                if snapshot.child_pid == Some(pid) && snapshot.open_signal_pid == Some(pid) {
                    if let Err(error) = signal_pending_panel_open(&app, &state) {
                        append_log(&state, &format!("Panel open signal failed: {error}"));
                    }
                }
            }
        }
    });
}

fn start_launcher_locked(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    should_open: bool,
) -> Result<LauncherSnapshot, String> {
    if state.child.lock().unwrap().is_some() {
        if should_open {
            open_panel(app, state)?;
        }
        return Ok(state.snapshot.lock().unwrap().clone());
    }

    let home_directory = app.path().home_dir().map_err(|error| error.to_string())?;
    let codex_app = find_codex_app(&home_directory).ok_or_else(missing_codex_app_message)?;
    verify_codex_app(&codex_app)?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join(if cfg!(target_os = "windows") {
            "node.exe"
        } else if cfg!(target_os = "linux") {
            "codex-panel-node"
        } else {
            "node"
        });
    verify_launcher_runtime(&resource_directory, &node_path)?;
    stop_recorded_child(state);
    let codex_profile = state.data_directory.join("codex-profile");
    #[cfg(target_os = "macos")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app)?;
    #[cfg(target_os = "windows")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app, &codex_profile)?;
    #[cfg(target_os = "linux")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app, &codex_profile)?;
    if let Some(codex_pid) = ordinary_codex_pid {
        let restart = app
            .dialog()
            .message("需要重新启动 Codex 才能显示任务面板")
            .title("Codex Panel")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "重新启动 Codex".into(),
                "取消".into(),
            ))
            .blocking_show();
        if !restart {
            append_log(state, "Codex restart canceled by user");
            return Ok(update_snapshot(app, state, |snapshot| {
                snapshot.phase = "stopped".into();
                snapshot.message = "已取消重新启动 Codex，任务面板未注入。".into();
                snapshot.app_path = Some(codex_app.display().to_string());
                snapshot.open_signal_pid = None;
                snapshot.open_request_pending = false;
            }));
        }
        append_log(
            state,
            &format!("Requesting normal Codex exit for PID {codex_pid}"),
        );
        quit_codex_normally(codex_pid)?;
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
        snapshot.open_signal_pid = None;
        snapshot.embedded_visible = false;
    });

    #[cfg(target_os = "macos")]
    let path_value = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        resource_directory.join("bin").display()
    );
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let path_value = {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        std::env::join_paths(
            std::iter::once(resource_directory.join("bin"))
                .chain(std::env::split_paths(&current_path)),
        )
        .map_err(|error| error.to_string())?
    };
    let (_panel_listener_fd, panel_port) = panel_listener(state)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let codex_port = codex_port(state)?.to_string();
    let instance_token = Uuid::new_v4().to_string();
    let instance_secret = Uuid::new_v4().to_string();
    let version = state.snapshot.lock().unwrap().version.clone();
    #[cfg(target_os = "macos")]
    let codex_source_profile = home_directory.join("Library/Application Support/Codex");
    #[cfg(target_os = "windows")]
    let codex_source_profile = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA is unavailable".to_string())?
        .join("Codex/web/Codex");
    #[cfg(target_os = "linux")]
    let codex_source_profile = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_directory.join(".config"))
        .join("Codex");
    let mut command = StdCommand::new(&node_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW.0);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    command.arg(&injector_path);
    #[cfg(target_os = "windows")]
    command.arg(&injector_path);
    #[cfg(target_os = "macos")]
    command.args([
        "--launch",
        "--watch",
        "--attach-existing",
        "--port",
        &codex_port,
    ]);
    #[cfg(target_os = "windows")]
    command.args(["--launch", "--watch", "--port", &codex_port]);
    #[cfg(target_os = "linux")]
    command.args(["--launch", "--watch", "--cdp-pipe"]);
    if should_open {
        command.arg("--open");
    }
    command
        .args(["--startup-token", &instance_token, "--app-path"])
        .arg(&codex_app)
        .env_clear()
        .envs(sanitized_process_environment())
        .env("CODEX_PANEL_DATA_DIR", &state.data_directory)
        .env(
            "CODEX_PANEL_RUNTIME_FILE",
            state.data_directory.join("launcher-runtime.json"),
        )
        .env("CODEX_PANEL_HOST", "127.0.0.1")
        .env("CODEX_PANEL_PORT", panel_port.to_string())
        .env("CODEX_PANEL_INSTANCE_TOKEN", &instance_token)
        .env("CODEX_PANEL_INSTANCE_SECRET", &instance_secret)
        .env("CODEX_PANEL_VERSION", &version)
        .env(
            "CODEX_PANEL_CODEX_PROFILE",
            codex_profile.to_string_lossy().as_ref(),
        )
        .env(
            "CODEX_PANEL_CODEX_SOURCE_PROFILE",
            codex_source_profile.to_string_lossy().as_ref(),
        )
        .env("HOST", "127.0.0.1")
        .env("PATH", path_value)
        .current_dir(&app_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.stdin(Stdio::piped());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    unsafe {
        let panel_listener_fd = _panel_listener_fd.unwrap();
        command
            .env("CODEX_PANEL_LISTEN_FD", PANEL_LISTEN_FD.to_string())
            .process_group(0);
        command.pre_exec(move || {
            if libc::dup2(panel_listener_fd, PANEL_LISTEN_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(PANEL_LISTEN_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    #[cfg(target_os = "windows")]
    let child_control = child.stdin.take();
    if let Err(error) = write_pid_record(state, pid, node_path, injector_path) {
        terminate_process_group(pid);
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(pid);
    #[cfg(target_os = "windows")]
    {
        *state.child_control.lock().unwrap() = child_control;
    }
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Panel {panel_port} with preferred Codex CDP {codex_port}"
        ),
    );
    #[cfg(target_os = "linux")]
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Panel {panel_port} with a private Codex CDP pipe"
        ),
    );
    if let Some(stdout) = stdout {
        watch_launcher_output(stdout, false, app.clone(), state.clone(), pid, generation);
    }
    if let Some(stderr) = stderr {
        watch_launcher_output(stderr, true, app.clone(), state.clone(), pid, generation);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    monitor_renderer_readiness(app.clone(), state.clone(), pid, generation);

    let event_app = app.clone();
    let event_state = state.clone();
    thread::spawn(move || {
        let status = child.wait();
        let recovery_token = {
            let mut current_child = event_state.child.lock().unwrap();
            if *current_child != Some(pid) {
                None
            } else {
                let recovery_token = generation + 1;
                if event_state
                    .generation
                    .compare_exchange(
                        generation,
                        recovery_token,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    *current_child = None;
                    Some(recovery_token)
                } else {
                    None
                }
            }
        };
        #[cfg(target_os = "windows")]
        if recovery_token.is_some() {
            let _ = event_state.child_control.lock().unwrap().take();
        }
        let Some(recovery_token) = recovery_token else {
            append_log(
                &event_state,
                &format!("Launcher child {pid} exited: {status:?}"),
            );
            terminate_process_group(pid);
            return;
        };
        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
        update_snapshot(&event_app, &event_state, |snapshot| {
            if event_state.generation.load(Ordering::SeqCst) == recovery_token
                && snapshot.child_pid == Some(pid)
            {
                snapshot.child_pid = None;
                snapshot.open_signal_pid = None;
                snapshot.embedded_visible = false;
                if !intentional {
                    snapshot.phase = "error".into();
                    snapshot.message = "任务面板进程已退出，正在恢复…".into();
                }
            }
        });
        append_log(
            &event_state,
            &format!("Launcher child {pid} exited: {status:?}"),
        );
        terminate_process_group(pid);
        clear_pid_record(&event_state, pid);
        if intentional {
            return;
        }
        let Some(recovery_delay) = next_recovery_delay(&event_state) else {
            append_log(
                &event_state,
                "Launcher recovery stopped after four failures within 60 seconds",
            );
            update_snapshot(&event_app, &event_state, |snapshot| {
                snapshot.phase = "error".into();
                snapshot.message = "任务面板在 60 秒内连续退出，已停止自动恢复。".into();
            });
            return;
        };
        thread::sleep(recovery_delay);
        let (recovery_result, recovery_generation) = {
            let _lifecycle = event_state.lifecycle.lock().unwrap();
            if event_state.generation.load(Ordering::SeqCst) != recovery_token
                || event_state.intentional_stop.load(Ordering::SeqCst)
            {
                return;
            }
            let result = start_launcher_locked(&event_app, &event_state, false);
            let generation = event_state.generation.load(Ordering::SeqCst);
            (result, generation)
        };
        if let Err(error) = recovery_result {
            append_log(&event_state, &format!("Launcher recovery failed: {error}"));
            update_snapshot(&event_app, &event_state, |snapshot| {
                if event_state.generation.load(Ordering::SeqCst) == recovery_generation
                    && snapshot.child_pid.is_none()
                {
                    snapshot.phase = "error".into();
                    snapshot.message = error.clone();
                    snapshot.open_signal_pid = None;
                }
            });
            show_error_dialog(
                &event_app,
                "Codex Panel 恢复失败",
                &format!("任务面板进程无法恢复：{error}\n\n请重新打开 App。"),
            );
        }
    });
    Ok(snapshot)
}

fn start_launcher(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    should_open: bool,
) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    reset_recovery(state);
    start_launcher_locked(app, state, should_open)
}

fn restart_launcher(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    let (result, result_generation) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        stop_managed_child_locked(app, state);
        reset_recovery(state);
        let result = start_launcher_locked(app, state, false);
        if result.is_err() {
            state.intentional_stop.store(false, Ordering::SeqCst);
        }
        let generation = state.generation.load(Ordering::SeqCst);
        (result, generation)
    };
    if let Err(error) = &result {
        let error = error.clone();
        update_snapshot(app, state, |snapshot| {
            if state.generation.load(Ordering::SeqCst) == result_generation
                && snapshot.child_pid.is_none()
            {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板启动失败：{error}");
                snapshot.open_signal_pid = None;
            }
        });
    }
    result
}

fn open_panel(app: &AppHandle, state: &Arc<LauncherState>) -> Result<(), String> {
    update_snapshot(app, state, |snapshot| {
        snapshot.open_request_pending = true;
    });
    match signal_pending_panel_open(app, state) {
        Ok(()) => Ok(()),
        Err(error)
            if state.child.lock().unwrap().is_some()
                && state.snapshot.lock().unwrap().open_request_pending =>
        {
            append_log(
                state,
                &format!("Panel open request queued after control retry: {error}"),
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn current_ui_state(app: &AppHandle, state: &LauncherState) -> Result<LauncherUiState, String> {
    Ok(LauncherUiState {
        snapshot: state.snapshot.lock().unwrap().clone(),
        preferences: *state.preferences.lock().unwrap(),
        autostart: app
            .autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())?,
        log_path: state.log_path.display().to_string(),
        data_directory: state.data_directory.display().to_string(),
    })
}

#[tauri::command]
fn launcher_ui_state(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<LauncherUiState, String> {
    current_ui_state(&app, &state)
}

#[tauri::command]
async fn start_service(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<LauncherUiState, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let should_open = state.preferences.lock().unwrap().auto_open_panel;
        start_launcher(&app, &state, should_open)?;
        current_ui_state(&app, &state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn stop_service(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<LauncherUiState, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        stop_managed_child(&app, &state);
        current_ui_state(&app, &state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reconnect_codex(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<LauncherUiState, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        restart_launcher(&app, &state)?;
        current_ui_state(&app, &state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_embedded_panel(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if state.child.lock().unwrap().is_some() {
            open_panel(&app, &state)
        } else {
            start_launcher(&app, &state, true).map(|_| ())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_browser_panel(state: State<'_, Arc<LauncherState>>) -> Result<(), String> {
    panel_browser_url(&state).and_then(|url| open_with_system(&url))
}

#[tauri::command]
fn open_log(state: State<'_, Arc<LauncherState>>) -> Result<(), String> {
    open_with_system(&state.log_path.to_string_lossy())
}

#[tauri::command]
fn reveal_data(state: State<'_, Arc<LauncherState>>) -> Result<(), String> {
    open_with_system(&state.data_directory.to_string_lossy())
}

#[tauri::command]
fn set_launcher_preference(
    state: State<'_, Arc<LauncherState>>,
    key: String,
    enabled: bool,
) -> Result<LauncherPreferences, String> {
    if !matches!(key.as_str(), "autoConnectCodex" | "autoOpenPanel") {
        return Err("未知的偏好设置".to_string());
    }
    update_preferences(&state, |preferences| match key.as_str() {
        "autoConnectCodex" => preferences.auto_connect_codex = enabled,
        "autoOpenPanel" => preferences.auto_open_panel = enabled,
        _ => unreachable!(),
    })
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|error| error.to_string())?;
    manager.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_for_updates(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    offer_update(&app, &state, false, false).await
}

#[tauri::command]
fn open_available_release(state: State<'_, Arc<LauncherState>>) -> Result<(), String> {
    let url = state
        .snapshot
        .lock()
        .unwrap()
        .update_url
        .clone()
        .ok_or_else(|| "当前没有可打开的更新版本".to_string())?;
    open_with_system(&url)
}

async fn offer_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    show_result: bool,
    use_cache: bool,
) -> Result<(), String> {
    if state
        .update_flow_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("更新检查正在进行中，请稍候。".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cache_path = state.data_directory.join("update-check.json");
    let cached = use_cache
        .then(|| cached_release_check(&cache_path, now))
        .flatten();
    if cached.is_none() {
        update_snapshot(app, state, |snapshot| {
            snapshot.update_message = "正在检查更新…".into();
            snapshot.update_available = false;
            snapshot.update_url = None;
        });
    }
    let version = state.snapshot.lock().unwrap().version.clone();
    let used_cache = cached.is_some();
    let check_result = match cached {
        Some(result) => result,
        None => {
            let result = check_fork_release(&version).await;
            if let Err(error) = write_release_check_cache(&cache_path, now, &result) {
                append_log(state, &format!("Update cache write failed: {error}"));
            }
            result
        }
    };
    let result = match check_result {
        Ok(ReleaseCheckResult::None) => {
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "Fork 暂无已发布版本。".into();
            });
            if show_result {
                app.dialog()
                    .message("Fork 暂无已发布版本。")
                    .title("Codex Panel 更新")
                    .buttons(MessageDialogButtons::Ok)
                    .blocking_show();
            }
            Ok(())
        }
        Ok(ReleaseCheckResult::Current) => {
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "当前已是最新版本。".into();
            });
            if show_result {
                app.dialog()
                    .message("当前已是最新版本。")
                    .title("Codex Panel 更新")
                    .buttons(MessageDialogButtons::Ok)
                    .blocking_show();
            }
            Ok(())
        }
        Ok(ReleaseCheckResult::Available { version, url }) => {
            append_log(state, &format!("Fork release {version} is available"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message =
                    format!("发现新版本 {version}。需从 Fork Release 手动安装。");
                snapshot.update_available = true;
                snapshot.update_url = Some(url.clone());
            });
            if show_result
                && app
                    .dialog()
                    .message(format!(
                        "发现 Codex Panel {version}。是否打开 Fork Release 页面？"
                    ))
                    .title("Codex Panel 更新")
                    .buttons(MessageDialogButtons::YesNo)
                    .blocking_show()
            {
                if let Err(error) = open_with_system(&url) {
                    show_error_dialog(app, "Codex Panel 更新", &error);
                }
            }
            Ok(())
        }
        Err(error) => {
            let error = error.message(now, used_cache);
            append_log(state, &format!("Update check failed: {error}"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新检查失败：{error}");
                snapshot.update_available = false;
                snapshot.update_url = None;
            });
            if show_result {
                show_error_dialog(
                    app,
                    "Codex Panel 更新检查失败",
                    &format!("无法检查更新。\n\n{error}"),
                );
            }
            Err(error)
        }
    };
    state.update_flow_in_progress.store(false, Ordering::SeqCst);
    result
}

fn main() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            launcher_ui_state,
            start_service,
            stop_service,
            reconnect_codex,
            open_embedded_panel,
            open_browser_panel,
            open_log,
            reveal_data,
            set_launcher_preference,
            set_autostart,
            check_for_updates,
            open_available_release,
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    #[cfg(target_os = "macos")]
                    WindowEvent::ThemeChanged(theme) => {
                        let _ = set_application_icon(*theme);
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(ActivationPolicy::Regular);
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(theme) = window.theme() {
                        let _ = set_application_icon(theme);
                    }
                }
            }
            let home_directory = app.path().home_dir()?;
            #[cfg(target_os = "macos")]
            let support_root = home_directory.join("Library/Application Support/Codex Panel");
            #[cfg(target_os = "macos")]
            let log_path = home_directory.join("Library/Logs/Codex Panel.log");
            #[cfg(target_os = "windows")]
            let support_root = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| std::io::Error::other("LOCALAPPDATA is unavailable"))?
                .join("Codex Panel");
            #[cfg(target_os = "windows")]
            let log_path = support_root.join("Logs/codex-panel-launcher.log");
            #[cfg(target_os = "linux")]
            let support_root = std::env::var_os("XDG_DATA_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/share"))
                .join("Codex Panel");
            #[cfg(target_os = "linux")]
            let log_path = std::env::var_os("XDG_STATE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/state"))
                .join("Codex Panel/codex-panel-launcher.log");
            let data_directory = support_root.join("data");
            let preferences_path = support_root.join("preferences.json");
            let preferences = read_preferences(&preferences_path).map_err(std::io::Error::other)?;
            fs::create_dir_all(&data_directory)?;
            if let Some(parent) = log_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let Some(instance_lock) = acquire_instance_lock(&support_root.join("launcher.lock"))?
            else {
                app.handle().exit(0);
                return Ok(());
            };
            let version = app.package_info().version.to_string();
            let state = Arc::new(LauncherState::new(
                data_directory,
                log_path,
                preferences_path,
                preferences,
                version.clone(),
                instance_lock,
            ));
            app.manage(state.clone());

            let app_info = MenuItem::with_id(
                app,
                "app-info",
                format!("{} - {version}", app.package_info().name),
                false,
                None::<&str>,
            )?;
            let launcher_status = MenuItem::with_id(
                app,
                "launcher-status",
                "运行状态：启动中",
                false,
                None::<&str>,
            )?;
            *state.status_menu.lock().unwrap() = Some(launcher_status.clone());
            let show_window =
                MenuItem::with_id(app, "show-window", "打开管理窗口", true, None::<&str>)?;
            let open_panel_item =
                MenuItem::with_id(app, "open-panel", "打开内嵌 Panel", true, None::<&str>)?;
            let open_browser =
                MenuItem::with_id(app, "open-browser", "在浏览器中打开", false, None::<&str>)?;
            let service_control =
                MenuItem::with_id(app, "service-control", "启动服务", true, None::<&str>)?;
            let check_update =
                MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
            let restart_service =
                MenuItem::with_id(app, "restart-service", "重启服务", false, None::<&str>)?;
            let open_log = MenuItem::with_id(app, "open-log", "打开运行日志", true, None::<&str>)?;
            let reveal_data =
                MenuItem::with_id(app, "reveal-data", "打开数据目录", true, None::<&str>)?;
            let auto_connect = CheckMenuItem::with_id(
                app,
                "auto-connect",
                "启动时连接 Codex",
                true,
                preferences.auto_connect_codex,
                None::<&str>,
            )?;
            let auto_open = CheckMenuItem::with_id(
                app,
                "auto-open",
                "连接后自动打开 Panel",
                true,
                preferences.auto_open_panel,
                None::<&str>,
            )?;
            let autostart_enabled = app.autolaunch().is_enabled()?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机自启动",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            *state.service_control_menu.lock().unwrap() = Some(service_control.clone());
            *state.restart_service_menu.lock().unwrap() = Some(restart_service.clone());
            *state.open_browser_menu.lock().unwrap() = Some(open_browser.clone());
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let separator_one = PredefinedMenuItem::separator(app)?;
            let separator_two = PredefinedMenuItem::separator(app)?;
            let separator_three = PredefinedMenuItem::separator(app)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &app_info,
                    &launcher_status,
                    &separator_one,
                    &show_window,
                    &open_panel_item,
                    &open_browser,
                    &service_control,
                    &restart_service,
                    &open_log,
                    &reveal_data,
                    &separator_two,
                    &auto_connect,
                    &auto_open,
                    &autostart,
                    &check_update,
                    &separator_three,
                    &quit,
                ],
            )?;
            let autostart_menu = autostart.clone();
            let auto_connect_menu = auto_connect.clone();
            let auto_open_menu = auto_open.clone();
            let autostart_confirmed = Arc::new(AtomicBool::new(autostart_enabled));
            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray-codex.png"))
                .icon_as_template(true)
                .tooltip("Codex Panel")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show-window" => {
                        if let Err(error) = show_main_window(app) {
                            show_error_dialog(app, "Codex Panel 打开失败", &error);
                        }
                    }
                    "check-update" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = offer_update(&app, &state, true, false).await;
                        });
                    }
                    "open-panel" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let running = state.child.lock().unwrap().is_some();
                            let result = if running {
                                open_panel(&app, &state)
                            } else {
                                start_launcher(&app, &state, true).map(|_| ())
                            };
                            if let Err(error) = result {
                                append_log(&state, &format!("Launcher menu open failed: {error}"));
                                show_error_dialog(
                                    &app,
                                    "Codex Panel 打开失败",
                                    &format!("{error}\n\n请确认 Codex 正在运行。"),
                                );
                            }
                        });
                    }
                    "open-browser" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        match panel_browser_url(&state).and_then(|url| open_with_system(&url)) {
                            Ok(()) => {}
                            Err(error) => show_error_dialog(
                                app,
                                "Codex Panel 打开失败",
                                &format!("{error}\n\n请先启动 Panel 服务。"),
                            ),
                        }
                    }
                    "service-control" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if state.child.lock().unwrap().is_some() {
                                stop_managed_child(&app, &state);
                            } else {
                                let should_open = state.preferences.lock().unwrap().auto_open_panel;
                                if let Err(error) = start_launcher(&app, &state, should_open) {
                                    show_error_dialog(&app, "Codex Panel 启动失败", &error);
                                }
                            }
                        });
                    }
                    "restart-service" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = restart_launcher(&app, &state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu restart failed: {error}"),
                                );
                                show_error_dialog(
                                    &app,
                                    "Codex Panel 启动失败",
                                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                                );
                            }
                        });
                    }
                    "open-log" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let _ = OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&state.log_path);
                        if let Err(error) = open_with_system(&state.log_path.to_string_lossy()) {
                            show_error_dialog(app, "Codex Panel 日志", &error);
                        }
                    }
                    "reveal-data" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        if let Err(error) =
                            open_with_system(&state.data_directory.to_string_lossy())
                        {
                            show_error_dialog(app, "Codex Panel 数据目录", &error);
                        }
                    }
                    "auto-connect" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let current = state.preferences.lock().unwrap().auto_connect_codex;
                        match update_preferences(&state, |value| {
                            value.auto_connect_codex = !current;
                        }) {
                            Ok(preferences) => auto_connect_menu
                                .set_checked(preferences.auto_connect_codex)
                                .unwrap(),
                            Err(error) => {
                                auto_connect_menu.set_checked(current).unwrap();
                                show_error_dialog(app, "Codex Panel 设置失败", &error);
                            }
                        }
                    }
                    "auto-open" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let current = state.preferences.lock().unwrap().auto_open_panel;
                        match update_preferences(&state, |value| {
                            value.auto_open_panel = !current;
                        }) {
                            Ok(preferences) => auto_open_menu
                                .set_checked(preferences.auto_open_panel)
                                .unwrap(),
                            Err(error) => {
                                auto_open_menu.set_checked(current).unwrap();
                                show_error_dialog(app, "Codex Panel 设置失败", &error);
                            }
                        }
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        let previous = autostart_confirmed.load(Ordering::SeqCst);
                        let mut confirmed_before = previous;
                        let operation_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                confirmed_before = enabled;
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                let result = if enabled {
                                    manager.disable()
                                } else {
                                    manager.enable()
                                };
                                result.err().map(|error| error.to_string())
                            }
                            Err(error) => Some(error.to_string()),
                        };
                        let sync_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                autostart_menu.set_checked(enabled).unwrap();
                                None
                            }
                            Err(error) => {
                                autostart_menu.set_checked(confirmed_before).unwrap();
                                autostart_confirmed.store(confirmed_before, Ordering::SeqCst);
                                Some(error.to_string())
                            }
                        };
                        if let Some(error) = operation_error.or(sync_error) {
                            show_error_dialog(app, "Codex Panel 自启动设置失败", &error);
                        }
                    }
                    "quit" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let lifecycle = state.lifecycle.lock().unwrap();
                        stop_managed_child_locked(app, &state);
                        drop(lifecycle);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let preferences = *state.preferences.lock().unwrap();
                if preferences.auto_connect_codex {
                    if let Err(error) =
                        start_launcher(&app_handle, &state, preferences.auto_open_panel)
                    {
                        append_log(&state, &format!("Launcher startup failed: {error}"));
                        update_snapshot(&app_handle, &state, |snapshot| {
                            snapshot.phase = "error".into();
                            snapshot.message = error.clone();
                        });
                        show_error_dialog(
                            &app_handle,
                            "Codex Panel 启动失败",
                            &format!(
                                "{error}\n\n请确认官方 Codex/ChatGPT App 已安装。详情见启动日志。"
                            ),
                        );
                    }
                } else {
                    update_snapshot(&app_handle, &state, |snapshot| {
                        snapshot.phase = "stopped".into();
                        snapshot.message = "自动连接已关闭。".into();
                    });
                }
                let _ = offer_update(&app_handle, &state, false, true).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Codex Panel");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main_window(app_handle) {
                show_error_dialog(app_handle, "Codex Panel 打开失败", &error);
            }
        }
        tauri::RunEvent::ExitRequested { .. } => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                let _lifecycle = state.lifecycle.lock().unwrap();
                stop_managed_child_locked(app_handle, &state);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                stop_managed_child(app_handle, &state);
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                unsafe {
                    libc::flock(state._instance_lock.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{
        apply_renderer_status, apply_waiting_for_codex, cached_release_check,
        github_api_error_message, process_environment_key_is_blocked, sha256_file,
        status_menu_label, trusted_panel_browser_url, verify_runtime_integrity,
        write_release_check_cache, LauncherSnapshot, ReleaseCheckFailure, ReleaseCheckResult,
        RendererStatus,
    };
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::{env, fs};
    use uuid::Uuid;

    #[test]
    fn github_rate_limit_error_includes_the_retry_delay() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-ratelimit-remaining",
            reqwest::header::HeaderValue::from_static("0"),
        );
        headers.insert(
            "x-ratelimit-reset",
            reqwest::header::HeaderValue::from_static("1120"),
        );
        assert_eq!(
            github_api_error_message(reqwest::StatusCode::FORBIDDEN, &headers, 1000)
                .message(1000, false),
            "GitHub 匿名 API 请求额度已用完，请在约 2 分钟后重试。"
        );
        assert_eq!(
            github_api_error_message(reqwest::StatusCode::FORBIDDEN, &headers, 1000)
                .message(1200, true),
            "上次自动检查失败，可手动重试：GitHub 匿名 API 请求额度已用完，请稍后重试。"
        );
    }

    #[test]
    fn browser_url_keeps_the_private_local_panel_route() {
        let url = "http://127.0.0.1:47824/01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(trusted_panel_browser_url(url).unwrap(), url);
        assert!(trusted_panel_browser_url("http://127.0.0.1:47824/").is_err());
        assert!(trusted_panel_browser_url(
            "https://example.com/01234567-89ab-cdef-0123-456789abcdef"
        )
        .is_err());
    }

    #[test]
    fn waiting_status_has_its_own_menu_label() {
        assert_eq!(status_menu_label("waiting"), "运行状态：等待 Codex");
        assert_eq!(status_menu_label("starting"), "运行状态：启动中");
    }

    #[test]
    fn renderer_readiness_downgrades_without_losing_a_pending_open() {
        let mut snapshot = LauncherSnapshot {
            phase: "waiting".into(),
            message: String::new(),
            update_message: String::new(),
            update_available: false,
            update_url: None,
            version: "0.1.0".into(),
            app_path: None,
            child_pid: Some(42),
            open_signal_pid: None,
            open_request_pending: true,
            embedded_visible: false,
        };
        apply_renderer_status(
            &mut snapshot,
            42,
            RendererStatus {
                ready: true,
                page_visible: false,
            },
        );
        assert_eq!(snapshot.phase, "running");
        assert_eq!(snapshot.open_signal_pid, Some(42));
        assert!(!snapshot.embedded_visible);
        apply_renderer_status(&mut snapshot, 42, RendererStatus::default());
        assert_eq!(snapshot.phase, "waiting");
        assert_eq!(snapshot.open_signal_pid, None);
        assert!(snapshot.open_request_pending);
    }

    #[test]
    fn waiting_for_codex_hides_embedded_panel_but_keeps_linux_open_signal() {
        let mut snapshot = LauncherSnapshot {
            phase: "running".into(),
            message: String::new(),
            update_message: String::new(),
            update_available: false,
            update_url: None,
            version: "0.1.0".into(),
            app_path: None,
            child_pid: Some(42),
            open_signal_pid: Some(42),
            open_request_pending: false,
            embedded_visible: true,
        };

        apply_waiting_for_codex(&mut snapshot);

        assert_eq!(snapshot.phase, "waiting");
        assert_eq!(snapshot.open_signal_pid, Some(42));
        assert!(!snapshot.embedded_visible);
    }

    #[cfg(unix)]
    #[test]
    fn launcher_runtime_rejects_symbolic_links() {
        let root = env::temp_dir().join(format!("codex-panel-runtime-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("runtime.mjs"), "export {};\n").unwrap();
        symlink(root.join("runtime.mjs"), root.join("linked-runtime.mjs")).unwrap();
        let error = super::reject_runtime_symlinks(&root).unwrap_err();
        assert!(error.contains("拒绝运行符号链接"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn windows_environment_filter_is_case_insensitive() {
        assert!(process_environment_key_is_blocked("Node_Options", true));
        assert!(process_environment_key_is_blocked(
            "dyld_insert_libraries",
            true
        ));
        assert!(process_environment_key_is_blocked(
            "codex_panel_instance_secret",
            true
        ));
        assert!(!process_environment_key_is_blocked("Node_Options", false));
        assert!(!process_environment_key_is_blocked("PATH", true));
    }

    #[test]
    fn runtime_integrity_rejects_modified_and_unlisted_runtime_files() {
        let root = env::temp_dir().join(format!("codex-panel-integrity-{}", Uuid::new_v4()));
        let injector = root.join("app/scripts/codex-injector.mjs");
        let node = root.join("node");
        fs::create_dir_all(injector.parent().unwrap()).unwrap();
        fs::write(&injector, "export {};\n").unwrap();
        fs::write(&node, "node").unwrap();
        let manifest = serde_json::json!({
            "version": 1,
            "files": [
                { "path": "app/scripts/codex-injector.mjs", "sha256": sha256_file(&injector).unwrap() },
                { "path": "node", "sha256": sha256_file(&node).unwrap() },
            ],
        })
        .to_string();
        verify_runtime_integrity(&root, &node, &manifest).unwrap();

        fs::write(&injector, "tampered\n").unwrap();
        assert!(verify_runtime_integrity(&root, &node, &manifest).is_err());
        fs::write(&injector, "export {};\n").unwrap();
        fs::write(root.join("app/unlisted.mjs"), "export {};\n").unwrap();
        assert!(verify_runtime_integrity(&root, &node, &manifest).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn update_cache_uses_result_specific_expiry() {
        let path = env::temp_dir().join(format!("codex-panel-update-{}.json", Uuid::new_v4()));
        write_release_check_cache(&path, 1000, &Ok(ReleaseCheckResult::Current)).unwrap();
        assert!(cached_release_check(&path, 1000 + 23 * 60 * 60).is_some());

        write_release_check_cache(
            &path,
            1000,
            &Err(ReleaseCheckFailure::Message("temporary".into())),
        )
        .unwrap();
        assert!(cached_release_check(&path, 1299).is_some());
        assert!(cached_release_check(&path, 1300).is_none());

        write_release_check_cache(
            &path,
            1000,
            &Err(ReleaseCheckFailure::RateLimited {
                reset_at: Some(1120),
            }),
        )
        .unwrap();
        assert!(cached_release_check(&path, 1119).is_some());
        assert!(cached_release_check(&path, 1120).is_none());
        let _ = fs::remove_file(path);
    }
}
