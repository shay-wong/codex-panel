use crate::{shared_session::BoxFuture, ApiError};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;

pub type NativeRpc = Arc<dyn Fn(String, Value) -> BoxFuture + Send + Sync>;
pub type QuotaReader = Arc<dyn Fn(String) -> BoxFuture + Send + Sync>;

#[derive(Clone)]
struct Record {
    version: u64,
    request: Value,
    quota: Option<Value>,
}

pub struct PolicyManager {
    path: PathBuf,
    executable: PathBuf,
    runtime_file: Option<PathBuf>,
    records: Mutex<HashMap<String, Record>>,
    queues: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    timers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    persist: AsyncMutex<()>,
    rpc: Mutex<Option<NativeRpc>>,
    quota: QuotaReader,
    closed: AtomicBool,
}

impl PolicyManager {
    pub async fn new(
        data_directory: &Path,
        executable: &Path,
        runtime_file: Option<&Path>,
    ) -> Result<Arc<Self>, ApiError> {
        let workspace = data_directory.to_owned();
        let quota: QuotaReader = Arc::new(move |model| {
            let workspace = workspace.clone();
            Box::pin(async move { Ok(read_quota(&model, &workspace).await) })
        });
        Self::with_quota(data_directory, executable, runtime_file, quota).await
    }

    pub async fn new_with_codex(
        data_directory: &Path,
        executable: &Path,
        runtime_file: Option<&Path>,
        codex: PathBuf,
    ) -> Result<Arc<Self>, ApiError> {
        let workspace = data_directory.to_owned();
        // 自动化额度必须来自本次选定的 Codex，不能另行发现其他安装实例。
        let quota: QuotaReader = Arc::new(move |model| {
            let workspace = workspace.clone();
            let codex = codex.clone();
            Box::pin(
                async move { Ok(read_quota_with_executable(&model, &workspace, &codex).await) },
            )
        });
        Self::with_quota(data_directory, executable, runtime_file, quota).await
    }

    async fn with_quota(
        data_directory: &Path,
        executable: &Path,
        runtime_file: Option<&Path>,
        quota: QuotaReader,
    ) -> Result<Arc<Self>, ApiError> {
        let path = data_directory.join("codex-automation-policies.json");
        let saved = match tokio::fs::read(&path).await {
            Ok(data) => serde_json::from_slice::<Value>(&data)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(error) => return Err(error.into()),
        };
        let mut records = HashMap::new();
        if let Some(saved) = saved.as_object() {
            for value in saved.values() {
                if !value.is_object() {
                    continue;
                }
                let mut request = value.clone();
                let quota = request.as_object_mut().and_then(|o| o.remove("quota"));
                request["id"] = json!("restored-policy");
                request["action"] = json!("automation");
                request["requestId"] = json!("restored-policy");
                request["operation"] = json!("apply-policy");
                if validate(&request).is_ok() {
                    records.insert(
                        request["panelProjectId"].as_str().unwrap().into(),
                        Record {
                            version: 1,
                            request,
                            quota,
                        },
                    );
                }
            }
        }
        Ok(Arc::new(Self {
            path,
            executable: executable.into(),
            runtime_file: runtime_file.map(Path::to_owned),
            records: Mutex::new(records),
            queues: Mutex::new(HashMap::new()),
            timers: Mutex::new(HashMap::new()),
            persist: AsyncMutex::new(()),
            rpc: Mutex::new(None),
            quota,
            closed: AtomicBool::new(false),
        }))
    }

