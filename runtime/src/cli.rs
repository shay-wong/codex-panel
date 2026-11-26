use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    io::{IsTerminal, Read},
    path::{Component, Path, PathBuf},
};
use tokio::{io::AsyncWriteExt, process::Command};
use url::Url;

const SCHEMA_VERSION: u32 = 2;
const DEFAULT_URL: &str = "http://127.0.0.1:47823";

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
    exit: i32,
    details: Option<Value>,
}
type Result<T> = std::result::Result<T, CliError>;

impl CliError {
    fn new(code: &str, message: impl Into<String>, exit: i32) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit,
            details: None,
        }
    }
    fn detail(mut self, value: impl ToString) -> Self {
        self.details = Some(json!(value.to_string()));
        self
    }
}
fn usage(message: impl Into<String>) -> CliError {
    CliError::new("USAGE_ERROR", message, 2)
}
fn file_error(action: &str, path: &Path, error: std::io::Error) -> CliError {
    CliError::new(
        if action == "read" {
            "FILE_READ_FAILED"
        } else {
            "FILE_WRITE_FAILED"
        },
        format!("Cannot {action} file: {}", path.display()),
        2,
    )
    .detail(error)
}
fn env(primary: &str, legacy: &str) -> Option<String> {
    std::env::var(primary)
        .ok()
        .or_else(|| std::env::var(legacy).ok())
}

#[derive(Debug)]
struct Parsed {
    resource: String,
    action: String,
    operands: Vec<String>,
    options: BTreeMap<String, Value>,
}
impl Parsed {
    fn parse(args: &[String]) -> Result<Self> {
        let mut positions = Vec::new();
        let mut options = BTreeMap::new();
        let mut index = 0;
        while index < args.len() {
            let token = &args[index];
            if token == "--" {
                positions.extend_from_slice(&args[index + 1..]);
                break;
            }
            if let Some(option) = token.strip_prefix("--") {
                let (name, inline) = option
                    .split_once('=')
                    .map_or((option, None), |(n, v)| (n, Some(v)));
                if name.is_empty() {
                    return Err(usage("Invalid empty option"));
                }
                if options.contains_key(name) {
                    return Err(usage(format!("Option --{name} may only be specified once")));
                }
                let value = if ["json", "help", "clear-binding-thread"].contains(&name) {
                    if inline.is_some() {
                        return Err(usage(format!("Option --{name} does not accept a value")));
                    }
                    Value::Bool(true)
                } else if let Some(value) = inline {
                    json!(value)
                } else {
                    index += 1;
                    let value = args
                        .get(index)
                        .filter(|s| !s.starts_with("--"))
                        .ok_or_else(|| usage(format!("Option --{name} requires a value")))?;
                    json!(value)
                };
                options.insert(name.into(), value);
            } else {
                positions.push(token.clone());
            }
            index += 1;
        }
        Ok(Self {
            resource: positions.first().cloned().unwrap_or_default(),
            action: positions.get(1).cloned().unwrap_or_default(),
            operands: positions.into_iter().skip(2).collect(),
            options,
        })
    }
    fn command(&self) -> String {
        format!("{} {}", self.resource, self.action).trim().into()
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.options.get(name).and_then(Value::as_str)
    }
    fn has(&self, name: &str) -> bool {
        self.options.contains_key(name)
    }
    fn require(&self, name: &str) -> Result<&str> {
        self.get(name)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| usage(format!("Missing required option --{name}")))
    }
    fn count(&self, n: usize) -> Result<()> {
        if self.operands.len() == n {
            Ok(())
        } else {
            Err(usage(format!(
                "{} requires exactly {n} positional arguments",
                self.command()
            )))
        }
    }
    fn operand(&self, n: usize) -> Result<&str> {
        self.operands
            .get(n)
            .map(String::as_str)
            .ok_or_else(|| usage("Missing positional argument"))
    }
}

pub async fn run(args: &[String]) -> i32 {
    let result = async {
        let parsed = Parsed::parse(args)?;
        // 沿用同一份命令白名单和帮助内容，避免迁移后悄悄接受拼错的参数。
        let contract: Value = serde_json::from_str(include_str!("../assets/cli-contract.json"))
            .map_err(|e| CliError::new("INTERNAL_ERROR", e.to_string(), 1))?;
        if parsed.has("help") {
            let help = contract["help"][parsed.command()]
                .as_str()
                .filter(|_| parsed.operands.is_empty() && parsed.options.len() == 1)
                .ok_or_else(|| usage("Help is not available for this command level"))?;
            println!("{help}");
            return Ok(None);
        }
        let allowed = contract["options"][parsed.command()]
            .as_array()
            .ok_or_else(|| usage("Unsupported command; use panelctl --help"))?;
        for option in parsed.options.keys() {
            if option != "runtime-file" && !allowed.iter().any(|v| v.as_str() == Some(option)) {
                return Err(usage(format!("Unknown option --{option}")));
            }
        }
        let companion = parsed.resource == "cloud"
            || parsed.command() == "project map"
            || parsed.command() == "workflow get"
            || env("CODEX_PANEL_COMPANION_URL", "CODEX_TASKBOARD_COMPANION_URL").is_some();
        let api = Api::resolve(&parsed, companion).await.map_err(|mut error| {
            // 端点解析失败也属于发布失败，仍需告知用户已保存的交接文档位置。
            if parsed.command()=="handoff publish" {
                if let Some(file)=parsed.get("handoff-file") {
                    error.message=format!("Handoff Panel publication failed: {}\nThe handoff document remains at {file}",error.message);
                }
            }
            error
        })?;
        execute(&parsed, &api).await.map(Some)
    }
    .await;
    match result {
        Ok(Some(mut value)) => {
            value["schemaVersion"] = json!(SCHEMA_VERSION);
            println!("{value}");
            0
        }
        Ok(None) => 0,
        Err(error) => {
            let mut body = json!({"schemaVersion":SCHEMA_VERSION,"error":{"code":error.code,"message":error.message}});
            if let Some(details) = error.details {
                body["error"]["details"] = details;
            }
            eprintln!("{body}");
            error.exit
        }
    }
}

