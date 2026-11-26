use crate::ApiError;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::Mutex,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

fn error(message: impl Into<String>) -> ApiError {
    ApiError::new(502, "CODEX_UPDATE_FAILED", message)
}
fn official_url(value: &str) -> Result<url::Url, ApiError> {
    let url = url::Url::parse(value).map_err(|_| error("Codex 更新地址无效"))?;
    if url.scheme() != "https"
        || !["updates.oaistatic.com", "persistent.oaistatic.com"]
            .contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return Err(error("Codex 更新地址不是官方 HTTPS 地址"));
    }
    Ok(url)
}
fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|v| v.is_ascii_digit())
}
fn version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=5).contains(&parts.len()) && parts.iter().all(|v| digits(v))
}
fn cmp_build(left: &str, right: &str) -> std::cmp::Ordering {
    let l = left.trim_start_matches('0');
    let r = right.trim_start_matches('0');
    l.len().cmp(&r.len()).then_with(|| l.cmp(r))
}
fn system_at_least(current: &str, required: &str) -> Result<bool, ApiError> {
    if !version(current) || !version(required) {
        return Err(error("Codex 更新系统版本要求无效"));
    }
    let left = current.split('.').collect::<Vec<_>>();
    let right = required.split('.').collect::<Vec<_>>();
    for i in 0..left.len().max(right.len()) {
        match cmp_build(left.get(i).unwrap_or(&"0"), right.get(i).unwrap_or(&"0")) {
            std::cmp::Ordering::Equal => {}
            std::cmp::Ordering::Less => return Ok(false),
            _ => return Ok(true),
        }
    }
    Ok(true)
}
fn field<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .or_else(|| {
            node.children()
                .find(|n| n.is_element() && n.tag_name().name() == "enclosure")
                .and_then(|n| attribute(n, name))
        })
}
fn attribute<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == name)
        .map(|a| a.value())
}

fn document(xml: &str) -> Result<roxmltree::Document<'_>, ApiError> {
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(error("Codex 更新清单包含不允许的 XML 声明"));
    }
    let document =
        roxmltree::Document::parse(xml).map_err(|_| error("Codex 官方更新清单格式无效"))?;
    if document.root_element().tag_name().name() != "rss"
        || document
            .root_element()
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "channel")
            .count()
            != 1
    {
        return Err(error("Codex 官方更新清单格式无效"));
    }
    Ok(document)
}

#[derive(Clone)]
struct Archive {
    url: String,
    length: u64,
    signature: String,
    executable_size: Option<u64>,
    locales: Vec<String>,
}
fn select_archive(
    xml: &str,
    version: &str,
    build: &str,
    arch: &str,
    installed: &str,
) -> Result<Archive, ApiError> {
    let document = document(xml)?;
    let items = document
        .root_element()
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "channel")
        .unwrap()
        .children()
        .filter(|n| {
            n.is_element()
                && n.tag_name().name() == "item"
                && field(*n, "version") == Some(build)
                && field(*n, "shortVersionString") == Some(version)
        })
        .collect::<Vec<_>>();
    if items.len() != 1 {
        return Err(error("Codex 官方更新清单中的目标版本缺失或不唯一"));
    }
    if field(items[0], "hardwareRequirements")
        .is_some_and(|value| !value.is_empty() && value != arch)
    {
        return Err(error("Codex 官方更新安装包的架构不匹配"));
    }
    let deltas = items[0]
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "deltas")
        .flat_map(|n| n.children())
        .filter(|n| {
            n.is_element()
                && n.tag_name().name() == "enclosure"
                && attribute(*n, "deltaFrom") == Some(installed)
        })
        .collect::<Vec<_>>();
    if deltas.len() != 1 {
        return Err(error("官方未提供从当前 Codex 版本到目标版本的增量包"));
    }
    let delta = deltas[0];
    let url = official_url(attribute(delta, "url").unwrap_or(""))?;
    if !url.path().ends_with(".delta") {
        return Err(error("Codex 官方更新未提供有效的增量包"));
    }
    let length = attribute(delta, "length")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or_else(|| error("Codex 官方更新安装包大小无效"))?;
    let signature = attribute(delta, "edSignature").unwrap_or("").to_owned();
    if STANDARD
        .decode(&signature)
        .ok()
        .is_none_or(|v| v.len() != 64)
    {
        return Err(error("Codex 官方更新缺少有效的 Ed25519 签名"));
    }
    let executable_size = attribute(delta, "deltaFromSparkleExecutableSize")
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.parse::<u64>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| error("当前 Codex 与官方增量包的基础文件不匹配"))
        })
        .transpose()?;
    let locales = attribute(delta, "deltaFromSparkleLocales")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Archive {
        url: url.to_string(),
        length,
        signature,
        executable_size,
        locales,
    })
}