    pub async fn handle(
        self: &Arc<Self>,
        request: Value,
        rpc: NativeRpc,
    ) -> Result<Value, ApiError> {
        validate(&request)?;
        *self.rpc.lock().unwrap() = Some(rpc.clone());
        match request["operation"].as_str().unwrap() {
            "apply-policy" => {
                let key = request["panelProjectId"].as_str().unwrap().to_owned();
                // 版本分配与替换必须原子完成，防止并行请求获得相同版本并相互回滚。
                let (previous, version) = {
                    let mut records = self.records.lock().unwrap();
                    let previous = records.get(&key).cloned();
                    let version = previous.as_ref().map_or(1, |r| r.version + 1);
                    let quota = if request["quotaAware"] == true {
                        previous.as_ref().and_then(|r| r.quota.clone())
                    } else {
                        None
                    };
                    records.insert(
                        key.clone(),
                        Record {
                            version,
                            request,
                            quota,
                        },
                    );
                    (previous, version)
                };
                let applied = async {
                    self.save().await?;
                    self.mutate(&key, version, rpc, true).await
                }
                .await;
                if applied.is_err() {
                    let restored = {
                        let mut records = self.records.lock().unwrap();
                        if records
                            .get(&key)
                            .is_some_and(|record| record.version == version)
                        {
                            if let Some(previous) = previous {
                                records.insert(key, previous);
                            } else {
                                records.remove(&key);
                            }
                            true
                        } else {
                            false
                        }
                    };
                    if restored {
                        self.save().await?;
                    }
                }
                applied
            }
            "list" => {
                let key = request["panelProjectId"].as_str().unwrap();
                let record = self.records.lock().unwrap().get(key).cloned();
                if let Some(record) = record {
                    let mut result = self.mutate(key, record.version, rpc, false).await?;
                    if let Some(current) = self.records.lock().unwrap().get(key) {
                        result["policy"] = stored(&current.request);
                        if let Some(quota) = &current.quota {
                            result["quota"] = quota.clone();
                        }
                    }
                    Ok(result)
                } else {
                    reconcile(
                        &request,
                        rpc,
                        &self.executable,
                        self.runtime_file.as_deref(),
                    )
                    .await
                }
            }
            _ => {
                reconcile(
                    &request,
                    rpc,
                    &self.executable,
                    self.runtime_file.as_deref(),
                )
                .await
            }
        }
    }