struct Api {
    base: Url,
    windows: bool,
    client: reqwest::Client,
}
struct Raw {
    status: u16,
    content_type: Option<String>,
    bytes: Vec<u8>,
}
impl Api {
    async fn resolve(parsed: &Parsed, companion: bool) -> Result<Self> {
        let explicit = if companion {
            env("CODEX_PANEL_COMPANION_URL", "CODEX_TASKBOARD_COMPANION_URL")
        } else {
            None
        };
        let explicit = explicit.or_else(|| env("CODEX_PANEL_URL", "CODEX_TASKBOARD_URL"));
        let (raw, windows) = if let Some(url) = explicit {
            (url, false)
        } else {
            let configured = parsed
                .get("runtime-file")
                .map(str::to_owned)
                .or_else(|| env("CODEX_PANEL_RUNTIME_FILE", "CODEX_TASKBOARD_RUNTIME_FILE"));
            let wsl = std::env::var_os("WSL_DISTRO_NAME").is_some()
                || std::env::var_os("WSL_INTEROP").is_some();
            let mut candidates = Vec::new();
            if let Some(path) = configured {
                candidates.push((PathBuf::from(path), true, false));
            } else {
                if wsl {
                    if let Some(path) = env(
                        "CODEX_PANEL_WSL_RUNTIME_FILE",
                        "CODEX_TASKBOARD_WSL_RUNTIME_FILE",
                    ) {
                        candidates.push((PathBuf::from(path), true, true));
                    } else if let Some(path) = wsl_descriptor().await {
                        candidates.push((path, false, true));
                    }
                }
                candidates.push((
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("../.data/launcher-runtime.json"),
                    false,
                    false,
                ));
            }
            let mut target = (DEFAULT_URL.into(), false);
            for (path, required, windows) in candidates {
                let bytes = match std::fs::read(&path) {
                    Ok(bytes) => bytes,
                    Err(e) if !required && e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        return Err(CliError::new(
                            "SERVICE_UNAVAILABLE",
                            "Cannot read the active Panel launcher endpoint",
                            3,
                        )
                        .detail(e))
                    }
                };
                let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                    CliError::new(
                        "INVALID_RESPONSE",
                        "The active Panel launcher endpoint is invalid",
                        4,
                    )
                    .detail(e)
                })?;
                if !matches!(value["version"].as_u64(), Some(1 | 2)) || !value["url"].is_string() {
                    return Err(CliError::new(
                        "INVALID_RESPONSE",
                        "The active Panel launcher endpoint is invalid",
                        4,
                    ));
                }
                target = (value["url"].as_str().unwrap().into(), windows);
                break;
            }
            target
        };
        let mut base =
            Url::parse(&raw).map_err(|_| usage("CODEX_PANEL_URL must be a valid URL"))?;
        if !["http", "https"].contains(&base.scheme()) {
            return Err(usage("CODEX_PANEL_URL must use http or https"));
        }
        if companion {
            let path = base.path().trim_matches('/');
            if !["localhost", "127.0.0.1", "[::1]", "::1"].contains(&base.host_str().unwrap_or(""))
                || !base.username().is_empty()
                || base.password().is_some()
                || base.query().is_some()
                || base.fragment().is_some()
                || (!path.is_empty() && !(16..=128).contains(&path.len()))
                || !path.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err(usage(
                    "Local companion URL must be a loopback HTTP or HTTPS origin",
                ));
            }
        }
        base.set_query(None);
        base.set_fragment(None);
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        Ok(Self {
            base,
            windows,
            client: reqwest::Client::new(),
        })
    }
    async fn raw(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        headers: &[(&str, String)],
    ) -> Result<Raw> {
        let url = self
            .base
            .join(path.trim_start_matches('/'))
            .map_err(|e| usage(e.to_string()))?;
        let unavailable = |e: String| {
            CliError::new(
                "SERVICE_UNAVAILABLE",
                format!("Cannot reach panel service at {}", self.base),
                3,
            )
            .detail(e)
        };
        let raw = if self.windows {
            // WSL 的回环网络不一定直通宿主，沿用 Windows curl 访问当前宿主实例。
            let marker = "__CODEX_PANEL_CURL_RESPONSE__";
            let mut command = Command::new("curl.exe");
            command.args([
                "--disable",
                "--noproxy",
                "*",
                "--silent",
                "--show-error",
                "--request",
                method,
                "--header",
                "x-panel-client: panelctl",
            ]);
            for (key, value) in headers {
                command.args(["--header", &format!("{key}: {value}")]);
            }
            if body.is_some() {
                command.args(["--data-binary", "@-"]);
            }
            command.args([
                "--write-out",
                &format!(
                    "%{{stderr}}{marker}%{{http_code}}\t%{{content_type}}\t%{{size_download}}"
                ),
                "--url",
                url.as_str(),
            ]);
            command
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().map_err(|e| unavailable(e.to_string()))?;
            if let Some(body) = body {
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(&body)
                    .await
                    .map_err(|e| unavailable(e.to_string()))?;
            } else {
                drop(child.stdin.take());
            }
            let output = child
                .wait_with_output()
                .await
                .map_err(|e| unavailable(e.to_string()))?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !output.status.success() {
                return Err(unavailable(stderr.into_owned()));
            }
            let fields: Vec<_> = stderr
                .rsplit_once(marker)
                .ok_or_else(|| {
                    unavailable("curl.exe did not return HTTP response metadata".into())
                })?
                .1
                .split('\t')
                .collect();
            let status = fields[0]
                .parse::<u16>()
                .ok()
                .filter(|s| (100..=599).contains(s))
                .ok_or_else(|| {
                    unavailable("curl.exe returned invalid HTTP response metadata".into())
                })?;
            Raw {
                status,
                content_type: fields
                    .get(1)
                    .filter(|v| !v.is_empty())
                    .map(|v| v.to_string()),
                bytes: output.stdout,
            }
        } else {
            let method =
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| usage(e.to_string()))?;
            let mut request = self
                .client
                .request(method, url)
                .header("x-panel-client", "panelctl");
            for (key, value) in headers {
                request = request.header(*key, value);
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|e| unavailable(e.to_string()))?;
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let bytes = response
                .bytes()
                .await
                .map_err(|e| unavailable(e.to_string()))?
                .to_vec();
            Raw {
                status,
                content_type,
                bytes,
            }
        };
        if !(200..300).contains(&raw.status) {
            let value: Value = serde_json::from_slice(&raw.bytes).map_err(|_| {
                CliError::new("INVALID_RESPONSE", "Panel service returned invalid JSON", 4)
            })?;
            let payload = if value["error"].is_object() {
                &value["error"]
            } else {
                &value
            };
            return Err(CliError {
                code: payload["code"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("HTTP_{}", raw.status)),
                message: payload["message"]
                    .as_str()
                    .or_else(|| value["error"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("Panel service returned HTTP {}", raw.status)),
                exit: if raw.status == 409 { 5 } else { 4 },
                details: payload.get("details").cloned(),
            });
        }
        Ok(raw)
    }
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let headers = if body.is_some() {
            vec![
                ("accept", "application/json".into()),
                ("content-type", "application/json".into()),
            ]
        } else {
            vec![("accept", "application/json".into())]
        };
        let raw = self
            .raw(
                method,
                path,
                body.map(|v| serde_json::to_vec(&v).unwrap()),
                &headers,
            )
            .await?;
        let value: Value = if raw.bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&raw.bytes).map_err(|_| {
                CliError::new("INVALID_RESPONSE", "Panel service returned invalid JSON", 4)
            })?
        };
        if !value.is_object() {
            return Err(CliError::new(
                "INVALID_RESPONSE",
                "Panel service returned an invalid JSON response",
                4,
            ));
        }
        Ok(value)
    }
}