fn versions(xml: &str, arch: &str, system: &str, installed: &str) -> Result<Value, ApiError> {
    if !digits(installed) {
        return Err(error("当前 Codex 构建号无效"));
    }
    let document = document(xml)?;
    let mut versions = Vec::new();
    let mut newer = false;
    for item in document
        .root_element()
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "channel")
        .unwrap()
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "item")
    {
        if field(item, "hardwareRequirements").is_some_and(|v| !v.is_empty() && v != arch) {
            continue;
        }
        if let Some(required) = field(item, "minimumSystemVersion").filter(|v| !v.is_empty()) {
            if !system_at_least(system, required)? {
                continue;
            }
        }
        let build = field(item, "version").unwrap_or("");
        let release = field(item, "shortVersionString").unwrap_or("");
        if !digits(build) || !version(release) {
            return Err(error(
                "Codex 官方更新检查未提供完整的版本和构建号，请重新检查更新",
            ));
        }
        if cmp_build(build, installed) != std::cmp::Ordering::Greater {
            continue;
        }
        newer = true;
        let deltas = item
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "deltas")
            .flat_map(|n| n.children())
            .filter(|n| {
                n.is_element()
                    && n.tag_name().name() == "enclosure"
                    && attribute(*n, "deltaFrom") == Some(installed)
            })
            .count();
        if deltas == 1 {
            versions.push(json!({"version":release,"build":build,"verified":arch=="arm64"&&release=="26.1117.31558"&&build=="29513"}));
        }
    }
    versions.sort_by(|a, b| cmp_build(b["build"].as_str().unwrap(), a["build"].as_str().unwrap()));
    Ok(
        json!({"status":if !versions.is_empty(){"available"}else if newer{"no_delta"}else{"up_to_date"},"versions":versions,"appcastXml":xml}),
    )
}