    pub async fn restore(self: &Arc<Self>, rpc: NativeRpc) -> Result<(), ApiError> {
        *self.rpc.lock().unwrap() = Some(rpc.clone());
        let records = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| r.request["enabledByUser"] == true && r.request["quotaAware"] == true)
            .map(|(k, r)| (k.clone(), r.version))
            .collect::<Vec<_>>();
        for (key, version) in records {
            self.mutate(&key, version, rpc.clone(), false).await?;
        }
        Ok(())
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for (_, timer) in self.timers.lock().unwrap().drain() {
            timer.abort();
        }
        self.rpc.lock().unwrap().take();
    }

    async fn save(&self) -> Result<(), ApiError> {
        let _guard = self.persist.lock().await;
        let value = {
            let records = self.records.lock().unwrap();
            let mut data = json!({});
            for (key, record) in records.iter() {
                let mut item = stored(&record.request);
                if let Some(quota) = &record.quota {
                    item["quota"] = quota.clone();
                }
                data[key] = item;
            }
            data
        };
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        use tokio::io::AsyncWriteExt;
        let result = async {
            let mut file = options.open(&temporary).await?;
            file.write_all(format!("{value}\n").as_bytes()).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &self.path).await?;
            Ok::<_, ApiError>(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result
    }

    async fn mutate(
        self: &Arc<Self>,
        key: &str,
        version: u64,
        rpc: NativeRpc,
        explicit: bool,
    ) -> Result<Value, ApiError> {
        let queue = self
            .queues
            .lock()
            .unwrap()
            .entry(key.into())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _guard = queue.lock().await;
        let record = self
            .records
            .lock()
            .unwrap()
            .get(key)
            .filter(|r| r.version == version)
            .cloned();
        let Some(record) = record else {
            return Ok(json!({"stale":true}));
        };
        if self.closed.load(Ordering::SeqCst) {
            return Ok(json!({"stale":true}));
        }
        // 等待项目队列期间主窗口可能已重连，后台检查使用最新的原生连接。
        let rpc = if explicit {
            rpc
        } else {
            self.rpc.lock().unwrap().clone().unwrap_or(rpc)
        };
        let quota = if record.request["quotaAware"] == true {
            Some((self.quota)(record.request["model"].as_str().unwrap().into()).await?)
        } else {
            None
        };
        if !self
            .records
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|r| r.version == version)
        {
            return Ok(json!({"quota":quota,"stale":true}));
        }
        let mut listed = None;
        let mut current = Value::Null;
        if !explicit && record.request["enabledByUser"] == true {
            let mut request = record.request.clone();
            request["operation"] = json!("list");
            let result = reconcile(
                &request,
                rpc.clone(),
                &self.executable,
                self.runtime_file.as_deref(),
            )
            .await?;
            if let Some(items) = result["items"].as_array() {
                current = items
                    .iter()
                    .find(|i| i["id"] == record.request["automationId"])
                    .or_else(|| items.first())
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            listed = Some(result);
        }
        let operation = policy_operation(
            &record.request,
            explicit,
            record.quota.as_ref().and_then(|q| q["state"].as_str()),
            quota.as_ref().and_then(|q| q["state"].as_str()),
            current["status"].as_str(),
        );
        let mut result = if operation == "list" {
            json!({"item":current,"items":listed.as_ref().map(|v|v["items"].clone()).unwrap_or(json!([]))})
        } else {
            let mut request = record.request.clone();
            request["operation"] = json!(operation);
            reconcile(
                &request,
                rpc,
                &self.executable,
                self.runtime_file.as_deref(),
            )
            .await?
        };
        if result["error"] == "not-found" {
            result = json!({});
        }
        result["operation"] = json!(operation);
        if let Some(quota) = &quota {
            result["quota"] = quota.clone();
        }
        let next = {
            let mut records = self.records.lock().unwrap();
            let Some(current) = records.get_mut(key).filter(|r| r.version == version) else {
                return Ok(json!({"stale":true}));
            };
            if !explicit && operation == "list" && result["item"]["status"] == "PAUSED" {
                current.version += 1;
                current.request["enabledByUser"] = json!(false);
            }
            if let Some(id) = result["item"]["id"].as_str() {
                current.request["automationId"] = json!(id);
            }
            current.quota = quota;
            current.clone()
        };
        self.save().await?;
        self.schedule(key.to_owned(), next, &result);
        Ok(result)
    }

    fn schedule(self: &Arc<Self>, key: String, record: Record, result: &Value) {
        if let Some(timer) = self.timers.lock().unwrap().remove(&key) {
            timer.abort();
        }
        if record.request["enabledByUser"] != true
            || record.request["quotaAware"] != true
            || self.closed.load(Ordering::SeqCst)
        {
            return;
        }
        let delay = schedule_delay(result, chrono::Utc::now().timestamp_millis());
        let weak = Arc::downgrade(self);
        let timer_key = key.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let Some(manager) = weak.upgrade() else {
                return;
            };
            manager.timers.lock().unwrap().remove(&timer_key);
            if !manager
                .records
                .lock()
                .unwrap()
                .get(&timer_key)
                .is_some_and(|r| r.version == record.version)
            {
                return;
            }
            let rpc = manager.rpc.lock().unwrap().clone();
            if let Some(rpc) = rpc {
                let retry = manager.clone();
                let retry_key = timer_key.clone();
                let result: BoxFuture =
                    Box::pin(
                        async move { retry.mutate(&retry_key, record.version, rpc, false).await },
                    );
                if let Err(error) = result.await {
                    eprintln!("Panel quota policy check failed: {}", error.message);
                    let current = manager
                        .records
                        .lock()
                        .unwrap()
                        .get(&timer_key)
                        .filter(|r| r.version == record.version)
                        .cloned();
                    if let Some(current) = current {
                        manager.schedule(timer_key, current, &json!({"quota":{"state":"unknown"}}));
                    }
                }
            } else {
                manager.schedule(timer_key, record, &json!({"quota":{"state":"unknown"}}));
            }
        });
        self.timers.lock().unwrap().insert(key, task.abort_handle());
    }
}

impl Drop for PolicyManager {
    fn drop(&mut self) {
        self.close();
    }
}

fn stored(request: &Value) -> Value {
    let mut value = json!({});
    for key in [
        "panelProjectId",
        "codexProjectId",
        "projectName",
        "workspacePath",
        "skillPath",
        "automationId",
        "enabledByUser",
        "quotaAware",
        "intervalMinutes",
        "model",
        "reasoningEffort",
    ] {
        if let Some(field) = request.get(key) {
            value[key] = field.clone();
        }
    }
    value
}