async fn wsl_descriptor() -> Option<PathBuf> {
    let output = Command::new("cmd.exe")
        .args(["/d", "/u", "/s", "/c", "set LOCALAPPDATA"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf16_lossy(
        &output
            .stdout
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<_>>(),
    );
    let path = text
        .lines()
        .find(|line| line.to_ascii_uppercase().starts_with("LOCALAPPDATA="))?
        .split_once('=')?
        .1
        .trim();
    let converted = Command::new("wslpath")
        .args(["-u", path])
        .output()
        .await
        .ok()?;
    if !converted.status.success() {
        return None;
    }
    let path = String::from_utf8(converted.stdout).ok()?;
    Some(Path::new(path.trim()).join("Codex Panel/data/launcher-runtime.json"))
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
fn task(id: &str) -> String {
    format!("/api/tasks/{}", encode(id))
}
fn query(path: &str, values: &[(&str, Option<&str>)]) -> String {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(values.iter().filter_map(|(k, v)| v.map(|v| (*k, v))))
        .finish();
    if encoded.is_empty() {
        path.into()
    } else {
        format!("{path}?{encoded}")
    }
}
fn absolute(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| usage(e.to_string()))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
fn file_text(value: &str) -> Result<String> {
    let path = absolute(value)?;
    std::fs::read_to_string(&path).map_err(|e| file_error("read", &path, e))
}
fn text_or_file(p: &Parsed, text: &str, file: &str, required: bool) -> Result<String> {
    if p.has(text) && p.has(file) {
        return Err(usage(format!("Use either --{text} or --{file}, not both")));
    }
    if let Some(path) = p.get(file) {
        file_text(path)
    } else if required {
        Ok(p.require(text)?.into())
    } else {
        Ok(p.get(text).unwrap_or("").into())
    }
}
fn version(value: &str, allow_zero: bool) -> Result<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|v| *v <= 9_007_199_254_740_991 && (allow_zero || *v > 0))
        .ok_or_else(|| usage("--if-version must be a valid integer"))
}
async fn task_version(api: &Api, id: &str, p: &Parsed) -> Result<u64> {
    if let Some(v) = p.get("if-version") {
        return version(v, false);
    }
    api.request("GET", &task(id), None).await?["task"]["version"]
        .as_u64()
        .filter(|v| *v > 0)
        .ok_or_else(|| {
            CliError::new(
                "INVALID_RESPONSE",
                "Panel service returned a task without a valid version",
                4,
            )
        })
}
fn labels(raw: &str) -> Vec<String> {
    let mut list = Vec::new();
    for value in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !list.iter().any(|s| s == value) {
            list.push(value.to_owned());
        }
    }
    list
}
fn validate_status(value: &str) -> Result<()> {
    if [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "blocked",
        "done",
        "canceled",
    ]
    .contains(&value)
    {
        Ok(())
    } else {
        Err(usage(format!("Invalid status: {value}")))
    }
}
fn validate_priority(value: &str) -> Result<()> {
    if ["none", "urgent", "high", "medium", "low"].contains(&value) {
        Ok(())
    } else {
        Err(usage(format!("Invalid priority: {value}")))
    }
}
fn thread(p: &Parsed) -> Result<String> {
    let value=p.get("thread-id").map(str::to_owned).or_else(||std::env::var("CODEX_THREAD_ID").ok()).ok_or_else(||usage("Conversation attribution requires --agent-platform with --session-id, or Codex --thread-id or CODEX_THREAD_ID"))?;
    let value = value.trim();
    if value.is_empty() || value.encode_utf16().count() > 256 {
        return Err(usage("Thread id must contain 1 to 256 characters"));
    }
    Ok(value.into())
}
fn attribution(p: &Parsed) -> Result<Value> {
    if p.has("agent-platform") || p.has("session-id") {
        if p.has("thread-id") {
            return Err(usage(
                "Use --agent-platform with --session-id, or Codex --thread-id, not both",
            ));
        }
        let platform = p.require("agent-platform")?;
        let id = p.require("session-id")?;
        let max = if platform == "pi" { 4096 } else { 256 };
        if !["claude", "pi", "agy", "grok"].contains(&platform)
            || id.trim().is_empty()
            || id.encode_utf16().count() > max
            || id.trim_start().starts_with('-')
            || id.chars().any(|c| c.is_ascii_control())
        {
            return Err(usage("Invalid external agent session"));
        }
        Ok(json!({"agentSession":{"platform":platform,"sessionId":id}}))
    } else {
        Ok(json!({"threadId":thread(p)?}))
    }
}
fn binding(p: &Parsed) -> Result<Option<Value>> {
    let fields = [
        "binding-thread-id",
        "binding-codex-project-id",
        "binding-codex-project-kind",
        "binding-codex-host-id",
        "binding-workspace-path",
    ];
    if p.has("clear-binding-thread") {
        if fields.iter().any(|f| p.has(f)) {
            return Err(usage(
                "--clear-binding-thread cannot be combined with binding identity options",
            ));
        }
        return Ok(Some(Value::Null));
    }
    if fields.iter().all(|f| !p.has(f)) {
        return Ok(None);
    }
    let id = p.require(fields[0])?.trim();
    if id.is_empty() || id.encode_utf16().count() > 256 {
        return Err(usage("Invalid binding thread id"));
    }
    if fields[1..].iter().all(|f| !p.has(f)) {
        return Ok(Some(json!({"threadId":id})));
    }
    let project = p.require(fields[1])?.trim();
    let kind = p.require(fields[2])?;
    let host = p.require(fields[3])?.trim();
    let workspace = p.require(fields[4])?;
    if project.is_empty()
        || project.encode_utf16().count() > 256
        || host.is_empty()
        || host.encode_utf16().count() > 256
        || !["local", "remote"].contains(&kind)
        || (kind == "local") != (host == "local")
        || !(Path::new(workspace).is_absolute()
            || regex::Regex::new(r"^(?:[A-Za-z]:[/\\]|\\\\)")
                .unwrap()
                .is_match(workspace))
    {
        return Err(usage("Invalid native binding identity"));
    }
    Ok(Some(
        json!({"threadId":id,"codexProjectId":project,"codexProjectKind":kind,"codexHostId":host,"workspacePath":workspace}),
    ))
}
fn optional_fields(p: &Parsed, create: bool) -> Result<Map<String, Value>> {
    let mut fields = Map::new();
    for (option, key) in [
        ("project", "projectId"),
        ("title", "title"),
        ("status", "status"),
        ("priority", "priority"),
        ("start-date", "startDate"),
        ("due-date", "dueDate"),
    ] {
        if let Some(value) = p.get(option) {
            fields.insert(key.into(), json!(value));
        }
    }
    if create {
        fields.insert("status".into(), json!(p.get("status").unwrap_or("backlog")));
        fields.insert(
            "priority".into(),
            json!(p.get("priority").unwrap_or("none")),
        );
    }
    if let Some(status) = fields.get("status").and_then(Value::as_str) {
        validate_status(status)?;
    }
    if let Some(priority) = fields.get("priority").and_then(Value::as_str) {
        validate_priority(priority)?;
    }
    if create || p.has("description") || p.has("description-file") {
        fields.insert(
            "description".into(),
            json!(text_or_file(p, "description", "description-file", false)?),
        );
    }
    if create || p.has("labels") {
        fields.insert(
            "labels".into(),
            json!(labels(p.get("labels").unwrap_or(""))),
        );
    }
    if p.has("git-branch") && (p.has("worktree-path") || p.has("worktree-branch")) {
        return Err(usage(
            "Use either --git-branch or --worktree-path/--worktree-branch, not both",
        ));
    }
    if p.has("worktree-branch") && !p.has("worktree-path") {
        return Err(usage("--worktree-branch requires --worktree-path"));
    }
    if let Some(branch) = p.get("git-branch") {
        fields.insert(
            "developmentContext".into(),
            json!({"type":"branch","branch":branch}),
        );
    }
    if let Some(path) = p.get("worktree-path") {
        fields.insert(
            "developmentContext".into(),
            json!({"type":"worktree","path":absolute(path)?,"branch":p.get("worktree-branch")}),
        );
    }
    if p.has("recurrence-interval") || p.has("recurrence-unit") {
        let interval = p
            .require("recurrence-interval")?
            .parse::<u32>()
            .ok()
            .filter(|v| (1..=365).contains(v))
            .ok_or_else(|| usage("--recurrence-interval must be an integer from 1 to 365"))?;
        let unit = p.require("recurrence-unit")?;
        if !["day", "week", "month", "year"].contains(&unit) {
            return Err(usage("Invalid recurrence unit"));
        }
        fields.insert(
            "recurrence".into(),
            json!({"interval":interval,"unit":unit}),
        );
    }
    Ok(fields)
}