async fn command(
    program: &Path,
    args: &[String],
    seconds: u64,
) -> Result<std::process::Output, ApiError> {
    command_cancel(program, args, seconds, None).await
}
async fn command_cancel(
    program: &Path,
    args: &[String],
    seconds: u64,
    cancel: Option<&CancellationToken>,
) -> Result<std::process::Output, ApiError> {
    let mut child = Command::new(program)
        .args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = tokio::spawn(async move {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        a?;
        b?;
        Ok::<_, std::io::Error>((out, err))
    });
    let waiting = tokio::time::timeout(Duration::from_secs(seconds), child.wait());
    let result = tokio::select! {
        status=waiting=>status.map_err(|_|error("Codex 更新验证命令超时")).and_then(|v|v.map_err(Into::into)),
        _=async {if let Some(cancel)=cancel{cancel.cancelled().await}else{std::future::pending::<()>().await}}=>Err(error("下载已取消")),
    };
    let status = match result {
        Ok(status) => status,
        Err(failure) => {
            let _ = child.kill().await;
            output.abort();
            return Err(failure);
        }
    };
    let (stdout, stderr) = output.await.map_err(|e| error(e.to_string()))??;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        let retryable = detail.contains("Error Domain=NSURLErrorDomain");
        return Err(error(if retryable {
            "网络连接失败，请检查网络或代理后重试".to_owned()
        } else {
            detail
        })
        .with_details(json!({"retryable":retryable})));
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}
async fn app_info(app: &Path) -> Result<Value, ApiError> {
    app_info_cancel(app, None).await
}
async fn app_info_cancel(
    app: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<Value, ApiError> {
    let output = command_cancel(
        Path::new("/usr/bin/plutil"),
        &[
            "-convert".into(),
            "json".into(),
            "-o".into(),
            "-".into(),
            app.join("Contents/Info.plist")
                .to_string_lossy()
                .into_owned(),
        ],
        15,
        cancel,
    )
    .await?;
    let info: Value = serde_json::from_slice(&output.stdout)?;
    if !version(info["CFBundleShortVersionString"].as_str().unwrap_or(""))
        || !digits(info["CFBundleVersion"].as_str().unwrap_or(""))
    {
        return Err(error("当前 Codex 版本和构建号无效"));
    }
    Ok(info)
}
fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}
async fn verify_app(app: &Path, release: &str, build: &str) -> Result<(), ApiError> {
    verify_app_cancel(app, release, build, None).await
}
async fn verify_app_cancel(
    app: &Path,
    release: &str,
    build: &str,
    cancel: Option<&CancellationToken>,
) -> Result<(), ApiError> {
    if tokio::fs::symlink_metadata(app)
        .await?
        .file_type()
        .is_symlink()
    {
        return Err(error("Codex 暂存安装包不能是符号链接"));
    }
    let info = app_info_cancel(app, cancel).await?;
    if info["CFBundleShortVersionString"] != release || info["CFBundleVersion"] != build {
        return Err(error("Codex 暂存安装包版本与官方检查结果不一致"));
    }
    let executable = info["CFBundleExecutable"]
        .as_str()
        .filter(|v| !v.is_empty() && Path::new(v).file_name().and_then(|v| v.to_str()) == Some(*v))
        .ok_or_else(|| error("Codex 暂存安装包的可执行文件无效"))?;
    let output = command_cancel(
        Path::new("/usr/bin/lipo"),
        &[
            "-archs".into(),
            app.join("Contents/MacOS")
                .join(executable)
                .to_string_lossy()
                .into_owned(),
        ],
        15,
        cancel,
    )
    .await?;
    let architecture = if arch() == "x64" { "x86_64" } else { arch() };
    if !String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .any(|s| s == architecture)
    {
        return Err(error("Codex 暂存安装包的架构不匹配"));
    }
    let nested = app.join("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
    let cli = if nested.try_exists()? {
        nested
    } else {
        app.join("Contents/Resources/codex")
    };
    for (path, identifier, deep) in [
        (app.to_path_buf(), "com.openai.codex", true),
        (cli, "codex", false),
    ] {
        if tokio::fs::symlink_metadata(&path)
            .await?
            .file_type()
            .is_symlink()
        {
            return Err(error("Codex 签名组件不能是符号链接"));
        }
        let mut args = vec!["--verify".into(), "--strict".into()];
        if deep {
            args.push("--deep".into());
        }
        args.push(path.to_string_lossy().into_owned());
        command_cancel(Path::new("/usr/bin/codesign"), &args, 120, cancel).await?;
        let output = command_cancel(
            Path::new("/usr/bin/codesign"),
            &[
                "-dv".into(),
                "--verbose=4".into(),
                path.to_string_lossy().into_owned(),
            ],
            15,
            cancel,
        )
        .await?;
        let details = String::from_utf8_lossy(&output.stderr);
        if !details
            .lines()
            .any(|s| s == format!("Identifier={identifier}"))
            || !details.lines().any(|s| s == "TeamIdentifier=2DC432GLL2")
        {
            return Err(error("Codex 安装包官方签名身份不匹配"));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct Session {
    id: String,
    offer: Value,
    temporary: PathBuf,
    archive: Option<Archive>,
    installed: Option<Value>,
    cancel: CancellationToken,
    retryable: bool,
}
struct Inner {
    status: Option<Value>,
    checked: Option<Value>,
    session: Option<Session>,
    task: Option<JoinHandle<()>>,
}
pub struct UpdateManager {
    app: PathBuf,
    root: PathBuf,
    assets: PathBuf,
    inner: Mutex<Inner>,
    control: Mutex<()>,
}

fn status(phase: &str, message: impl Into<String>) -> Value {
    json!({"phase":phase,"ready":phase=="ready","available":true,"downloading":(["preparing","downloading","verifying"].contains(&phase)),"checking":false,"message":message.into()})
}

impl UpdateManager {
    pub fn new(app: PathBuf, data: PathBuf, assets: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            app,
            root: data.join("codex-update"),
            assets,
            control: Mutex::new(()),
            inner: Mutex::new(Inner {
                status: None,
                checked: None,
                session: None,
                task: None,
            }),
        })
    }
    pub async fn restore(&self) -> Result<(), ApiError> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        let staged = self.root.join("staged");
        let metadata = match tokio::fs::read(staged.join("metadata.json")).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if metadata["version"] != 1 || metadata["architecture"] != arch() {
            return Err(error("Codex 暂存更新信息无效"));
        }
        let release = metadata["availableVersion"]
            .as_str()
            .ok_or_else(|| error("Codex 暂存更新信息无效"))?;
        let build = metadata["availableBuildVersion"]
            .as_str()
            .filter(|v| digits(v))
            .ok_or_else(|| error("Codex 暂存更新信息无效"))?;
        let installed = app_info(&self.app).await?;
        if cmp_build(installed["CFBundleVersion"].as_str().unwrap(), build)
            != std::cmp::Ordering::Less
        {
            tokio::fs::remove_dir_all(&staged).await?;
            return Ok(());
        }
        verify_app(&staged.join("ChatGPT.app"), release, build).await?;
        let mut ready = status("ready", format!("更新 {release} 已下载，可安装并重新连接"));
        ready["stagedBuild"] = json!(build);
        self.inner.lock().await.status = Some(ready);
        Ok(())
    }
    pub async fn current(&self) -> Option<Value> {
        self.inner.lock().await.status.clone()
    }
    pub async fn check(self: &Arc<Self>, channel: Value) -> Result<Value, ApiError> {
        if !cfg!(target_os = "macos") {
            return Err(error("直接下载 Codex 更新目前仅支持 macOS"));
        }
        let installed = app_info(&self.app).await?;
        let system = command(
            Path::new("/usr/bin/sw_vers"),
            &["-productVersion".into()],
            15,
        )
        .await?;
        let system = String::from_utf8_lossy(&system.stdout).trim().to_owned();
        let mut url = official_url("https://updates.oaistatic.com/codex/app/appcast")?;
        url.query_pairs_mut()
            .append_pair("installation_id", &uuid::Uuid::new_v4().to_string())
            .append_pair("arch", arch())
            .append_pair(
                "app_version",
                installed["CFBundleShortVersionString"].as_str().unwrap(),
            )
            .append_pair(
                "beta",
                if channel["beta"] == true {
                    "true"
                } else {
                    "false"
                },
            )
            .append_pair("os-version", &system)
            .append_pair(
                "plan_type",
                channel["planType"].as_str().unwrap_or("unknown"),
            );
        private_dir(&self.root).await?;
        let temporary = self.root.join(format!(".check-{}", uuid::Uuid::new_v4()));
        private_dir(&temporary).await?;
        let path = temporary.join("appcast.xml");
        let result = async {
            self.download_file(url.as_str(), &path, None, 0, None, None)
                .await?;
            let xml = tokio::fs::read_to_string(&path).await?;
            let mut result = versions(
                &xml,
                arch(),
                &system,
                installed["CFBundleVersion"].as_str().unwrap(),
            )?;
            result["installedVersion"] = installed["CFBundleShortVersionString"].clone();
            Ok::<_, ApiError>(result)
        }
        .await;
        let cleanup = tokio::fs::remove_dir_all(&temporary).await;
        let result = result?;
        cleanup?;
        self.inner.lock().await.checked = Some(result.clone());
        Ok(result)
    }
    pub async fn begin(
        self: &Arc<Self>,
        build: Option<&str>,
        native: &Value,
    ) -> Result<Value, ApiError> {
        let _control = self.control.lock().await;
        if native["ready"] == true || native["downloading"] == true {
            return Err(error("Codex 自带更新正在下载或等待安装，请先处理自带更新"));
        }
        let mut inner = self.inner.lock().await;
        if let Some(current) = inner.status.as_ref().filter(|v| {
            ["preparing", "downloading", "paused", "verifying", "ready"]
                .contains(&v["phase"].as_str().unwrap_or(""))
        }) {
            return Ok(current.clone());
        }
        let checked = inner
            .checked
            .as_ref()
            .ok_or_else(|| error("请先检查更新"))?;
        let versions = checked["versions"]
            .as_array()
            .ok_or_else(|| error("当前没有可下载更新"))?;
        let selected = if let Some(build) = build {
            versions.iter().find(|v| v["build"] == build)
        } else {
            versions
                .iter()
                .find(|v| v["verified"] == true)
                .or_else(|| versions.first())
        }
        .ok_or_else(|| error("当前更新清单没有所选版本，请重新检查更新"))?;
        let offer = json!({"availableVersion":selected["version"],"availableBuildVersion":selected["build"],"appcastXml":checked["appcastXml"]});
        let previous = inner.session.take();
        let old_task = inner.task.take();
        drop(inner);
        if let Some(task) = old_task {
            let _ = task.await;
        }
        let resume = previous.as_ref().is_some_and(|s| {
            s.retryable
                && s.offer["availableVersion"] == offer["availableVersion"]
                && s.offer["availableBuildVersion"] == offer["availableBuildVersion"]
        });
        let mut session = if resume {
            previous.unwrap()
        } else {
            if let Some(previous) = previous {
                if previous.temporary.try_exists()? {
                    tokio::fs::remove_dir_all(previous.temporary).await?;
                }
            }
            Session {
                id: uuid::Uuid::new_v4().to_string(),
                offer,
                temporary: self
                    .root
                    .join(format!(".download-{}", uuid::Uuid::new_v4())),
                archive: None,
                installed: None,
                cancel: CancellationToken::new(),
                retryable: false,
            }
        };
        session.cancel = CancellationToken::new();
        session.retryable = false;
        let mut inner = self.inner.lock().await;
        inner.status = Some(status(
            "preparing",
            if resume {
                "正在继续下载 Codex 更新…"
            } else {
                "正在准备下载 Codex 更新…"
            },
        ));
        inner.session = Some(session.clone());
        let manager = self.clone();
        inner.task = Some(tokio::spawn(async move {
            manager.download_session(session).await;
        }));
        Ok(inner.status.clone().unwrap())
    }
    pub async fn pause(&self) -> Option<Value> {
        let _control = self.control.lock().await;
        let mut inner = self.inner.lock().await;
        if !inner
            .status
            .as_ref()
            .is_some_and(|v| v["phase"] == "downloading")
        {
            return inner.status.clone();
        }
        if let Some(session) = &inner.session {
            session.cancel.cancel();
        }
        inner.status = Some(status("paused", "下载已暂停"));
        let task = inner.task.take();
        drop(inner);
        // 等待旧传输进程退出后再允许 resume 打开同一个部分下载文件。
        if let Some(task) = task {
            let _ = task.await;
        }
        self.current().await
    }
    pub async fn resume(self: &Arc<Self>) -> Option<Value> {
        let _control = self.control.lock().await;
        let mut inner = self.inner.lock().await;
        if inner
            .status
            .as_ref()
            .is_some_and(|v| v["phase"] == "paused")
        {
            if let Some(mut session) = inner.session.clone() {
                session.cancel = CancellationToken::new();
                inner.session = Some(session.clone());
                inner.status = Some(status("preparing", "正在继续下载 Codex 更新…"));
                let manager = self.clone();
                inner.task = Some(tokio::spawn(async move {
                    manager.download_session(session).await;
                }));
            }
        }
        inner.status.clone()
    }
    pub async fn cancel(&self) -> Result<Option<Value>, ApiError> {
        let _control = self.control.lock().await;
        let mut inner = self.inner.lock().await;
        if !inner.status.as_ref().is_some_and(|v| {
            ["preparing", "downloading", "paused", "verifying", "failed"]
                .contains(&v["phase"].as_str().unwrap_or(""))
        }) {
            return Ok(inner.status.clone());
        }
        if let Some(session) = &inner.session {
            session.cancel.cancel();
        }
        let task = inner.task.take();
        inner.status = Some(status("cancelled", "已取消下载"));
        drop(inner);
        if let Some(task) = task {
            let _ = task.await;
        }
        let mut inner = self.inner.lock().await;
        if let Some(session) = inner.session.take() {
            if session.temporary.try_exists()? {
                tokio::fs::remove_dir_all(session.temporary).await?;
            }
        }
        Ok(inner.status.clone())
    }
    async fn set_status(&self, id: &str, value: Value) -> bool {
        let mut inner = self.inner.lock().await;
        if inner
            .session
            .as_ref()
            .is_some_and(|s| s.id == id && !s.cancel.is_cancelled())
        {
            inner.status = Some(value);
            true
        } else {
            false
        }
    }
    async fn download_session(self: Arc<Self>, mut session: Session) {
        let result = self.download_inner(&mut session).await;
        if session.cancel.is_cancelled() {
            return;
        }
        if let Err(failure) = result {
            let size = tokio::fs::metadata(session.temporary.join("update.delta"))
                .await
                .ok()
                .map(|m| m.len())
                .unwrap_or(0);
            session.retryable = failure
                .details
                .as_ref()
                .is_some_and(|d| d["retryable"] == true)
                && session
                    .archive
                    .as_ref()
                    .is_some_and(|a| size > 0 && size <= a.length);
            if !session.retryable && session.temporary.try_exists().unwrap_or(false) {
                let _ = tokio::fs::remove_dir_all(&session.temporary).await;
                session.archive = None;
                session.installed = None;
            }
            let mut inner = self.inner.lock().await;
            if !session.cancel.is_cancelled()
                && inner.session.as_ref().is_some_and(|s| s.id == session.id)
            {
                inner.session = Some(session);
                inner.status = Some(status("failed", format!("Codex 更新下载失败：{failure}")));
            }
        }
    }
    async fn download_inner(&self, session: &mut Session) -> Result<(), ApiError> {
        let release = session.offer["availableVersion"]
            .as_str()
            .filter(|v| version(v))
            .ok_or_else(|| error("Codex 目标版本无效"))?
            .to_owned();
        let build = session.offer["availableBuildVersion"]
            .as_str()
            .filter(|v| digits(v))
            .ok_or_else(|| error("Codex 目标构建号无效"))?
            .to_owned();
        if session.archive.is_none() {
            if !cfg!(target_os = "macos") {
                return Err(error("直接下载 Codex 更新目前仅支持 macOS"));
            }
            let installed = app_info_cancel(&self.app, Some(&session.cancel)).await?;
            if cmp_build(installed["CFBundleVersion"].as_str().unwrap(), &build)
                != std::cmp::Ordering::Less
            {
                return Err(error("该 Codex 更新已经安装，请重新检查更新"));
            }
            private_dir(&self.root).await?;
            private_dir(&session.temporary).await?;
            let xml = session.offer["appcastXml"]
                .as_str()
                .ok_or_else(|| error("更新清单快照缺失"))?;
            write_private(&session.temporary.join("appcast.xml"), xml.as_bytes()).await?;
            let archive = select_archive(
                xml,
                &release,
                &build,
                arch(),
                installed["CFBundleVersion"].as_str().unwrap(),
            )?;
            assert_delta_base(&self.app, &archive).await?;
            session.archive = Some(archive);
            session.installed = Some(installed);
            let mut inner = self.inner.lock().await;
            if session.cancel.is_cancelled()
                || inner.session.as_ref().is_none_or(|s| s.id != session.id)
            {
                return Err(error("下载已取消"));
            }
            inner.session = Some(session.clone());
        }
        let archive = session.archive.as_ref().unwrap();
        let path = session.temporary.join("update.delta");
        let downloaded = match tokio::fs::metadata(&path).await {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e.into()),
        };
        if downloaded > archive.length {
            return Err(error("Codex 更新安装包超过官方声明大小"));
        }
        if downloaded < archive.length {
            self.set_status(
                &session.id,
                status(
                    "downloading",
                    format!(
                        "正在下载 Codex {release} · {}%",
                        downloaded * 100 / archive.length
                    ),
                ),
            )
            .await;
            self.download_file(
                &archive.url,
                &path,
                Some(archive.length),
                downloaded,
                Some((&session.id, &release)),
                Some(&session.cancel),
            )
            .await?;
        }
        if tokio::fs::metadata(&path).await?.len() != archive.length {
            return Err(error("Codex 更新安装包下载不完整"));
        }
        self.set_status(
            &session.id,
            status("verifying", "正在验证 Codex 更新安装包…"),
        )
        .await;
        let key = STANDARD
            .decode(
                session.installed.as_ref().unwrap()["SUPublicEDKey"]
                    .as_str()
                    .unwrap_or(""),
            )
            .map_err(|_| error("当前 Codex 安装包未提供有效的官方更新公钥"))?;
        let key: [u8; 32] = key
            .try_into()
            .map_err(|_| error("当前 Codex 安装包未提供有效的官方更新公钥"))?;
        let key = VerifyingKey::from_bytes(&key).map_err(|_| error("官方更新公钥无效"))?;
        let signature = STANDARD
            .decode(&archive.signature)
            .map_err(|_| error("官方更新签名无效"))?;
        let signature = Signature::from_slice(&signature).map_err(|_| error("官方更新签名无效"))?;
        key.verify_strict(&tokio::fs::read(&path).await?, &signature)
            .map_err(|_| error("Codex 更新安装包 Ed25519 签名验证失败"))?;
        let destination = session.temporary.join("ChatGPT.app");
        if destination.try_exists()? {
            tokio::fs::remove_dir_all(&destination).await?;
        }
        apply_delta(
            &self.app,
            &path,
            &destination,
            &self.assets,
            Some(&session.cancel),
        )
        .await?;
        verify_app_cancel(&destination, &release, &build, Some(&session.cancel)).await?;
        let installed = session.installed.as_ref().unwrap();
        let metadata = json!({"version":1,"availableVersion":release,"availableBuildVersion":build,"installedVersion":installed["CFBundleShortVersionString"],"installedBuildVersion":installed["CFBundleVersion"],"architecture":arch()});
        write_private(
            &session.temporary.join("metadata.json"),
            &serde_json::to_vec(&metadata)?,
        )
        .await?;
        tokio::fs::remove_file(&path).await?;
        tokio::fs::remove_file(session.temporary.join("appcast.xml")).await?;
        // 发布暂存目录与取消互斥，取消后的旧任务不能重新出现“可安装”状态。
        let mut inner = self.inner.lock().await;
        if session.cancel.is_cancelled()
            || inner.session.as_ref().is_none_or(|s| s.id != session.id)
        {
            return Err(error("下载已取消"));
        }
        let staged = self.root.join("staged");
        if staged.try_exists()? {
            tokio::fs::remove_dir_all(&staged).await?;
        }
        tokio::fs::rename(&session.temporary, &staged).await?;
        let mut ready = status("ready", format!("更新 {release} 已下载，可安装并重新连接"));
        ready["stagedBuild"] = json!(build);
        inner.status = Some(ready);
        inner.session = None;
        Ok(())
    }
    async fn download_file(
        &self,
        url: &str,
        destination: &Path,
        length: Option<u64>,
        offset: u64,
        progress: Option<(&str, &str)>,
        cancel: Option<&CancellationToken>,
    ) -> Result<(), ApiError> {
        official_url(url)?;
        let tool = helper(
            &self.assets,
            "CodexTransport",
            ".tmp/codex-transport/CodexTransport",
        )?;
        let mut child = Command::new(tool)
            .arg(url)
            .arg(destination)
            .arg(length.unwrap_or(0).to_string())
            .arg(offset.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let stderr = child.stderr.take().unwrap();
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.take(8193).read_to_end(&mut bytes).await;
            bytes
        });
        let transfer = tokio::time::timeout(
            Duration::from_secs(if length.is_some() { 1800 } else { 30 }),
            async {
                while let Some(line) = lines.next_line().await? {
                    let value: Value = serde_json::from_str(&line)?;
                    let downloaded = value["downloaded"]
                        .as_u64()
                        .ok_or_else(|| error("Codex 下载进度无效"))?;
                    if let Some(expected) = length {
                        if downloaded > expected {
                            return Err(error("Codex 下载超过官方声明大小"));
                        }
                        if let Some((id, release)) = progress {
                            self.set_status(
                                id,
                                status(
                                    "downloading",
                                    format!(
                                        "正在下载 Codex {release} · {}%",
                                        downloaded * 100 / expected
                                    ),
                                ),
                            )
                            .await;
                        }
                    }
                }
                Ok::<_, ApiError>(child.wait().await?)
            },
        );
        let outcome = tokio::select! { outcome=transfer=>outcome, _=async{if let Some(cancel)=cancel{cancel.cancelled().await}else{std::future::pending::<()>().await}}=>{let _=child.kill().await;stderr_task.abort();return Err(error("下载已取消"));} };
        let status = match outcome {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                stderr_task.abort();
                return Err(e);
            }
            Err(_) => {
                let _ = child.kill().await;
                stderr_task.abort();
                return Err(error("Codex 更新下载超时").with_details(json!({"retryable":true})));
            }
        };
        let stderr = stderr_task.await.unwrap_or_default();
        if !status.success() {
            let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
            let retryable = detail.contains("Error Domain=NSURLErrorDomain");
            return Err(error(if retryable {
                "网络连接失败，请检查网络或代理后重试".to_owned()
            } else {
                detail
            })
            .with_details(json!({"retryable":retryable})));
        }
        Ok(())
    }
}