pub fn validate(request: &Value) -> Result<(), ApiError> {
    let error = || {
        ApiError::new(
            400,
            "AUTOMATION_REQUEST",
            "Invalid Panel automation host request",
        )
    };
    let object = request.as_object().ok_or_else(error)?;
    let fields = [
        "id",
        "action",
        "requestId",
        "operation",
        "panelProjectId",
        "codexProjectId",
        "projectName",
        "workspacePath",
        "skillPath",
        "automationId",
        "enabledByUser",
        "quotaAware",
        "intervalMinutes",
        "model",
        "reasoningEffort",
    ];
    if object.keys().any(|key| !fields.contains(&key.as_str()))
        || request["action"] != "automation"
        || !["ensure-active", "pause", "list", "apply-policy"]
            .contains(&request["operation"].as_str().unwrap_or(""))
    {
        return Err(error());
    }
    for (key, max) in [("id", 80), ("requestId", 100)] {
        let text = request[key].as_str().ok_or_else(error)?;
        if text.is_empty()
            || text.len() > max
            || !text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(error());
        }
    }
    let project = request["panelProjectId"].as_str().ok_or_else(error)?;
    if project.is_empty()
        || project.len() > 128
        || !project
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || [b'.', b'_', b'-'].contains(&c))
    {
        return Err(error());
    }
    for (key, max) in [
        ("codexProjectId", 256),
        ("projectName", 200),
        ("workspacePath", 2048),
        ("skillPath", 2048),
    ] {
        let value = request[key].as_str().ok_or_else(error)?;
        if value.is_empty()
            || value.trim() != value
            || value.encode_utf16().count() > max
            || value.chars().any(char::is_control)
        {
            return Err(error());
        }
    }
    for key in ["workspacePath", "skillPath"] {
        if !Path::new(request[key].as_str().unwrap()).is_absolute() {
            return Err(error());
        }
    }
    if !request["enabledByUser"].is_boolean()
        || !request["quotaAware"].is_boolean()
        || !request["intervalMinutes"]
            .as_u64()
            .is_some_and(|n| [5, 10, 15, 30, 60].contains(&n))
        || !supported(
            request["model"].as_str().unwrap_or(""),
            request["reasoningEffort"].as_str().unwrap_or(""),
        )
    {
        return Err(error());
    }
    if let Some(id) = request.get("automationId") {
        let id = id.as_str().ok_or_else(error)?;
        if id.is_empty()
            || id.trim() != id
            || id.encode_utf16().count() > 256
            || id.chars().any(char::is_control)
        {
            return Err(error());
        }
    }
    Ok(())
}

fn supported(model: &str, effort: &str) -> bool {
    let maximum = match model {
        "gpt-6.1-sol" | "gpt-6-astra" | "gpt-6-sol" | "gpt-5.6-sol" | "gpt-5.6-terra" => 6,
        "gpt-6-luna" | "gpt-5.6-luna" => 5,
        "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" => 4,
        _ => return false,
    };
    ["low", "medium", "high", "xhigh", "max", "ultra"][..maximum].contains(&effort)
}