async fn execute(p: &Parsed, api: &Api) -> Result<Value> {
    if p.command() == "handoff publish" {
        p.count(0)?;
        let issue = p.require("issue")?;
        let file = Path::new(p.require("handoff-file")?);
        let result = async {
            let handoff = std::fs::read_to_string(file).map_err(|e| file_error("read", file, e))?;
            if handoff.trim().is_empty() {
                return Err(usage(format!("Handoff document is empty: {}", file.display())));
            }
            let response = api.request("GET", &task(issue), None).await?;
            if !response["task"].is_object() || !response["task"]["archivedAt"].is_null() {
                return Err(usage(format!("Issue is missing or archived: {issue}")));
            }
            // 原文只包裹一次交接标记，不重写摘要，也不更改议题本身。
            let mut body = attribution(p)?;
            body["body"] = json!(format!("<!-- codex-panel:ai-chat-handoff:v1 -->\n### AI 对话交接\n\n{handoff}\n\n> 来源：全局 Codex 对话（`$handoff-panel`）"));
            api.request("POST", &format!("{}/comments", task(issue)), Some(body)).await
        }.await;
        return result.map_err(|mut error: CliError| {
            error.message = format!(
                "Handoff Panel publication failed: {}\nThe handoff document remains at {}",
                error.message,
                file.display()
            );
            error
        });
    }
    match (p.resource.as_str(), p.action.as_str()) {
        ("workflow", "get") => {
            p.count(1)?;
            api.request(
                "GET",
                &query(
                    "/api/local/workflow",
                    &[
                        ("stage", Some(p.operand(0)?)),
                        ("projectId", p.get("project")),
                    ],
                ),
                None,
            )
            .await
        }
        ("project", "list") => {
            p.count(0)?;
            api.request("GET", "/api/projects", None).await
        }
        ("project", "create") => {
            p.count(0)?;
            let mut body = json!({"name":p.require("name")?});
            for (opt, key) in [("id", "id"), ("issue-key", "issueKey")] {
                if let Some(v) = p.get(opt) {
                    body[key] = json!(v);
                }
            }
            if let Some(path) = p.get("workspace-path") {
                body["workspacePath"] = json!(absolute(path)?);
            }
            api.request("POST", "/api/projects", Some(body)).await
        }
        ("project", "map") => {
            p.count(1)?;
            api.request(
                "PUT",
                &format!("/api/local/project-mappings/{}", encode(p.operand(0)?)),
                Some(json!({"workspacePath":absolute(p.require("workspace-path")?)?})),
            )
            .await
        }
        ("project", "readme") => {
            let action = p.operands.first().map(String::as_str);
            let explicit = matches!(action, Some("get" | "set"));
            if p.operands.len() > if explicit { 2 } else { 1 } {
                return Err(usage("Too many project readme operands"));
            }
            let id = if let Some(id) = p.operands.get(if explicit { 1 } else { 0 }) {
                id.clone()
            } else {
                context(api, None).await?["project"]["id"]
                    .as_str()
                    .unwrap_or("local")
                    .into()
            };
            let path = format!("/api/projects/{}/readme", encode(&id));
            let set = action == Some("set") || (!explicit && (p.has("content") || p.has("file")));
            if set {
                let mut body = json!({"content":text_or_file(p,"content","file",true)?});
                if let Some(v) = p.get("if-version") {
                    body["version"] = json!(version(v, true)?);
                }
                api.request("PUT", &path, Some(body)).await
            } else {
                if p.has("content") || p.has("file") || p.has("if-version") {
                    return Err(usage("project readme get does not accept write options"));
                }
                api.request("GET", &path, None).await
            }
        }
        ("conversation", "bind") => {
            p.count(1)?;
            let mut body = json!({"threadId":thread(p)?});
            if let Some(v) = p.get("replace-thread-id") {
                body["replaceThreadId"] = json!(v);
            }
            api.request(
                "POST",
                &format!("{}/bind-thread", task(p.operand(0)?)),
                Some(body),
            )
            .await
        }
        ("cloud", "status") => {
            p.count(0)?;
            api.request("GET", "/api/local/cloud-session", None).await
        }
        ("cloud", "logout") => {
            p.count(0)?;
            api.request("DELETE", "/api/local/cloud-session", None)
                .await
        }
        ("cloud", "login") => {
            p.count(0)?;
            let remote = Url::parse(p.require("url")?)
                .map_err(|_| usage("Cloud panel URL must be a valid URL"))?;
            let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"]
                .contains(&remote.host_str().unwrap_or(""));
            if !(remote.scheme() == "https" || (remote.scheme() == "http" && loopback))
                || !remote.username().is_empty()
                || remote.password().is_some()
                || remote.path() != "/"
                || remote.query().is_some()
                || remote.fragment().is_some()
            {
                return Err(CliError::new("INVALID_CLOUD_URL","Cloud panel URL must be an HTTPS origin (loopback HTTP is allowed for development)",2));
            }
            // 终端输入不得回显共享密钥；管道输入只移除末尾的一个换行。
            let secret = if std::io::stdin().is_terminal() {
                rpassword::prompt_password("Shared key: ").map_err(|e| usage(e.to_string()))?
            } else {
                let mut s = String::new();
                std::io::stdin()
                    .read_to_string(&mut s)
                    .map_err(|e| usage(e.to_string()))?;
                s.strip_suffix("\r\n")
                    .or_else(|| s.strip_suffix('\n'))
                    .unwrap_or(&s)
                    .to_owned()
            };
            if secret.is_empty() {
                return Err(usage("Cloud shared key cannot be empty"));
            }
            api.request("PUT","/api/local/cloud-session",Some(json!({"remoteUrl":remote.origin().ascii_serialization(),"actorName":p.require("actor-name")?,"sharedKey":secret}))).await
        }
        ("issue", "list") => {
            p.count(0)?;
            if let Some(s) = p.get("status") {
                validate_status(s)?;
            }
            if p.get("archived")
                .is_some_and(|v| !["true", "false", "all"].contains(&v))
            {
                return Err(usage("--archived must be true, false, or all"));
            }
            api.request(
                "GET",
                &query(
                    "/api/tasks",
                    &[
                        ("projectId", p.get("project")),
                        ("status", p.get("status")),
                        ("archived", p.get("archived")),
                    ],
                ),
                None,
            )
            .await
        }
        ("issue", "get") => {
            p.count(1)?;
            api.request("GET", &task(p.operand(0)?), None).await
        }
        ("issue", "create" | "update") => {
            let create = p.action == "create";
            p.count(if create { 0 } else { 1 })?;
            let mut body = optional_fields(p, create)?;
            if create {
                p.require("project")?;
                p.require("title")?;
            } else if body.is_empty() && !p.has("agent-platform") {
                return Err(usage("issue update requires at least one field to update"));
            }
            body.extend(attribution(p)?.as_object().unwrap().clone());
            if !create {
                body.insert(
                    "version".into(),
                    json!(task_version(api, p.operand(0)?, p).await?),
                );
            }
            api.request(
                if create { "POST" } else { "PATCH" },
                &if create {
                    "/api/tasks".into()
                } else {
                    task(p.operand(0)?)
                },
                Some(Value::Object(body)),
            )
            .await
        }
        ("issue", "move" | "archive" | "restore") => {
            p.count(1)?;
            let id = p.operand(0)?;
            let mut body = attribution(p)?;
            body["version"] = json!(task_version(api, id, p).await?);
            if p.action == "move" {
                let status = p.require("status")?;
                validate_status(status)?;
                body["status"] = json!(status);
                if let Some(v) = binding(p)? {
                    body["threadBinding"] = v;
                }
            }
            api.request("POST", &format!("{}/{}", task(id), p.action), Some(body))
                .await
        }
        ("issue", "tree") => {
            p.count(1)?;
            let direction = p.require("direction")?;
            if !["descendants", "ancestors"].contains(&direction) {
                return Err(usage("--direction must be descendants or ancestors"));
            }
            let depth = p.require("depth")?;
            if !depth.chars().all(|c| c.is_ascii_digit())
                || !depth.parse::<u32>().is_ok_and(|d| (1..=25).contains(&d))
            {
                return Err(usage("--depth must be an integer from 1 to 25"));
            }
            api.request(
                "GET",
                &query(
                    &format!("{}/tree", task(p.operand(0)?)),
                    &[("direction", Some(direction)), ("depth", Some(depth))],
                ),
                None,
            )
            .await
        }
        ("issue", "relation") => {
            p.count(2)?;
            let action = p.operand(0)?;
            if !["add", "remove"].contains(&action) {
                return Err(usage("issue relation action must be add or remove"));
            }
            let kind = p.require("type")?;
            if !["parent", "blocks", "blocked_by", "related"].contains(&kind) {
                return Err(usage("Invalid relation type"));
            }
            let id = p.operand(1)?;
            let mut body = attribution(p)?;
            body["version"] = json!(task_version(api, id, p).await?);
            api.request(
                if action == "add" { "POST" } else { "DELETE" },
                &format!(
                    "{}/relations/{kind}/{}",
                    task(id),
                    encode(p.require("issue")?)
                ),
                Some(body),
            )
            .await
        }
        ("issue", "planning") | ("jira", "planning") => {
            p.count(2)?;
            let action = p.operand(0)?;
            let id = p.operand(1)?;
            let jira = p.resource == "jira";
            if action == "get" {
                if p.has("spec-file") || p.has("tickets-file") || p.has("if-version") {
                    return Err(usage("planning get does not accept write options"));
                }
                return api
                    .request(
                        "GET",
                        &format!(
                            "{}/{}",
                            task(id),
                            if jira { "jira-context" } else { "planning" }
                        ),
                        None,
                    )
                    .await;
            }
            let v = version(p.require("if-version")?, false)?;
            match action {
                "save" => {
                    if p.has("tickets-file") {
                        return Err(usage("planning save does not accept --tickets-file"));
                    }
                    api.request(
                        "PUT",
                        &format!(
                            "{}/{}/spec",
                            task(id),
                            if jira { "jira-planning" } else { "planning" }
                        ),
                        Some(json!({"version":v,"spec":file_text(p.require("spec-file")?)?})),
                    )
                    .await
                }
                "publish" if jira => {
                    if p.has("spec-file") {
                        return Err(usage("planning publish does not accept --spec-file"));
                    }
                    let manifest: Value = serde_json::from_str(&file_text(
                        p.require("tickets-file")?,
                    )?)
                    .map_err(|e| {
                        CliError::new("FILE_READ_FAILED", "Cannot read Jira ticket manifest", 2)
                            .detail(e)
                    })?;
                    let items = if manifest.is_array() {
                        manifest
                    } else {
                        manifest["items"].clone()
                    };
                    api.request(
                        "POST",
                        &format!("{}/jira-planning/publish", task(id)),
                        Some(json!({"version":v,"items":items})),
                    )
                    .await
                }
                _ => Err(usage("Invalid planning action")),
            }
        }
        ("jira", "repositories") => match p.operand(0)? {
            "list" => {
                p.count(1)?;
                if p.has("projects") || p.has("if-version") {
                    return Err(usage(
                        "jira repositories list does not accept write options",
                    ));
                }
                let projects = api.request("GET", "/api/projects", None).await?;
                let workspaces = api.request("GET", "/api/device-workspaces", None).await?;
                let saved = projects["projects"].as_array().cloned().unwrap_or_default();
                let mapped = workspaces["workspaces"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                let mut ids: Vec<String> = saved
                    .iter()
                    .filter_map(|p| p["id"].as_str().map(str::to_owned))
                    .collect();
                for id in mapped.keys() {
                    if !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
                let mut rows = Vec::new();
                for id in ids {
                    let project = saved.iter().find(|p| p["id"] == id);
                    let workspace = mapped
                        .get(&id)
                        .and_then(Value::as_str)
                        .or_else(|| project.and_then(|p| p["workspacePath"].as_str()));
                    if id == "local"
                        || project.is_some_and(|p| p["source"] == "jira")
                        || workspace.is_none()
                    {
                        continue;
                    }
                    let workspace = workspace.unwrap();
                    let name = project
                        .and_then(|p| p["name"].as_str())
                        .filter(|v| !v.is_empty())
                        .or_else(|| workspace.rsplit(['/', '\\']).find(|v| !v.is_empty()))
                        .unwrap_or(&id);
                    rows.push(json!({"id":id,"name":name,"workspacePath":workspace,"persisted":project.is_some()}));
                }
                Ok(json!({"repositories":rows}))
            }
            "set" => {
                p.count(2)?;
                let ids = labels(p.require("projects")?);
                if ids.is_empty() {
                    return Err(usage("--projects must contain at least one project id"));
                }
                api.request("PUT",&format!("{}/jira-context",task(p.operand(1)?)),Some(json!({"version":version(p.require("if-version")?,false)?,"projectIds":ids}))).await
            }
            _ => Err(usage("jira repositories expects: list | set JIRA_ID")),
        },
        ("comment", "list") => {
            p.count(1)?;
            api.request(
                "GET",
                &query(
                    &format!("{}/comments", task(p.operand(0)?)),
                    &[("after", p.get("after"))],
                ),
                None,
            )
            .await
        }
        ("comment", "add" | "update" | "delete") => {
            p.count(1)?;
            let mut body = attribution(p)?;
            let (method, path) = if p.action == "add" {
                body["body"] = json!(text_or_file(p, "body", "body-file", true)?);
                if let Some(v) = binding(p)? {
                    body["threadBinding"] = v;
                }
                ("POST", format!("{}/comments", task(p.operand(0)?)))
            } else {
                body["version"] = json!(version(p.require("if-version")?, false)?);
                if p.action == "update" {
                    body["body"] = json!(p.require("body")?);
                }
                (
                    if p.action == "update" {
                        "PATCH"
                    } else {
                        "DELETE"
                    },
                    format!("/api/comments/{}", encode(p.operand(0)?)),
                )
            };
            api.request(method, &path, Some(body)).await
        }
        ("attachment", "list" | "upload") => {
            p.count(0)?;
            if p.has("task") == p.has("comment") {
                return Err(usage(
                    "attachment requires exactly one of --task or --comment",
                ));
            }
            let (kind, id) = if let Some(id) = p.get("task") {
                ("task", id)
            } else {
                ("comment", p.require("comment")?)
            };
            let path = format!(
                "{}/attachments",
                if kind == "task" {
                    task(id)
                } else {
                    format!("/api/comments/{}", encode(id))
                }
            );
            if p.action == "list" {
                return api
                    .request("GET", &query(&path, &[("after", p.get("after"))]), None)
                    .await;
            }
            let file = absolute(p.require("file")?)?;
            let bytes = std::fs::read(&file).map_err(|e| file_error("read", &file, e))?;
            let filename = file
                .file_name()
                .and_then(|v| v.to_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| usage("Attachment --file must include a valid filename"))?;
            let content = p
                .get("content-type")
                .map(|v| v.trim().to_lowercase())
                .unwrap_or_else(|| mime(&file).into());
            if content.is_empty() {
                return Err(usage("--content-type cannot be empty"));
            }
            let attachment_kind = p.get("kind").unwrap_or(if content.starts_with("image/") {
                "inline"
            } else {
                "attachment"
            });
            if !["inline", "attachment"].contains(&attachment_kind) {
                return Err(usage("--kind must be inline or attachment"));
            }
            let raw = api
                .raw(
                    "POST",
                    &path,
                    Some(bytes),
                    &[
                        ("content-type", content),
                        ("x-panel-filename", encode(filename)),
                        ("x-panel-attachment-kind", attachment_kind.into()),
                    ],
                )
                .await?;
            let value: Value = serde_json::from_slice(&raw.bytes).map_err(|e| {
                CliError::new("INVALID_RESPONSE", "Panel service returned invalid JSON", 4)
                    .detail(e)
            })?;
            Ok(
                json!({"attachment":value["attachment"],"file":file,"kind":attachment_kind,"target":{"type":kind,"id":id}}),
            )
        }
        ("attachment", "download") => {
            p.count(1)?;
            let id = p.operand(0)?;
            let path = absolute(p.require("output")?)?;
            let raw = api
                .raw(
                    "GET",
                    &format!("/api/attachments/{}/content", encode(id)),
                    None,
                    &[("accept", "*/*".into())],
                )
                .await?;
            std::fs::write(&path, &raw.bytes).map_err(|e| file_error("write", &path, e))?;
            Ok(
                json!({"attachmentId":id,"output":path,"contentType":raw.content_type,"size":raw.bytes.len()}),
            )
        }
        ("context", "current") => {
            p.count(0)?;
            context(api, p.get("cwd")).await
        }
        _ => Err(usage("Unsupported command")),
    }
}

async fn context(api: &Api, cwd: Option<&str>) -> Result<Value> {
    let cwd = absolute(cwd.unwrap_or("."))?;
    let response = api.request("GET", "/api/projects", None).await?;
    let projects = response["projects"].as_array().cloned().unwrap_or_default();
    let matched = projects
        .iter()
        .filter_map(|p| {
            p["workspacePath"]
                .as_str()
                .and_then(|path| absolute(path).ok())
                .filter(|path| cwd.starts_with(path))
                .map(|path| (path.as_os_str().len(), p))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, p)| p)
        .or_else(|| projects.iter().find(|p| p["id"] == "local"))
        .or_else(|| projects.first())
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({"cwd":cwd,"project":matched}))
}
fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str]) -> Parsed {
        Parsed::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }
    #[test]
    fn rejects_duplicate_flags_and_preserves_literal_operands() {
        assert!(Parsed::parse(&["--json".into(), "--json".into()]).is_err());
        let p = parse(&["issue", "get", "--", "--literal"]);
        assert_eq!(p.operands, ["--literal"]);
    }
    #[test]
    fn separates_external_attribution_from_native_binding() {
        let p = parse(&[
            "comment",
            "add",
            "X",
            "--agent-platform",
            "pi",
            "--session-id",
            "/tmp/run one",
            "--clear-binding-thread",
        ]);
        assert_eq!(
            attribution(&p).unwrap(),
            json!({"agentSession":{"platform":"pi","sessionId":"/tmp/run one"}})
        );
        assert_eq!(binding(&p).unwrap(), Some(Value::Null));
        assert!(Parsed::parse(&[
            "--agent-platform".into(),
            "pi".into(),
            "--session-id".into(),
            "--bad".into()
        ])
        .is_err());
    }
    #[test]
    fn preserves_path_components_in_url_and_rejects_partial_binding() {
        assert_eq!(encode("a/b c"), "a%2Fb%20c");
        let p = parse(&[
            "--binding-thread-id",
            "t",
            "--binding-codex-project-id",
            "p",
        ]);
        assert!(binding(&p).is_err());
        assert!(version("-1", false).is_err());
        assert_eq!(version("0", true).unwrap(), 0);
    }
}