async fn private_dir(path: &Path) -> Result<(), ApiError> {
    tokio::fs::create_dir_all(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}
async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    use tokio::io::AsyncWriteExt;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    Ok(())
}
fn helper(root: &Path, name: &str, development: &str) -> Result<PathBuf, ApiError> {
    let bundled = root.join("tools").join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    let local = root.join(development);
    if local.is_file() {
        Ok(local)
    } else {
        Err(error(format!(
            "Codex 系统工具 {name} 未打包，请重新安装 Codex Panel"
        )))
    }
}
async fn assert_delta_base(app: &Path, archive: &Archive) -> Result<(), ApiError> {
    let framework = app.join("Contents/Frameworks/Sparkle.framework");
    let executable = tokio::fs::metadata(framework.join("Sparkle")).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable.permissions().mode() & 0o7777 != 0o755 {
            return Err(error("当前 Codex 的 Sparkle 权限不支持增量更新"));
        }
    }
    if archive
        .executable_size
        .is_some_and(|s| s != executable.len())
    {
        return Err(error(
            "当前 Codex 与官方增量包的基础文件不匹配，无法进行增量更新",
        ));
    }
    for locale in &archive.locales {
        if !locale
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(error("官方增量包的语言要求无效"));
        }
        if !framework
            .join("Resources")
            .join(format!("{locale}.lproj"))
            .try_exists()?
        {
            return Err(error(format!(
                "当前 Codex 缺少增量更新需要的语言文件：{locale}"
            )));
        }
    }
    Ok(())
}
async fn apply_delta(
    app: &Path,
    delta: &Path,
    destination: &Path,
    assets: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<(), ApiError> {
    if tokio::fs::symlink_metadata(app)
        .await?
        .file_type()
        .is_symlink()
        || !tokio::fs::symlink_metadata(delta).await?.is_file()
    {
        return Err(error("Codex 增量更新路径无效"));
    }
    let source = tokio::fs::canonicalize(app).await?;
    let parent = tokio::fs::canonicalize(
        destination
            .parent()
            .ok_or_else(|| error("Codex 暂存路径无效"))?,
    )
    .await?;
    let target = parent.join(
        destination
            .file_name()
            .ok_or_else(|| error("Codex 暂存路径无效"))?,
    );
    if target.starts_with(&source)
        || source.starts_with(&target)
        || tokio::fs::symlink_metadata(&target).await.is_ok()
    {
        return Err(error("Codex 增量更新必须生成到独立且不存在的暂存目录"));
    }
    let tool = helper(assets, "BinaryDelta", ".tmp/codex-delta/2.9.1/BinaryDelta")?;
    if !tokio::fs::symlink_metadata(&tool).await?.is_file() {
        return Err(error("Codex 增量更新工具无效"));
    }
    command_cancel(
        &tool,
        &[
            "apply".into(),
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
            tokio::fs::canonicalize(delta)
                .await?
                .to_string_lossy()
                .into_owned(),
        ],
        600,
        cancel,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn feed() -> String {
        format!(
            r#"<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>30000</sparkle:version><sparkle:shortVersionString>26.1126.1</sparkle:shortVersionString><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><sparkle:minimumSystemVersion>11.0</sparkle:minimumSystemVersion><sparkle:deltas><enclosure url="https://updates.oaistatic.com/test.delta" length="42" sparkle:deltaFrom="29000" sparkle:edSignature="{}"/></sparkle:deltas></item></channel></rss>"#,
            STANDARD.encode([0; 64])
        )
    }
    #[test]
    fn feed_requires_exact_architecture_base_and_unique_target() {
        let xml = feed();
        assert_eq!(
            versions(&xml, "arm64", "14.1", "29000").unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(versions(&xml, "x64", "14.1", "29000").unwrap()["versions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(select_archive(&xml, "26.1126.1", "30000", "arm64", "28000").is_err());
        assert!(select_archive(&xml, "26.1126.1", "30000", "arm64", "29000").is_ok());
    }
    #[test]
    fn feed_rejects_external_entities_and_untrusted_downloads() {
        assert!(
            document("<!DOCTYPE rss SYSTEM 'file:///etc/passwd'><rss><channel/></rss>").is_err()
        );
        assert!(official_url("https://updates.oaistatic.com.evil.invalid/payload.delta").is_err());
        assert!(official_url("https://user@updates.oaistatic.com/payload.delta").is_err());
        assert!(select_archive(
            &feed().replace(
                "https://updates.oaistatic.com/test.delta",
                "http://updates.oaistatic.com/test.delta"
            ),
            "26.1126.1",
            "30000",
            "arm64",
            "29000"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pause_waits_for_transport_exit_and_resume_keeps_partial_file() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let tools = temporary.path().join("tools");
        tokio::fs::create_dir(&tools).await.unwrap();
        let helper = tools.join("CodexTransport");
        // 模拟传输只写临时文件，完全不访问 URL 或真实应用。
        tokio::fs::write(
            &helper,
            r#"#!/usr/bin/python3
import sys,time,json,os
target=sys.argv[2]
offset=int(sys.argv[4])
with open(target+'.offsets','a') as offsets:
    offsets.write(str(offset)+'\n')
with open(target,'ab') as output:
    while True:
        output.write(b'x'*128)
        output.flush()
        print(json.dumps({'downloaded':output.tell()}),flush=True)
        time.sleep(0.02)
"#,
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        let manager = UpdateManager::new(
            temporary.path().join("App.app"),
            temporary.path().join("data"),
            temporary.path().to_owned(),
        );
        let destination = temporary.path().join("partial");
        tokio::fs::create_dir(&destination).await.unwrap();
        let session = Session {
            id: "test".into(),
            offer: json!({"availableVersion":"26.1126.1","availableBuildVersion":"30000"}),
            temporary: destination.clone(),
            archive: Some(Archive {
                url: "https://updates.oaistatic.com/test.delta".into(),
                length: 1_000_000,
                signature: String::new(),
                executable_size: None,
                locales: Vec::new(),
            }),
            installed: Some(json!({})),
            cancel: CancellationToken::new(),
            retryable: false,
        };
        {
            let mut inner = manager.inner.lock().await;
            inner.session = Some(session.clone());
            inner.status = Some(status("downloading", "test"));
            let worker = manager.clone();
            inner.task = Some(tokio::spawn(async move {
                let _ = worker
                    .download_file(
                        "https://updates.oaistatic.com/test.delta",
                        &session.temporary.join("update.delta"),
                        Some(1_000_000),
                        0,
                        Some((&session.id, "26.1126.1")),
                        Some(&session.cancel),
                    )
                    .await;
            }));
        }
        let file = destination.join("update.delta");
        for _ in 0..100 {
            if tokio::fs::metadata(&file).await.is_ok_and(|m| m.len() > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        manager.pause().await;
        let length = tokio::fs::metadata(&file).await.unwrap().len();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(tokio::fs::metadata(&file).await.unwrap().len(), length);
        assert_eq!(manager.current().await.unwrap()["phase"], "paused");
        manager.resume().await;
        for _ in 0..100 {
            if tokio::fs::metadata(&file)
                .await
                .is_ok_and(|m| m.len() > length)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        manager.pause().await;
        let offsets = tokio::fs::read_to_string(file.with_extension("delta.offsets"))
            .await
            .unwrap();
        assert_eq!(
            offsets
                .lines()
                .map(|s| s.parse::<u64>().unwrap())
                .collect::<Vec<_>>(),
            vec![0, length]
        );
        manager.cancel().await.unwrap();
        assert!(!destination.exists());
    }
}