pub fn policy_operation(
    request: &Value,
    explicit: bool,
    previous: Option<&str>,
    quota: Option<&str>,
    status: Option<&str>,
) -> &'static str {
    if request["enabledByUser"] != true {
        return "pause";
    }
    if !explicit
        && status == Some("PAUSED")
        && (request["quotaAware"] != true || previous == Some("available"))
    {
        return "list";
    }
    if request["quotaAware"] == true && quota != Some("available") {
        return "pause";
    }
    "ensure-active"
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn spec(request: &Value, executable: &Path, runtime_file: Option<&Path>) -> Value {
    let project = request["panelProjectId"].as_str().unwrap();
    let name = format!("Panel 自动认领 · {project}");
    let command = format!(
        "{}{} ctl",
        runtime_file
            .map(|path| format!(
                "CODEX_PANEL_RUNTIME_FILE={} ",
                quote(&path.to_string_lossy())
            ))
            .unwrap_or_default(),
        quote(&executable.to_string_lossy())
    );
    let prompt=format!("[$manage-panel]({}) e-panel 每 {} 分钟检查任务面板中的「{}」项目（项目 ID：{project}，项目目录：{}）。\n本轮所有 panelctl 操作都使用完整命令前缀 {command}，不要使用 PATH 中的 panelctl。\n开始时先运行 {command} issue list --project {project} --status todo --json。若没有 todo，使用 Codex automation_update 将名为「{name}」的当前自动化设为 PAUSED，保留其他字段，然后结束；不要创建或打开新的任务会话。\n每次仅处理一个 todo：选定后用 issue get 读取最新议题内容，并用 comment list 读取全部评论，确认是否包含已完成后被打回的返工要求。\n认领时使用最新 version 将议题移动到 in_progress；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。\n若 issue get 返回 threadId，认领时将 --thread-id 设为该值以保留绑定，再使用 Codex send_message_to_thread 向原会话发送继续处理此议题的指令；当前自动化会话不要重复处理。若没有 threadId，则在当前自动化会话处理。\n若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。\n执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。\n本次处理或交接后，再次运行 {command} issue list --project {project} --status todo --json。若没有 todo，使用 Codex automation_update 将名为「{name}」的当前自动化设为 PAUSED，保留其他字段，避免后续创建空会话。",request["skillPath"].as_str().unwrap(),request["intervalMinutes"],request["projectName"].as_str().unwrap(),request["workspacePath"].as_str().unwrap());
    json!({"kind":"cron","name":name,"prompt":prompt,"projectId":request["codexProjectId"],"executionEnvironment":"local","localEnvironmentConfigPath":null,"model":request["model"],"reasoningEffort":request["reasoningEffort"],"rrule":format!("RRULE:FREQ=MINUTELY;INTERVAL={}",request["intervalMinutes"])})
}

async fn reconcile(
    request: &Value,
    rpc: NativeRpc,
    executable: &Path,
    runtime_file: Option<&Path>,
) -> Result<Value, ApiError> {
    let listed = rpc("list-automations".into(), json!({})).await?;
    let name = format!(
        "Panel 自动认领 · {}",
        request["panelProjectId"].as_str().unwrap()
    );
    let legacy = format!(
        "Taskboard 自动认领 · {}",
        request["panelProjectId"].as_str().unwrap()
    );
    let matching = listed["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["name"] == name || item["name"] == legacy)
        .cloned()
        .collect::<Vec<_>>();
    if request["operation"] == "list" {
        return Ok(json!({"items":matching.iter().filter_map(sanitize).collect::<Vec<_>>()}));
    }
    let existing = matching
        .iter()
        .find(|item| request["automationId"].is_string() && item["id"] == request["automationId"])
        .or_else(|| matching.first());
    let mut spec = spec(request, executable, runtime_file);
    let status = if request["operation"] == "pause" {
        "PAUSED"
    } else {
        "ACTIVE"
    };
    if let Some(existing) = existing {
        if existing["status"] == status
            && spec.as_object().unwrap().iter().all(|(field, value)| {
                if field == "projectId" {
                    existing
                        .get(field)
                        .or_else(|| existing.pointer("/target/projectId"))
                        == Some(value)
                } else {
                    existing.get(field) == Some(value)
                }
            })
        {
            return Ok(json!({"item":existing}));
        }
        spec["id"] = existing["id"].clone();
        spec["status"] = json!(status);
        rpc("automation-update".into(), spec).await
    } else if status == "PAUSED" {
        Ok(json!({"error":"not-found"}))
    } else {
        rpc("automation-create".into(), spec).await
    }
}

fn sanitize(item: &Value) -> Option<Value> {
    let id = item["id"].as_str()?;
    if id.is_empty()
        || id.len() > 256
        || !["ACTIVE", "PAUSED"].contains(&item["status"].as_str()?)
        || !supported(item["model"].as_str()?, item["reasoningEffort"].as_str()?)
    {
        return None;
    }
    let rule = item["rrule"].as_str()?;
    if ![5, 10, 15, 30, 60]
        .iter()
        .any(|n| rule == format!("RRULE:FREQ=MINUTELY;INTERVAL={n}"))
    {
        return None;
    }
    let mut value = json!({"id":id,"status":item["status"],"model":item["model"],"reasoningEffort":item["reasoningEffort"],"rrule":rule});
    if item["nextRunAt"].is_null() || item["nextRunAt"].is_number() {
        value["nextRunAt"] = item["nextRunAt"].clone();
    }
    Some(value)
}

fn schedule_delay(result: &Value, now: i64) -> u64 {
    let next = result["item"]["nextRunAt"]
        .as_i64()
        .filter(|n| *n > now)
        .map(|n| (n - now - 15_000).max(1000))
        .unwrap_or(60_000);
    let reset = if result["quota"]["state"] == "blocked" {
        result["quota"]["resetsAt"]
            .as_i64()
            .map(|n| (n.saturating_mul(1000) - now + 1000).max(1000))
            .unwrap_or(next)
    } else {
        next
    };
    next.min(reset) as u64
}

pub async fn read_quota(model: &str, workspace: &Path) -> Value {
    match crate::server::codex::executable() {
        Ok(executable) => read_quota_with_executable(model, workspace, &executable).await,
        Err(_) => json!({"state":"unknown","checkedAt":chrono::Utc::now().timestamp_millis()}),
    }
}

async fn read_quota_with_executable(model: &str, workspace: &Path, executable: &Path) -> Value {
    let checked = chrono::Utc::now().timestamp_millis();
    let result = async {
        let connection = crate::server::codex::Connection::start(executable, workspace).await?;
        let result = async {
            let account = connection
                .request("account/read", json!({"refreshToken":false}))
                .await?;
            if account["account"]["type"] == "apiKey" {
                return Ok(json!({"state":"unavailable","reason":"api-key","checkedAt":checked}));
            }
            if account["account"]["type"] != "chatgpt" {
                return Ok(json!({"state":"unknown","checkedAt":checked}));
            }
            Ok::<_, ApiError>(evaluate_quota(
                &connection
                    .request("account/rateLimits/read", json!({}))
                    .await?,
                model,
                checked,
            ))
        }
        .await;
        connection.close().await;
        result
    };
    match tokio::time::timeout(Duration::from_secs(8), result).await {
        Ok(Ok(value)) => value,
        _ => json!({"state":"unknown","checkedAt":checked}),
    }
}

pub fn evaluate_quota(result: &Value, model: &str, checked: i64) -> Value {
    let name = |value: &str| {
        value
            .to_ascii_lowercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
    };
    let entries = result["rateLimitsByLimitId"].as_object();
    let snapshot = entries
        .and_then(|values| {
            values.values().find(|v| {
                v["limitName"]
                    .as_str()
                    .is_some_and(|v| name(v) == name(model))
            })
        })
        .or_else(|| entries.and_then(|values| values.get("codex")))
        .or_else(|| result.get("rateLimits"))
        .filter(|v| v.is_object());
    let Some(snapshot) = snapshot else {
        return json!({"state":"unknown","checkedAt":checked});
    };
    let windows = [snapshot.get("primary"), snapshot.get("secondary")]
        .into_iter()
        .flatten()
        .filter(|v| !v.is_null())
        .collect::<Vec<_>>();
    let credits =
        snapshot["credits"]["unlimited"] == true || snapshot["credits"]["hasCredits"] == true;
    let exhausted = windows
        .iter()
        .copied()
        .filter(|w| w["usedPercent"].as_f64().is_some_and(|v| v >= 100.))
        .collect::<Vec<_>>();
    let individual = snapshot
        .get("individualLimit")
        .and_then(|v| v.get("remainingPercent"))
        .and_then(Value::as_f64)
        .is_some_and(|v| v <= 0.);
    let explicit = snapshot
        .get("rateLimitReachedType")
        .is_some_and(|v| !v.is_null() && v != false && v != "")
        || snapshot["spendControlReached"] == true;
    if !explicit && !individual && (exhausted.is_empty() || credits) {
        return json!({"state":"available","checkedAt":checked});
    }
    let mut resets = exhausted
        .iter()
        .filter_map(|w| w["resetsAt"].as_f64())
        .collect::<Vec<_>>();
    if let Some(reset) = snapshot["individualLimit"]["resetsAt"].as_f64() {
        resets.push(reset);
    }
    if explicit {
        resets.extend(windows.iter().filter_map(|w| w["resetsAt"].as_f64()));
    }
    let mut value = json!({"state":"blocked","checkedAt":checked});
    if let Some(reset) = resets
        .into_iter()
        .filter(|v| v.is_finite())
        .reduce(f64::max)
    {
        value["resetsAt"] = json!(reset);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"id":"test-1","action":"automation","requestId":"test-1","operation":"apply-policy","panelProjectId":"project","codexProjectId":"native-project","projectName":"项目","workspacePath":"/tmp/work","skillPath":"/tmp/SKILL.md","enabledByUser":true,"quotaAware":true,"intervalMinutes":5,"model":"gpt-6.1-sol","reasoningEffort":"low"})
    }
    #[test]
    fn quota_policy_never_resumes_a_manually_paused_available_account() {
        let request = request();
        assert_eq!(
            policy_operation(
                &request,
                false,
                Some("available"),
                Some("available"),
                Some("PAUSED")
            ),
            "list"
        );
        assert_eq!(
            policy_operation(
                &request,
                false,
                Some("blocked"),
                Some("available"),
                Some("PAUSED")
            ),
            "ensure-active"
        );
        assert_eq!(
            policy_operation(
                &request,
                true,
                Some("available"),
                Some("unknown"),
                Some("ACTIVE")
            ),
            "pause"
        );
    }
    #[test]
    fn model_specific_limits_take_precedence_and_credits_cover_usage_windows() {
        let result = json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":100,"resetsAt":900}},"model":{"limitName":"GPT 6.1 SOL","primary":{"usedPercent":100,"resetsAt":1000},"credits":{"hasCredits":true}}}});
        assert_eq!(
            evaluate_quota(&result, "gpt-6.1-sol", 1)["state"],
            "available"
        );
        assert_eq!(evaluate_quota(&result, "unknown", 1)["state"], "blocked");
        let result =
            json!({"rateLimits":{"individualLimit":{"remainingPercent":0,"resetsAt":1200}}});
        assert_eq!(
            evaluate_quota(&result, "gpt-6.1-sol", 1)["resetsAt"],
            1200.0
        );
    }
    #[tokio::test]
    async fn rejected_native_mutation_restores_the_previous_persisted_policy() {
        let directory = tempfile::tempdir().unwrap();
        let quota: QuotaReader =
            Arc::new(|_| Box::pin(async { Ok(json!({"state":"available","checkedAt":1})) }));
        let manager = PolicyManager::with_quota(
            directory.path(),
            &std::env::current_exe().unwrap(),
            None,
            quota,
        )
        .await
        .unwrap();
        let fail: NativeRpc = Arc::new(|method, _| {
            Box::pin(async move {
                if method == "list-automations" {
                    Ok(json!({"items":[]}))
                } else {
                    Err(ApiError::new(
                        502,
                        "NATIVE_FAILURE",
                        "fixture rejected mutation",
                    ))
                }
            })
        });
        assert!(manager.handle(request(), fail).await.is_err());
        let saved: Value = serde_json::from_slice(
            &std::fs::read(directory.path().join("codex-automation-policies.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved, json!({}));
        manager.close();
    }
    #[tokio::test]
    async fn malformed_policy_entries_are_ignored_without_panicking() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("codex-automation-policies.json"),
            r#"{"string":"bad","number":1,"array":[],"null":null}"#,
        )
        .unwrap();
        let quota: QuotaReader = Arc::new(|_| Box::pin(async { Ok(json!({"state":"available"})) }));
        let manager = PolicyManager::with_quota(
            directory.path(),
            &std::env::current_exe().unwrap(),
            None,
            quota,
        )
        .await
        .unwrap();
        assert!(manager.records.lock().unwrap().is_empty());
        manager.close();
    }
}
