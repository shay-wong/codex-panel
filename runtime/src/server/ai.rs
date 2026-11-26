use super::{codex, store, validate as v, AppState};
use crate::ApiError;
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Context {
    pub project: Value,
    pub issue: Value,
    pub workspace: String,
    pub target: Option<Value>,
    pub add_directories: Vec<String>,
}

pub struct ActiveTurn {
    pub pid: u32,
    pub interrupted: Arc<std::sync::atomic::AtomicBool>,
    pub target: Option<Value>,
    pub connection: Option<Arc<codex::Connection>>,
    pub codex_thread: String,
    pub turn_id: Arc<std::sync::Mutex<Option<String>>>,
}

struct PendingAttachments(Option<PathBuf>);
impl PendingAttachments {
    fn as_ref(&self) -> Option<&PathBuf> {
        self.0.as_ref()
    }
    fn take(&mut self) -> Option<PathBuf> {
        self.0.take()
    }
}
impl Drop for PendingAttachments {
    fn drop(&mut self) {
        // 后台任务接管前的任何提前返回，都不能留下用户上传的临时附件。
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

pub async fn context(
    state: &AppState,
    project_id: &str,
    issue_id: Option<&str>,
    target: Option<&Value>,
) -> Result<Context, ApiError> {
    v::project_id(project_id)?;
    if let Some(target) = target {
        let fields = [
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
        ];
        let present = fields
            .iter()
            .filter(|key| target.get(**key).is_some_and(|v| !v.is_null()))
            .count();
        if present > 0 {
            if present != fields.len() {
                return Err(ApiError::new(
                    400,
                    "INVALID_CODEX_TARGET",
                    "Codex project identity must contain all four fields",
                ));
            }
            for key in fields {
                v::required_string(
                    target.get(key),
                    key,
                    if key == "workspacePath" { 4096 } else { 512 },
                )?;
            }
            if !["local", "remote"].contains(&target["codexProjectKind"].as_str().unwrap_or(""))
                || target["workspacePath"]
                    .as_str()
                    .is_some_and(|s| s.contains('\0'))
            {
                return Err(ApiError::new(
                    400,
                    "INVALID_CODEX_TARGET",
                    "Codex project identity is invalid",
                ));
            }
        }
    }
    let cloud = store::read(
        &state.config.data_dir.join("cloud-companion.json"),
        store::empty_cloud(),
    )
    .await?;
    let cloud_mode = cloud["remoteUrl"].is_string();
    let project = if cloud_mode {
        let projects = cloud_json(state, &cloud, "/api/projects").await?;
        projects["projects"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == project_id))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        state.db("getProject", &[json!(project_id)])?
    };
    if project.is_null() {
        return Err(ApiError::new(
            404,
            "PROJECT_NOT_FOUND",
            format!("Project '{project_id}' does not exist"),
        ));
    }
    let issue = if let Some(id) = issue_id {
        let issue = if cloud_mode {
            cloud_json(
                state,
                &cloud,
                &format!(
                    "/api/tasks/{}",
                    url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
                ),
            )
            .await?["task"]
                .clone()
        } else {
            state.db("getTask", &[json!(id)])?
        };
        if issue.is_null() || issue["projectId"] != project_id || !issue["archivedAt"].is_null() {
            return Err(ApiError::new(
                404,
                "AI_CHAT_ISSUE_NOT_FOUND",
                format!("Task '{id}' is not an active task in project '{project_id}'"),
            ));
        }
        issue
    } else {
        Value::Null
    };
    if let Some(target) = target.filter(|target| target["codexProjectKind"] == "remote") {
        for key in ["codexProjectId", "codexHostId", "workspacePath"] {
            v::required_string(target.get(key), key, 4096)?;
        }
        let workspace = target["workspacePath"].as_str().unwrap();
        if workspace.contains('\0') || target["codexHostId"] == "local" {
            return Err(ApiError::new(
                400,
                "INVALID_CODEX_TARGET",
                "Remote project identity is invalid",
            ));
        }
        return Ok(Context {
            project,
            issue,
            workspace: workspace.into(),
            target: Some(target.clone()),
            add_directories: Vec::new(),
        });
    }
    let device = super::routes::device_workspaces(state).await?;
    let path = if issue["developmentContext"]["type"] == "worktree" {
        issue["developmentContext"]["path"].as_str()
    } else if cloud["remoteUrl"].is_string() {
        cloud["projectMappings"][project_id].as_str()
    } else {
        device[project_id]
            .as_str()
            .or_else(|| project["workspacePath"].as_str())
            .or_else(|| {
                if project_id == "local" {
                    state.config.project_root.to_str()
                } else {
                    None
                }
            })
    };
    let Some(path) = path else {
        return Err(ApiError::new(
            409,
            "PROJECT_WORKSPACE_UNAVAILABLE",
            format!("Project '{project_id}' has no available device workspace"),
        ));
    };
    let canonical = tokio::fs::canonicalize(path).await.map_err(|_| {
        ApiError::new(
            409,
            "PROJECT_WORKSPACE_UNAVAILABLE",
            "The project workspace is not available on this device",
        )
    })?;
    if !canonical.is_dir() {
        return Err(ApiError::new(
            409,
            "PROJECT_WORKSPACE_UNAVAILABLE",
            "The project workspace is not a directory",
        ));
    }
    let workspace = canonical.to_string_lossy().into_owned();
    let mut add_directories = Vec::new();
    let projects = state.db("listProjects", &[])?;
    for candidate in device
        .as_object()
        .into_iter()
        .flat_map(|v| v.values())
        .chain(
            projects
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p.get("workspacePath")),
        )
    {
        if let Some(path) = candidate.as_str() {
            if let Ok(path) = tokio::fs::canonicalize(path).await {
                let path = path.to_string_lossy().into_owned();
                if path != workspace
                    && Path::new(&path).is_dir()
                    && !add_directories.contains(&path)
                {
                    add_directories.push(path);
                }
            }
        }
    }
    Ok(Context {
        project,
        issue,
        workspace,
        target: None,
        add_directories,
    })
}

async fn cloud_json(state: &AppState, cloud: &Value, path: &str) -> Result<Value, ApiError> {
    let origin = store::cloud_url(&cloud["remoteUrl"])?;
    let response = state
        .client
        .get(format!("{origin}{path}"))
        .basic_auth(
            cloud["actorName"].as_str().unwrap_or(""),
            cloud["sharedKey"].as_str(),
        )
        .send()
        .await?;
    let status = response.status().as_u16();
    let value: Value = response.json().await?;
    if status >= 400 {
        return Err(ApiError::new(
            status,
            value["error"]["code"].as_str().unwrap_or("CLOUD_ERROR"),
            value["error"]["message"]
                .as_str()
                .unwrap_or("Cloud request failed"),
        ));
    }
    Ok(value)
}

pub(super) async fn request(
    state: &AppState,
    context: &Context,
    connection: Option<&Arc<codex::Connection>>,
    method: &str,
    params: Value,
) -> Result<Value, ApiError> {
    if let Some(target) = &context.target {
        let runtime = std::env::var_os("CODEX_PANEL_RUNTIME_FILE")
            .or_else(|| std::env::var_os("CODEX_TASKBOARD_RUNTIME_FILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| state.config.data_dir.join("launcher-runtime.json"));
        crate::injector::control_request(&runtime,"app-server",json!({"hostId":target["codexHostId"],"method":method,"params":params,"timeoutMs":30_000})).await
    } else {
        connection
            .ok_or_else(|| {
                ApiError::new(502, "CODEX_UNAVAILABLE", "Codex app-server is unavailable")
            })?
            .request(method, params)
            .await
    }
}

pub async fn catalog(state: &AppState, context: &Context) -> Result<Value, ApiError> {
    let connection = if context.target.is_none() {
        Some(codex::Connection::start(&codex::executable()?, Path::new(&context.workspace)).await?)
    } else {
        None
    };
    let result=async{
        let mut models=Vec::new();let mut cursor=Value::Null;let mut cursors=HashSet::new();
        loop{
            let page=request(state,context,connection.as_ref(),"model/list",json!({"cursor":cursor,"limit":100,"includeHidden":false})).await?;
            let entries=page["data"].as_array().ok_or_else(||ApiError::new(502,"INVALID_MODEL_CATALOG","Codex returned an invalid model catalog"))?;
            for model in entries{
                if model["hidden"]==true{continue;}
                let Some(slug)=model["model"].as_str().map(str::trim).filter(|s|!s.is_empty())else{continue;};
                let mut efforts=Vec::new();let mut seen=HashSet::new();
                for entry in model["supportedReasoningEfforts"].as_array().into_iter().flatten(){if let Some(effort)=entry["reasoningEffort"].as_str().map(str::trim).filter(|s|!s.is_empty()){if seen.insert(effort){efforts.push(json!(effort));}}}
                let tiers=model["serviceTiers"].as_array().into_iter().flatten().filter_map(|tier|{
                    let id=tier["id"].as_str()?.trim();let name=tier["name"].as_str()?.trim();
                    if id.is_empty()||name.is_empty(){None}else{Some(json!({"id":id,"name":name}))}
                }).collect::<Vec<_>>();
                let display=model["displayName"].as_str().map(str::trim).filter(|s|!s.is_empty()).unwrap_or(slug);
                models.push(json!({"slug":slug,"displayName":display,"description":model["description"].as_str().unwrap_or(""),"defaultReasoningEffort":model["defaultReasoningEffort"].as_str().unwrap_or("").trim(),"supportedReasoningEfforts":efforts,"serviceTiers":tiers}));
            }
            cursor=page.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null(){break;}
            if !cursors.insert(cursor.to_string()){return Err(ApiError::new(502,"INVALID_MODEL_CATALOG","Codex model catalog repeated a pagination cursor"));}
        }
        let response=request(state,context,connection.as_ref(),"skills/list",json!({"cwds":[context.workspace],"forceReload":false})).await?;
        let mut skills=sanitize_skills(&response["data"]);
        if context.target.is_none(){include_linked_skills(&mut skills).await?;}
        let command_catalog:Value=serde_json::from_str(include_str!("../../../server/codex-slash-commands-0.139.0.json"))?;
        let platform=if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"};
        let commands=command_catalog["commands"].as_array().into_iter().flatten().filter_map(|command|{
            let id=command["id"].as_str()?;let description=command["description"].as_str()?;
            if command["debugOnly"]==true || command.get("platforms").and_then(Value::as_array).is_some_and(|values|!values.iter().any(|v|v==platform)) || command.get("excludedPlatforms").and_then(Value::as_array).is_some_and(|values|values.iter().any(|v|v==platform)){return None;}
            if !regex::Regex::new(r"^[a-z][a-z0-9-]*$").unwrap().is_match(id){return None;}
            Some(json!({"id":id,"label":format!("/{id}"),"description":description,"insertText":format!("/{id}{}",if command["supportsInlineArgs"]==true{" "}else{""})}))
        }).collect::<Vec<_>>();
        Ok(json!({"models":models,"skills":skills,"commands":commands,"sandboxes":["read-only","workspace-write","danger-full-access"]}))
    }.await;
    if let Some(connection) = connection {
        connection.close().await;
    }
    result
}

pub(super) fn sanitize_skills(entries: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for entry in entries.as_array().into_iter().flatten() {
        for skill in entry["skills"].as_array().into_iter().flatten() {
            if skill["enabled"] == false {
                continue;
            }
            let Some(id) = skill["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            let label = skill
                .pointer("/interface/displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            let scope = skill["scope"]
                .as_str()
                .filter(|v| ["user", "repo", "system", "admin"].contains(v))
                .unwrap_or("user");
            skills.push(json!({"id":id,"label":label,"description":skill["description"].as_str().unwrap_or("").trim(),"path":skill["path"].as_str().unwrap_or("").trim(),"scope":scope}));
        }
    }
    skills.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    skills
}

pub(super) async fn include_linked_skills(skills: &mut Vec<Value>) -> Result<(), ApiError> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Ok(());
    };
    let root = PathBuf::from(home).join(".agents/skills");
    let mut entries = match tokio::fs::read_dir(&root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut seen = skills
        .iter()
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if seen.contains(&name) {
            continue;
        }
        let path = entry.path().join("SKILL.md");
        let Ok(source) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let source = source.replace("\r\n", "\n");
        let Some(frontmatter) = source
            .strip_prefix("---\n")
            .and_then(|s| s.split_once("\n---").map(|(meta, _)| meta))
        else {
            continue;
        };
        let Ok(metadata) = serde_yaml::from_str::<Value>(frontmatter) else {
            continue;
        };
        if metadata["name"] != name {
            continue;
        }
        let Some(description) = metadata["description"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let interface = tokio::fs::read_to_string(entry.path().join("agents/openai.yaml"))
            .await
            .ok()
            .and_then(|s| serde_yaml::from_str::<Value>(&s).ok());
        let label = interface
            .as_ref()
            .and_then(|v| v.pointer("/interface/display_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&name);
        skills.push(json!({"id":name,"label":label,"description":description,"path":path,"scope":"user","canonicalPath":tokio::fs::canonicalize(&path).await.unwrap_or(path)}));
        seen.insert(name);
    }
    skills.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    Ok(())
}

pub fn thread(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let value = state.db("getAiChatThread", &[json!(id)])?;
    if value.is_null() {
        Err(ApiError::new(
            404,
            "AI_CHAT_THREAD_NOT_FOUND",
            format!("AI chat thread '{id}' does not exist"),
        ))
    } else {
        Ok(value)
    }
}

pub async fn create_thread(state: &AppState, body: &Value) -> Result<Value, ApiError> {
    v::allowed(
        body,
        &[
            "projectId",
            "issueId",
            "title",
            "model",
            "reasoningEffort",
            "sandbox",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
        ],
    )?;
    create_internal_thread(state, body).await
}

pub async fn create_internal_thread(state: &AppState, body: &Value) -> Result<Value, ApiError> {
    let project = v::required_string(body.get("projectId"), "projectId", 64)?;
    let context = context(state, &project, body["issueId"].as_str(), Some(body)).await?;
    let catalog = catalog(state, &context).await?;
    let models = catalog["models"].as_array().ok_or_else(|| {
        ApiError::new(
            502,
            "INVALID_MODEL_CATALOG",
            "Codex model catalog is unavailable",
        )
    })?;
    let requested = body["model"].as_str();
    let model = models
        .iter()
        .find(|model| requested.is_none() || model["slug"].as_str() == requested)
        .ok_or_else(|| ApiError::new(400, "INVALID_MODEL", "Requested model is unavailable"))?;
    let effort = body["reasoningEffort"]
        .as_str()
        .unwrap_or_else(|| model["defaultReasoningEffort"].as_str().unwrap_or(""));
    if !model["supportedReasoningEfforts"]
        .as_array()
        .is_some_and(|values| values.iter().any(|v| v == effort))
    {
        return Err(ApiError::new(
            400,
            "INVALID_REASONING_EFFORT",
            "Requested reasoning effort is unavailable",
        ));
    }
    let sandbox = body["sandbox"].as_str().unwrap_or("workspace-write");
    if !["read-only", "workspace-write", "danger-full-access"].contains(&sandbox) {
        return Err(ApiError::new(
            400,
            "INVALID_SANDBOX",
            "Unknown sandbox mode",
        ));
    }
    let mut origin = json!({"projectId":project,"projectName":context.project["name"],"workspacePath":context.workspace});
    if !context.issue.is_null() {
        origin["issueId"] = context.issue["id"].clone();
        origin["issueIdentifier"] = context.issue["identifier"].clone();
    }
    if let Some(target) = context.target {
        for key in ["codexProjectId", "codexProjectKind", "codexHostId"] {
            origin[key] = target[key].clone();
        }
    }
    let title = body["title"]
        .as_str()
        .or_else(|| context.issue["identifier"].as_str())
        .unwrap_or("New conversation");
    state.db("createAiChatThread",&[json!({"id":body["id"],"title":title,"purpose":body["purpose"],"origin":origin,"model":model["slug"],"reasoningEffort":effort,"sandbox":sandbox,"codexThreadId":body["codexThreadId"]})])
}

pub async fn update_thread(state: &AppState, id: &str, body: &Value) -> Result<Value, ApiError> {
    v::allowed(
        body,
        &["title", "issueId", "model", "reasoningEffort", "sandbox"],
    )?;
    if v::object(body)?.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_BODY",
            "PATCH requires at least one thread setting",
        ));
    }
    let current = thread(state, id)?;
    if current["status"] == "running"
        && ["model", "reasoningEffort", "sandbox", "issueId"]
            .iter()
            .any(|key| body.get(key).is_some())
    {
        return Err(ApiError::new(
            409,
            "THREAD_BUSY",
            format!("AI chat thread '{id}' has a running turn"),
        ));
    }
    let mut changes = body.clone();
    if let Some(title) = body.get("title") {
        changes["title"] = json!(v::required_string(Some(title), "title", 160)?);
    }
    if let Some(sandbox) = body.get("sandbox") {
        if !["read-only", "workspace-write", "danger-full-access"]
            .contains(&sandbox.as_str().unwrap_or(""))
        {
            return Err(ApiError::new(
                400,
                "INVALID_SANDBOX",
                "Unknown sandbox mode",
            ));
        }
    }
    if body.get("model").is_some() || body.get("reasoningEffort").is_some() {
        let project = current
            .pointer("/origin/projectId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let context = context(
            state,
            project,
            current.pointer("/origin/issueId").and_then(Value::as_str),
            current
                .get("origin")
                .filter(|origin| origin["codexProjectKind"] == "remote"),
        )
        .await?;
        let catalog = catalog(state, &context).await?;
        let model_id = body["model"]
            .as_str()
            .or_else(|| current["model"].as_str())
            .unwrap_or("");
        let model = catalog["models"]
            .as_array()
            .and_then(|values| values.iter().find(|model| model["slug"] == model_id))
            .ok_or_else(|| ApiError::new(400, "INVALID_MODEL", "Requested model is unavailable"))?;
        let effort = body["reasoningEffort"]
            .as_str()
            .or_else(|| current["reasoningEffort"].as_str())
            .unwrap_or("");
        if !model["supportedReasoningEfforts"]
            .as_array()
            .is_some_and(|values| values.iter().any(|v| v == effort))
        {
            return Err(ApiError::new(
                400,
                "INVALID_REASONING_EFFORT",
                "Requested reasoning effort is unavailable",
            ));
        }
    }
    if let Some(issue) = body.get("issueId") {
        let value = if issue.is_null() {
            Value::Null
        } else {
            state.db("getTask", &[issue.clone()])?
        };
        if !issue.is_null()
            && (value.is_null()
                || value["projectId"] != current["origin"]["projectId"]
                || !value["archivedAt"].is_null())
        {
            return Err(ApiError::new(
                404,
                "AI_CHAT_ISSUE_NOT_FOUND",
                "Task is not active in this project",
            ));
        }
        changes.as_object_mut().unwrap().remove("issueId");
        changes["originIssueId"] = value["id"].clone();
        changes["originIssueIdentifier"] = value["identifier"].clone();
    }
    state.db("updateAiChatThread", &[json!(id), changes])
}

fn emit(state: &AppState, thread_id: &str, kind: &str, value: Value) {
    let mut value = value;
    value["type"] = json!(kind);
    value["threadId"] = json!(thread_id);
    let _ = state.ai_events.send(value);
}

pub async fn start_turn(state: &Arc<AppState>, id: &str, input: &Value) -> Result<Value, ApiError> {
    if input.get("contractVersion").is_some() {
        return start_composer_turn(state, id, input).await;
    }
    v::allowed(
        input,
        &[
            "message",
            "skillIds",
            "dangerFullAccessConfirmed",
            "attachments",
        ],
    )?;
    let original_message = input["message"].as_str().unwrap_or("");
    let mut message = original_message.to_owned();
    if message.encode_utf16().count() > 100_000 {
        return Err(ApiError::new(
            400,
            "INVALID_MESSAGE",
            "Message cannot exceed 100000 characters",
        ));
    }
    let attachments = match input.get("attachments") {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .cloned()
            .filter(|v| v.len() <= 10)
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "INVALID_ATTACHMENT",
                    "'attachments' must contain at most 10 files",
                )
            })?,
    };
    if message.trim().is_empty() && attachments.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_MESSAGE",
            "A message or at least one attachment is required",
        ));
    }
    if input
        .get("dangerFullAccessConfirmed")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(v::invalid("'dangerFullAccessConfirmed' must be a boolean"));
    }
    let initial = thread(state, id)?;
    let handoff = parse_handoff(state, &initial, &message)?;
    if !initial["archivedAt"].is_null() {
        return Err(ApiError::new(
            409,
            "AI_CHAT_THREAD_ARCHIVED",
            "Cannot continue an archived conversation",
        ));
    }
    if initial["status"] == "running" {
        return Err(ApiError::new(
            409,
            "THREAD_BUSY",
            format!("AI chat thread '{id}' has a running turn"),
        ));
    }
    if initial["sandbox"] == "danger-full-access" && input["dangerFullAccessConfirmed"] != true {
        return Err(ApiError::new(
            400,
            "DANGER_CONFIRMATION_REQUIRED",
            "danger-full-access must be confirmed for every turn",
        ));
    }
    let project = initial["origin"]["projectId"].as_str().unwrap_or("");
    let resolved = context(
        state,
        project,
        initial["origin"]["issueId"].as_str(),
        initial
            .get("origin")
            .filter(|origin| origin["codexProjectKind"] == "remote"),
    )
    .await?;
    if resolved.workspace != initial["origin"]["workspacePath"].as_str().unwrap_or("") {
        return Err(ApiError::new(
            409,
            "PROJECT_WORKSPACE_CHANGED",
            "The project's device workspace no longer matches this conversation",
        ));
    }
    let catalog = catalog(state, &resolved).await?;
    let model = catalog["models"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .find(|model| model["slug"] == initial["model"])
        })
        .ok_or_else(|| ApiError::new(400, "INVALID_MODEL", "Requested model is unavailable"))?;
    if !model["supportedReasoningEfforts"]
        .as_array()
        .is_some_and(|efforts| efforts.contains(&initial["reasoningEffort"]))
    {
        return Err(ApiError::new(
            400,
            "INVALID_REASONING_EFFORT",
            "Requested reasoning effort is unavailable",
        ));
    }
    let mut skill_ids = match input.get("skillIds") {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .cloned()
            .filter(|v| v.len() <= 20)
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "INVALID_SKILL",
                    "'skillIds' must contain at most 20 Skill IDs",
                )
            })?,
    };
    if message.matches('\u{fffc}').count() != skill_ids.len() {
        return Err(v::invalid(
            "'skillIds' must match the Skill markers in 'message'",
        ));
    }
    if let Some((issue, note)) = &handoff {
        let workflow = super::routes::workflow(state, project, "handoff").await?;
        skill_ids = workflow["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| s["id"].clone())
            .collect();
        message=format!("{}\n\nCreate a durable handoff summary for issue {} from this conversation.\n{}\nPanel 固定规则：\n{}\n当前使用内嵌交接入口，只返回摘要，由 Panel 发布。不要使用工具或修改文件。{}",vec!["\u{fffc}";skill_ids.len()].join("\n\n"),issue["identifier"].as_str().unwrap_or(""),workflow["prompt"].as_str().unwrap_or(""),workflow["rules"].as_str().unwrap_or(""),if note.is_empty(){String::new()}else{format!("\nThe user asked you to emphasize: {note}")});
    }
    let mut skills = Vec::new();
    for id in &skill_ids {
        let skill = catalog["skills"]
            .as_array()
            .and_then(|skills| {
                skills
                    .iter()
                    .find(|skill| skill["id"] == *id && skill["id"] != "manage-panel")
            })
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "INVALID_SKILL",
                    format!("Unknown or unavailable skill {id}"),
                )
            })?;
        skills.push(skill.clone());
    }
    if resolved.target.is_some() {
        let mut user_input = Vec::new();
        for (index, text) in message.split('\u{fffc}').enumerate() {
            if !text.is_empty() {
                user_input.push(json!({"type":"text","text":text}));
            }
            if let Some(skill) = skills.get(index) {
                user_input.push(json!({"type":"skill","name":skill["id"],"path":skill["path"]}));
            }
        }
        for attachment in &attachments {
            user_input.push(remote_attachment(attachment)?);
        }
        return start_app_turn(state,id,initial,resolved,user_input,json!({"content":original_message,"data":{"skillIds":skill_ids,"handoff":handoff.is_some(),"attachments":attachments.iter().map(|a|json!({"filename":a["filename"],"contentType":a["contentType"],"size":a["dataBase64"].as_str().and_then(|s|base64::engine::general_purpose::STANDARD.decode(s).ok()).map(|b|b.len())})).collect::<Vec<_>>()}}),None,handoff.map(|(issue,_)|issue)).await;
    }
    let mut temporary = PendingAttachments(if attachments.is_empty() {
        None
    } else {
        let path = std::env::temp_dir().join(format!("codex-panel-turn-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&path).await?;
        Some(path)
    });
    let mut paths = Vec::new();
    let mut image_paths = Vec::new();
    let mut attachment_metadata = Vec::new();
    let prepared = async {
        for (index, attachment) in attachments.iter().enumerate() {
            v::allowed(attachment, &["filename", "contentType", "dataBase64"])?;
            let filename = v::required_string(attachment.get("filename"), "filename", 240)?;
            if filename
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            {
                return Err(ApiError::new(
                    400,
                    "INVALID_ATTACHMENT",
                    "Attachment filename is invalid",
                ));
            }
            let content_type =
                v::required_string(attachment.get("contentType"), "contentType", 256)?
                    .to_ascii_lowercase();
            let encoded =
                v::required_string(attachment.get("dataBase64"), "dataBase64", 25 * 1024 * 1024)?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(&encoded)
                .map_err(|_| {
                    ApiError::new(
                        400,
                        "INVALID_ATTACHMENT",
                        "Attachment data must be canonical base64",
                    )
                })?;
            if data.is_empty() || base64::engine::general_purpose::STANDARD.encode(&data) != encoded
            {
                return Err(ApiError::new(
                    400,
                    "INVALID_ATTACHMENT",
                    "Attachment data must be canonical base64",
                ));
            }
            let path = temporary
                .as_ref()
                .unwrap()
                .join(format!("{index}-{filename}"));
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options.mode(0o600);
            }
            let mut file = options.open(&path).await?;
            file.write_all(&data).await?;
            file.sync_all().await?;
            let path = path.to_string_lossy().into_owned();
            paths.push(path.clone());
            if ["image/gif", "image/jpeg", "image/png", "image/webp"]
                .contains(&content_type.as_str())
            {
                image_paths.push(path);
            }
            attachment_metadata
                .push(json!({"filename":filename,"contentType":content_type,"size":data.len()}));
        }
        let args = super::ai_process::arguments(&initial, &resolved.add_directories, &image_paths)?;
        let prompt = super::ai_process::prompt(
            &initial,
            &message,
            &skills,
            &paths,
            &state
                .config
                .project_root
                .join("skills/manage-panel/SKILL.md")
                .to_string_lossy(),
        )?;
        Ok::<_, ApiError>((args, prompt))
    }
    .await;
    let (args, prompt) = prepared?;
    let _starting = state.ai_start.lock().await;
    let current = thread(state, id)?;
    if current["status"] == "running" || !current["archivedAt"].is_null() {
        return Err(ApiError::new(
            409,
            "THREAD_BUSY",
            format!("AI chat thread '{id}' has a running turn"),
        ));
    }
    if let Some(issue) = initial["origin"]["issueId"].as_str() {
        state.db("assertIssueExecutionAllowed", &[json!(issue)])?;
    }
    let run = state.db("createAiChatRun", &[json!({"threadId":id})])?;
    emit(state, id, "ai.run", json!({"run":run}));
    let mut metadata = json!({});
    if !skill_ids.is_empty() {
        metadata["skillIds"] = json!(skill_ids);
    }
    if !attachment_metadata.is_empty() {
        metadata["attachments"] = json!(attachment_metadata);
    }
    if handoff.is_some() {
        metadata["handoff"] = json!(true);
    }
    let event=state.db("insertAiChatEvent",&[json!({"threadId":id,"runId":run["id"],"type":"user_message","role":"user","content":original_message,"data":metadata})])?;
    emit(state, id, "ai.event", json!({"event":event}));
    let spawned = async {
        let mut owner = super::turn_owner::spawn(&codex::executable()?, &args).await?;
        let mut stdin = owner.child.stdin.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stdin is unavailable")
        })?;
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
        Ok::<_, ApiError>(owner)
    }
    .await;
    let owner = match spawned {
        Ok(owner) => owner,
        Err(error) => {
            let failed=state.db("updateAiChatRun",&[run["id"].clone(),json!({"status":"failed","error":error.message,"finishedAt":chrono::Utc::now().to_rfc3339()})])?;
            emit(state, id, "ai.run", json!({"run":failed}));
            return Err(error);
        }
    };
    let pid = owner
        .child
        .id()
        .ok_or_else(|| ApiError::new(502, "CODEX_START_FAILED", "Codex owner has no process ID"))?;
    let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let run_id = run["id"]
        .as_str()
        .ok_or_else(|| ApiError::new(500, "INVALID_RUN", "Run has no identifier"))?
        .to_owned();
    state
        .ai_active
        .lock()
        .map_err(|_| ApiError::new(500, "RUN_LOCK", "Run lock was poisoned"))?
        .insert(
            run_id.clone(),
            ActiveTurn {
                pid,
                interrupted: interrupted.clone(),
                target: None,
                connection: None,
                codex_thread: String::new(),
                turn_id: Arc::new(std::sync::Mutex::new(None)),
            },
        );
    let temporary = temporary.take();
    let state = state.clone();
    let thread_id = id.to_owned();
    tokio::spawn(async move {
        monitor_turn(
            state,
            thread_id,
            run_id,
            initial,
            owner,
            interrupted,
            temporary,
            handoff.map(|(issue, _)| issue),
        )
        .await;
    });
    Ok(run)
}

async fn monitor_turn(
    state: Arc<AppState>,
    thread_id: String,
    run_id: String,
    initial: Value,
    mut owner: super::turn_owner::ManagedTurn,
    interrupted: Arc<std::sync::atomic::AtomicBool>,
    temporary: Option<PathBuf>,
    handoff: Option<Value>,
) {
    let Some(mut stdout) = owner.child.stdout.take() else {
        return;
    };
    let mut stderr = owner.child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut text = Vec::new();
        let mut chunk = [0u8; 4096];
        if let Some(ref mut stderr) = stderr {
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let take = n.min(65536usize.saturating_sub(text.len()));
                        text.extend_from_slice(&chunk[..take]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&text).into_owned()
    });
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut fatal = None;
    let mut outcome = None;
    let mut started = None;
    let mut terminal_error = String::new();
    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) => {
                if !buffer.is_empty() {
                    if let Err(error) = consume_event(
                        &state,
                        &thread_id,
                        &run_id,
                        &initial,
                        &buffer,
                        &mut started,
                        &mut outcome,
                        &mut terminal_error,
                    ) {
                        fatal = Some(error);
                    }
                }
                break;
            }
            Ok(n) => {
                for byte in &chunk[..n] {
                    if *byte == b'\n' {
                        if let Err(error) = consume_event(
                            &state,
                            &thread_id,
                            &run_id,
                            &initial,
                            &buffer,
                            &mut started,
                            &mut outcome,
                            &mut terminal_error,
                        ) {
                            fatal = Some(error);
                            break;
                        }
                        buffer.clear();
                    } else {
                        buffer.push(*byte);
                        if buffer.len() > 16 * 1024 * 1024 {
                            fatal = Some(ApiError::new(
                                502,
                                "CODEX_OUTPUT_LIMIT",
                                "Codex JSONL line exceeded 16777216 bytes",
                            ));
                            break;
                        }
                    }
                }
                if fatal.is_some() {
                    break;
                }
            }
            Err(error) => {
                fatal = Some(error.into());
                break;
            }
        }
    }
    if fatal.is_some() {
        kill_group(owner.child.id(), true).await;
    }
    let status = owner.child.wait().await;
    let stderr = match tokio::time::timeout(std::time::Duration::from_secs(2), stderr_task).await {
        Ok(Ok(stderr)) => stderr,
        _ => String::new(),
    };
    let mut status_name = if interrupted.load(std::sync::atomic::Ordering::SeqCst) {
        "interrupted"
    } else if fatal.is_some()
        || outcome.as_deref() == Some("failed")
        || status.as_ref().map_or(true, |s| !s.success())
        || (initial["codexThreadId"].is_null() && started.is_none())
        || outcome.as_deref() != Some("completed")
    {
        "failed"
    } else {
        "completed"
    };
    let mut error = if status_name == "interrupted" {
        "Interrupted".into()
    } else if let Some(error) = fatal {
        error.message
    } else if !terminal_error.is_empty() {
        terminal_error
    } else if status_name == "failed" {
        if stderr.is_empty() {
            "Codex did not complete the turn".into()
        } else {
            stderr
        }
    } else {
        String::new()
    };
    if status_name == "completed" {
        if let Some(issue) = handoff {
            if let Err(cause) = record_handoff(&state, &thread_id, &run_id, &issue) {
                status_name = "failed";
                error = cause.message;
            }
        }
    }
    if let Ok(run)=state.db("updateAiChatRun",&[json!(run_id),json!({"status":status_name,"error":if error.is_empty(){Value::Null}else{json!(error)},"finishedAt":chrono::Utc::now().to_rfc3339()})]){emit(&state,&thread_id,"ai.run",json!({"run":run}));}
    if let Ok(mut active) = state.ai_active.lock() {
        active.remove(&run_id);
    }
    if let Some(path) = temporary {
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

fn consume_event(
    state: &AppState,
    thread_id: &str,
    run_id: &str,
    initial: &Value,
    line: &[u8],
    started: &mut Option<String>,
    outcome: &mut Option<String>,
    terminal_error: &mut String,
) -> Result<(), ApiError> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let raw: Value = serde_json::from_slice(line)
        .map_err(|_| ApiError::new(502, "INVALID_CODEX_OUTPUT", "Codex emitted malformed JSONL"))?;
    let Some(event) = super::ai_process::normalize(&raw) else {
        return Ok(());
    };
    if event["kind"] == "thread.started" {
        let id = event["threadId"].as_str().unwrap_or("");
        if initial["codexThreadId"]
            .as_str()
            .is_some_and(|expected| expected != id)
            || started.as_deref().is_some_and(|expected| expected != id)
        {
            return Err(ApiError::new(
                502,
                "CODEX_THREAD_MISMATCH",
                "Codex returned an unexpected thread ID",
            ));
        }
        *started = Some(id.into());
        state.db(
            "updateAiChatThread",
            &[json!(thread_id), json!({"codexThreadId":id})],
        )?;
        return Ok(());
    }
    if raw["type"] == "turn.completed" && outcome.is_none() {
        *outcome = Some("completed".into());
    }
    if raw["type"] == "turn.failed" {
        *outcome = Some("failed".into());
        *terminal_error = event["content"].as_str().unwrap_or("").into();
    }
    let stored=state.db("insertAiChatEvent",&[json!({"threadId":thread_id,"runId":run_id,"type":event["type"],"role":event["role"],"content":event["content"],"data":event["data"]})])?;
    emit(state, thread_id, "ai.event", json!({"event":stored}));
    Ok(())
}

async fn kill_group(pid: Option<u32>, force: bool) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(
                -(pid as i32),
                if force { libc::SIGKILL } else { libc::SIGTERM },
            );
        }
    }
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new("taskkill.exe");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let _ = command.creation_flags(0x08000000).output().await;
    }
}

pub async fn run_readonly(workspace: &Path, prompt: &str) -> Result<String, ApiError> {
    let args = [
        "exec",
        "--ephemeral",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-C",
        workspace
            .to_str()
            .ok_or_else(|| v::invalid("Workspace path is not UTF-8"))?,
        "-s",
        "read-only",
        "-c",
        "approval_policy=\"never\"",
        "-",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let mut owner = super::turn_owner::spawn(&codex::executable()?, &args).await?;
    let result = async {
        let mut stdin = owner.child.stdin.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stdin is unavailable")
        })?;
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
        // 管道 shutdown 只冲刷数据；显式关闭句柄，让 Codex 读到提示词结束的 EOF。
        drop(stdin);
        let mut stdout = owner.child.stdout.take().ok_or_else(|| {
            ApiError::new(502, "CODEX_START_FAILED", "Codex stdout is unavailable")
        })?;
        let stderr = owner.child.stderr.take();
        let diagnostic = tokio::spawn(async move {
            if let Some(mut stderr) = stderr {
                let mut buffer = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                }
            }
        });
        let mut chunk = [0u8; 16384];
        let mut line = Vec::new();
        let mut answer = String::new();
        let mut error = String::new();
        loop {
            let n = stdout.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            for byte in &chunk[..n] {
                if *byte == b'\n' {
                    consume_readonly_line(&line, &mut answer, &mut error)?;
                    line.clear();
                } else {
                    line.push(*byte);
                    if line.len() > 16 * 1024 * 1024 {
                        return Err(ApiError::new(
                            502,
                            "CODEX_OUTPUT_LIMIT",
                            "Codex JSONL line exceeded its limit",
                        ));
                    }
                }
            }
        }
        // JSONL 的最后一条记录允许没有换行，仍须参与结果和错误判定。
        consume_readonly_line(&line, &mut answer, &mut error)?;
        let status = owner.child.wait().await?;
        let _ = diagnostic.await;
        if !status.success() || !error.is_empty() {
            return Err(ApiError::new(
                502,
                "CODEX_GENERATION_FAILED",
                if error.is_empty() {
                    format!("Codex exited with {status}")
                } else {
                    error
                },
            ));
        }
        if answer.is_empty() {
            return Err(ApiError::new(
                502,
                "CODEX_GENERATION_FAILED",
                "Codex returned no result",
            ));
        }
        Ok(answer)
    }
    .await;
    if result.is_err() {
        kill_group(owner.child.id(), true).await;
    }
    result
}

fn consume_readonly_line(
    line: &[u8],
    answer: &mut String,
    error: &mut String,
) -> Result<(), ApiError> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let event: Value = serde_json::from_slice(line)
        .map_err(|_| ApiError::new(502, "INVALID_CODEX_OUTPUT", "Codex emitted malformed JSONL"))?;
    if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" {
        *answer = event["item"]["text"].as_str().unwrap_or("").into();
    }
    if event["type"] == "turn.failed" || event["type"] == "error" {
        *error = event["error"]["message"]
            .as_str()
            .or_else(|| event["message"].as_str())
            .unwrap_or("Codex 生成失败")
            .into();
    }
    Ok(())
}

pub async fn interrupt(state: &Arc<AppState>, run_id: &str) -> Result<Value, ApiError> {
    let run = state.db("getAiChatRun", &[json!(run_id)])?;
    if run.is_null() {
        return Err(ApiError::new(
            404,
            "AI_CHAT_RUN_NOT_FOUND",
            format!("AI chat run '{run_id}' does not exist"),
        ));
    }
    if run["status"] != "running" {
        return Ok(run);
    }
    let active = state
        .ai_active
        .lock()
        .map_err(|_| ApiError::new(500, "RUN_LOCK", "Run lock was poisoned"))?
        .get(run_id)
        .map(|run| {
            (
                run.pid,
                run.interrupted.clone(),
                run.target.clone(),
                run.connection.clone(),
                run.codex_thread.clone(),
                run.turn_id.clone(),
            )
        });
    if let Some((pid, flag, target, connection, codex_thread, turn_id)) = active {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        if pid > 0 {
            kill_group(Some(pid), false).await;
        } else {
            let turn = turn_id.lock().ok().and_then(|v| v.clone());
            if let Some(turn) = turn {
                let params = json!({"threadId":codex_thread,"turnId":turn});
                if let Some(target) = target {
                    let runtime = std::env::var_os("CODEX_PANEL_RUNTIME_FILE")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| state.config.data_dir.join("launcher-runtime.json"));
                    let _=crate::injector::control_request(&runtime,"app-server",json!({"hostId":target["codexHostId"],"method":"turn/interrupt","params":params})).await;
                } else if let Some(connection) = connection {
                    let _ = connection.request("turn/interrupt", params).await;
                }
            }
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            if !state
                .ai_active
                .lock()
                .map_err(|_| ApiError::new(500, "RUN_LOCK", "Run lock was poisoned"))?
                .contains_key(run_id)
            {
                return state.db("getAiChatRun", &[json!(run_id)]);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if pid > 0
            && state
                .ai_active
                .lock()
                .map_err(|_| ApiError::new(500, "RUN_LOCK", "Run lock was poisoned"))?
                .get(run_id)
                .is_some_and(|active| Arc::ptr_eq(&active.interrupted, &flag))
        {
            kill_group(Some(pid), true).await;
        }
    }
    let finished=state.db("updateAiChatRun",&[json!(run_id),json!({"status":"interrupted","error":"Interrupted","finishedAt":chrono::Utc::now().to_rfc3339()})])?;
    emit(
        state,
        run["threadId"].as_str().unwrap_or(""),
        "ai.run",
        json!({"run":finished}),
    );
    Ok(finished)
}

fn remote_attachment(attachment: &Value) -> Result<Value, ApiError> {
    v::allowed(attachment, &["filename", "contentType", "dataBase64"])?;
    let filename = v::required_string(attachment.get("filename"), "filename", 240)?;
    if filename
        .chars()
        .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(ApiError::new(
            400,
            "INVALID_ATTACHMENT",
            "Attachment filename is invalid",
        ));
    }
    let kind =
        v::required_string(attachment.get("contentType"), "contentType", 256)?.to_ascii_lowercase();
    let encoded = v::required_string(attachment.get("dataBase64"), "dataBase64", 25 * 1024 * 1024)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&encoded)
        .map_err(|_| {
            ApiError::new(
                400,
                "INVALID_ATTACHMENT",
                "Attachment must contain canonical base64",
            )
        })?;
    if bytes.is_empty() || base64::engine::general_purpose::STANDARD.encode(&bytes) != encoded {
        return Err(ApiError::new(
            400,
            "INVALID_ATTACHMENT",
            "Attachment must contain canonical base64",
        ));
    }
    let url = format!("data:{kind};base64,{encoded}");
    Ok(
        if ["image/gif", "image/jpeg", "image/png", "image/webp"].contains(&kind.as_str()) {
            json!({"type":"image","url":url})
        } else if kind.starts_with("audio/") {
            json!({"type":"audio","url":url})
        } else {
            json!({"type":"text","text":format!("\n\nAttached file {filename}: {url}")})
        },
    )
}

async fn start_composer_turn(
    state: &Arc<AppState>,
    id: &str,
    input: &Value,
) -> Result<Value, ApiError> {
    v::allowed(
        input,
        &[
            "contractVersion",
            "revision",
            "document",
            "dangerFullAccessConfirmed",
            "attachments",
        ],
    )?;
    if input["contractVersion"] != "composer.v1" || input["document"]["version"] != 1 {
        return Err(ApiError::new(
            400,
            "INVALID_COMPOSER_DOCUMENT",
            "Unknown composer contract",
        ));
    }
    v::allowed(&input["document"], &["version", "nodes"])?;
    let nodes = input["document"]["nodes"]
        .as_array()
        .filter(|nodes| nodes.len() <= 200)
        .ok_or_else(|| {
            ApiError::new(
                400,
                "INVALID_COMPOSER_DOCUMENT",
                "Composer must contain at most 200 nodes",
            )
        })?;
    let revision = v::required_string(input.get("revision"), "revision", 512)?;
    let thread = thread(state, id)?;
    if thread["status"] == "running" {
        return Err(ApiError::new(
            409,
            "THREAD_BUSY",
            format!("AI chat thread '{id}' has a running turn"),
        ));
    }
    if thread["sandbox"] == "danger-full-access" && input["dangerFullAccessConfirmed"] != true {
        return Err(ApiError::new(
            400,
            "DANGER_CONFIRMATION_REQUIRED",
            "danger-full-access must be confirmed for every turn",
        ));
    }
    let context = context(
        state,
        thread["origin"]["projectId"].as_str().unwrap_or(""),
        thread["origin"]["issueId"].as_str(),
        thread
            .get("origin")
            .filter(|origin| origin["codexProjectKind"] == "remote"),
    )
    .await?;
    if context.workspace != thread["origin"]["workspacePath"].as_str().unwrap_or("") {
        return Err(ApiError::new(
            409,
            "PROJECT_WORKSPACE_CHANGED",
            "The project's device workspace no longer matches this conversation",
        ));
    }
    let references = if nodes
        .iter()
        .any(|node| node["type"] == "skill" || node["type"] == "agent")
    {
        super::composer::resolve(state, &context, &revision, nodes).await?
    } else {
        vec![None; nodes.len()]
    };
    let mut user_input = Vec::new();
    let mut content = String::new();
    let mut dispatches = Vec::new();
    let mut text_length = 0;
    for (index, node) in nodes.iter().enumerate() {
        match node["type"].as_str().unwrap_or("") {
            "text" => {
                v::allowed(node, &["type", "text"])?;
                let text = node["text"].as_str().ok_or_else(|| {
                    ApiError::new(
                        400,
                        "INVALID_COMPOSER_DOCUMENT",
                        "Composer text must be a string",
                    )
                })?;
                text_length += text.encode_utf16().count();
                content.push_str(text);
                user_input.push(json!({"type":"text","text":text}));
            }
            "skill" | "agent" => {
                v::allowed(node, &["type", "candidateRef", "label"])?;
                let reference = references[index].as_ref().ok_or_else(|| {
                    ApiError::new(
                        409,
                        "COMPOSER_REFERENCE_UNAVAILABLE",
                        "Composer reference is unavailable",
                    )
                })?;
                let label = v::required_string(node.get("label"), "label", 256)?;
                content.push('@');
                content.push_str(&label);
                if node["type"] == "skill" {
                    let name = reference["name"].as_str().unwrap_or("");
                    user_input.push(json!({"type":"text","text":format!("${name}")}));
                    user_input.push(json!({"type":"skill","name":name,"path":reference["path"]}));
                } else {
                    user_input.push(json!({"type":"text","text":format!("Panel private agent dispatch (panel.agent.v1):\nUse the configured Panel agent {} (id {}) for this request.\nThis is Panel product-private routing context, not a Codex App Server UserInput type.",reference["name"],reference["id"])}));
                    dispatches.push(
                        json!({"nodeIndex":index,"id":reference["id"],"name":reference["name"]}),
                    );
                }
            }
            _ => {
                return Err(ApiError::new(
                    422,
                    "COMPOSER_NODE_UNSUPPORTED",
                    format!("Unsupported composer node at index {index}"),
                )
                .with_details(json!({"nodeIndex":index})))
            }
        }
    }
    if text_length > 100_000 {
        return Err(ApiError::new(
            400,
            "INVALID_COMPOSER_DOCUMENT",
            "Composer text cannot exceed 100000 characters",
        ));
    }
    let attachments = input
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if attachments.len() > 10 {
        return Err(ApiError::new(
            400,
            "INVALID_ATTACHMENT",
            "At most 10 attachments are supported",
        ));
    }
    if content.trim().is_empty() && attachments.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_COMPOSER_DOCUMENT",
            "A composer message or at least one attachment is required",
        ));
    }
    let temporary = if attachments.is_empty() || context.target.is_some() {
        None
    } else {
        let path = std::env::temp_dir().join(format!("codex-panel-turn-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&path).await?;
        Some(path)
    };
    let preparation=async{
        let mut metadata=Vec::new();
        for(index,attachment)in attachments.iter().enumerate(){
            let remote=remote_attachment(attachment)?;
            let kind=attachment["contentType"].as_str().unwrap().to_ascii_lowercase();let bytes=base64::engine::general_purpose::STANDARD.decode(attachment["dataBase64"].as_str().unwrap()).unwrap();
            metadata.push(json!({"filename":attachment["filename"],"contentType":kind,"size":bytes.len()}));
            if let Some(directory)=&temporary{
                let path=directory.join(format!("attachment-{}-{}",index+1,attachment["filename"].as_str().unwrap()));
                let mut options=tokio::fs::OpenOptions::new();options.write(true).create_new(true);#[cfg(unix)]{options.mode(0o600);}
                let mut file=options.open(&path).await?;file.write_all(&bytes).await?;
                user_input.push(if ["image/gif","image/jpeg","image/png","image/webp"].contains(&kind.as_str()){json!({"type":"localImage","path":path})}else{json!({"type":"text","text":format!("\n\nAttached file: {}",path.display())})});
            }else{user_input.push(remote);}
        }
        let mut data=json!({"contractVersion":"composer.v1","revision":revision,"document":input["document"]});
        if !dispatches.is_empty(){data["dispatchProtocol"]=json!("panel.agent.v1");data["agentDispatches"]=json!(dispatches);}
        if !metadata.is_empty(){data["attachments"]=json!(metadata);}
        Ok::<_,ApiError>(json!({"content":content,"data":data}))
    }.await;
    let event = match preparation {
        Ok(event) => event,
        Err(error) => {
            if let Some(directory) = temporary {
                let _ = tokio::fs::remove_dir_all(directory).await;
            }
            return Err(error);
        }
    };
    start_app_turn(
        state, id, thread, context, user_input, event, temporary, None,
    )
    .await
}

async fn start_app_turn(
    state: &Arc<AppState>,
    id: &str,
    thread: Value,
    context: Context,
    user_input: Vec<Value>,
    user_event: Value,
    temporary: Option<PathBuf>,
    handoff: Option<Value>,
) -> Result<Value, ApiError> {
    let mut temporary = PendingAttachments(temporary);
    let _gate = state.ai_start.lock().await;
    let current = self::thread(state, id)?;
    if current["status"] == "running" || !current["archivedAt"].is_null() {
        return Err(ApiError::new(
            409,
            "THREAD_BUSY",
            format!("AI chat thread '{id}' cannot start a turn"),
        ));
    }
    if let Some(issue) = thread["origin"]["issueId"].as_str() {
        state.db("assertIssueExecutionAllowed", &[json!(issue)])?;
    }
    let connection = app_connection(state, &context).await?;
    let mut notifications = if let Some(connection) = &connection {
        connection.notifications.subscribe()
    } else {
        crate::injector::subscribe_notifications()
    };
    let full = thread["sandbox"] == "danger-full-access";
    let mut roots = vec![context.workspace.clone()];
    roots.extend(context.add_directories.clone());
    let mut settings = json!({"model":thread["model"],"cwd":context.workspace,"runtimeWorkspaceRoots":roots,"approvalPolicy":if full{"never"}else{"on-request"},"sandbox":if full{"danger-full-access"}else{"workspace-write"}});
    if !full {
        settings["approvalsReviewer"] = json!(if thread["sandbox"] == "read-only" {
            "user"
        } else {
            "auto_review"
        });
    }
    let codex_thread = if let Some(existing) = thread["codexThreadId"].as_str() {
        settings["threadId"] = json!(existing);
        let resumed = request(
            state,
            &context,
            connection.as_ref(),
            "thread/resume",
            settings,
        )
        .await?;
        if resumed["thread"]["id"] != existing {
            return Err(ApiError::new(
                502,
                "CODEX_THREAD_MISMATCH",
                "Codex returned an unexpected resumed thread ID",
            ));
        }
        existing.to_owned()
    } else {
        let result = request(
            state,
            &context,
            connection.as_ref(),
            "thread/start",
            settings,
        )
        .await?;
        let codex_id = result["thread"]["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApiError::new(
                    502,
                    "CODEX_THREAD_MISMATCH",
                    "Codex did not provide a thread ID",
                )
            })?
            .to_owned();
        state.db(
            "updateAiChatThread",
            &[json!(id), json!({"codexThreadId":codex_id})],
        )?;
        codex_id
    };
    let run = state.db("createAiChatRun", &[json!({"threadId":id})])?;
    emit(state, id, "ai.run", json!({"run":run}));
    let event=state.db("insertAiChatEvent",&[json!({"threadId":id,"runId":run["id"],"type":"user_message","role":"user","content":user_event["content"],"data":user_event["data"]})])?;
    emit(state, id, "ai.event", json!({"event":event}));
    let run_id = run["id"].as_str().unwrap_or("").to_owned();
    let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let turn_id = Arc::new(std::sync::Mutex::new(None));
    state
        .ai_active
        .lock()
        .map_err(|_| ApiError::new(500, "RUN_LOCK", "Run lock was poisoned"))?
        .insert(
            run_id.clone(),
            ActiveTurn {
                pid: 0,
                interrupted: interrupted.clone(),
                target: context.target.clone(),
                connection: connection.clone(),
                codex_thread: codex_thread.clone(),
                turn_id: turn_id.clone(),
            },
        );
    let result = request(
        state,
        &context,
        connection.as_ref(),
        "turn/start",
        json!({"threadId":codex_thread,"input":user_input,"effort":thread["reasoningEffort"]}),
    )
    .await;
    let result = result.and_then(|value| {
        value["turn"]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                ApiError::new(
                    502,
                    "CODEX_TURN_MISMATCH",
                    "Codex did not provide a turn ID",
                )
            })
    });
    let started = match result {
        Ok(value) => value,
        Err(error) => {
            state
                .ai_active
                .lock()
                .ok()
                .map(|mut map| map.remove(&run_id));
            let failed=state.db("updateAiChatRun",&[json!(run_id),json!({"status":"failed","error":error.message,"finishedAt":chrono::Utc::now().to_rfc3339()})])?;
            emit(state, id, "ai.run", json!({"run":failed}));
            return Err(error);
        }
    };
    *turn_id
        .lock()
        .map_err(|_| ApiError::new(500, "RUN_LOCK", "Turn lock was poisoned"))? = Some(started);
    let temporary = temporary.take();
    let state = state.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        let mut status = "failed";
        let mut error = "Codex app-server disconnected".to_owned();
        loop {
            let received = tokio::select! {
                notification=notifications.recv()=>notification,
                _=tokio::time::sleep(std::time::Duration::from_millis(100))=>{
                    if interrupted.load(std::sync::atomic::Ordering::SeqCst){status="interrupted";break;}
                    continue;
                }
            };
            let notification = match received {
                Ok(value) => value,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    error = "Codex app-server event buffer overflowed".into();
                    break;
                }
                Err(_) => break,
            };
            if context
                .target
                .as_ref()
                .is_some_and(|target| notification["hostId"] != target["codexHostId"])
            {
                continue;
            }
            if notification["method"] == "app-server/terminated" {
                if connection.is_some() {
                    break;
                } else {
                    continue;
                }
            }
            let params = &notification["params"];
            if params["threadId"] != codex_thread {
                continue;
            }
            let expected = turn_id.lock().ok().and_then(|v| v.clone());
            let notified_turn = params["turnId"]
                .as_str()
                .or_else(|| params["turn"]["id"].as_str());
            if notified_turn
                .zip(expected.as_deref())
                .is_some_and(|(a, b)| a != b)
            {
                continue;
            }
            if notification["method"] == "turn/started" {
                if let Ok(mut current) = turn_id.lock() {
                    *current = params["turn"]["id"].as_str().map(str::to_owned);
                }
            }
            if notification["method"] == "item/completed" {
                if let Some(event) = normalize_app_item(&params["item"]) {
                    if let Ok(event)=state.db("insertAiChatEvent",&[json!({"threadId":id,"runId":run_id,"type":event["type"],"role":event["role"],"content":event["content"],"data":event["data"]})]){emit(&state,&id,"ai.event",json!({"event":event}));}
                }
            }
            if notification["method"] == "turn/completed" {
                status = if interrupted.load(std::sync::atomic::Ordering::SeqCst)
                    || params["turn"]["status"] == "interrupted"
                {
                    "interrupted"
                } else if params["turn"]["status"] == "completed" {
                    "completed"
                } else {
                    "failed"
                };
                error = params["turn"]["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex reported a failed turn")
                    .to_owned();
                break;
            }
        }
        if interrupted.load(std::sync::atomic::Ordering::SeqCst) {
            status = "interrupted";
        }
        if status == "completed" {
            if let Some(issue) = handoff {
                if let Err(cause) = record_handoff(&state, &id, &run_id, &issue) {
                    status = "failed";
                    error = cause.message;
                }
            }
        }
        if let Ok(run)=state.db("updateAiChatRun",&[json!(run_id),json!({"status":status,"exitCode":null,"error":if status=="completed"{Value::Null}else if status=="interrupted"{json!("Interrupted")}else{json!(error)},"finishedAt":chrono::Utc::now().to_rfc3339()})]){emit(&state,&id,"ai.run",json!({"run":run}));}
        if let Ok(mut active) = state.ai_active.lock() {
            active.remove(&run_id);
        }
        if let Some(path) = temporary {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
    });
    Ok(run)
}

fn normalize_app_item(item: &Value) -> Option<Value> {
    let mut converted = item.clone();
    converted["type"] = json!(match item["type"].as_str()? {
        "agentMessage" => "agent_message",
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "mcpToolCall" => "mcp_tool_call",
        "webSearch" => "web_search",
        "todoList" => "todo_list",
        _ => return None,
    });
    if let Some(output) = item.get("aggregatedOutput") {
        converted["aggregated_output"] = output.clone();
    }
    if let Some(code) = item.get("exitCode") {
        converted["exit_code"] = code.clone();
    }
    super::ai_process::normalize(&json!({"type":"item.completed","item":converted}))
}

pub async fn compact(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let thread = thread(state, id)?;
    if thread["status"] == "running" {
        return Err(ApiError::new(
            409,
            "AI_CHAT_THREAD_RUNNING",
            "Cannot compact a running conversation",
        ));
    }
    let codex_id = thread["codexThreadId"].as_str().ok_or_else(|| {
        ApiError::new(
            409,
            "AI_CHAT_THREAD_NOT_STARTED",
            "Conversation has not started",
        )
    })?;
    let context = context(
        state,
        thread["origin"]["projectId"].as_str().unwrap_or(""),
        thread["origin"]["issueId"].as_str(),
        thread
            .get("origin")
            .filter(|origin| origin["codexProjectKind"] == "remote"),
    )
    .await?;
    let connection = app_connection(state, &context).await?;
    let result = request(
        state,
        &context,
        connection.as_ref(),
        "thread/compact/start",
        json!({"threadId":codex_id}),
    )
    .await;
    result?;
    Ok(thread)
}

async fn app_connection(
    state: &AppState,
    context: &Context,
) -> Result<Option<Arc<codex::Connection>>, ApiError> {
    if context.target.is_some() {
        return Ok(None);
    }
    let mut servers = state.app_servers.lock().await;
    if let Some(connection) = servers.get(&context.workspace) {
        if connection.is_running().await {
            return Ok(Some(connection.clone()));
        }
    }
    let connection =
        codex::Connection::start(&codex::executable()?, Path::new(&context.workspace)).await?;
    servers.insert(context.workspace.clone(), connection.clone());
    Ok(Some(connection))
}

fn parse_handoff(
    state: &AppState,
    thread: &Value,
    message: &str,
) -> Result<Option<(Value, String)>, ApiError> {
    let expression = regex::Regex::new(r"(?is)^/(?:handoff|交接)(?:\s+(.*))?$").unwrap();
    let Some(found) = expression.captures(message.trim()) else {
        return Ok(None);
    };
    let note = found.get(1).map(|m| m.as_str()).unwrap_or("");
    let option = regex::Regex::new(r"(?i)(?:^|[\s\u{fffc}])--issue(?:=|\s+)([^\s]+)").unwrap();
    let reference = option.captures(note);
    let issue_ref = reference
        .as_ref()
        .and_then(|m| m.get(1))
        .map(|m| m.as_str())
        .or_else(|| thread["origin"]["issueId"].as_str());
    let Some(issue_ref) = issue_ref else {
        return Err(ApiError::new(
            400,
            "AI_CHAT_ISSUE_REQUIRED",
            "Link this AI conversation to an issue or provide --issue ISSUE-ID",
        ));
    };
    let issue = state.db("getTask", &[json!(issue_ref)])?;
    if issue.is_null() {
        return Err(ApiError::new(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            format!("Task '{issue_ref}' does not exist"),
        ));
    }
    if !issue["archivedAt"].is_null() {
        return Err(ApiError::new(
            409,
            "AI_CHAT_ISSUE_UNAVAILABLE",
            "The linked issue is archived",
        ));
    }
    let note = reference
        .and_then(|m| m.get(0))
        .map(|m| format!("{}{}", &note[..m.start()], &note[m.end()..]))
        .unwrap_or_else(|| note.to_owned());
    Ok(Some((issue, note.trim().into())))
}

fn record_handoff(
    state: &AppState,
    thread_id: &str,
    run_id: &str,
    issue: &Value,
) -> Result<(), ApiError> {
    let current = state.db("getTask", &[issue["id"].clone()])?;
    if current.is_null() || !current["archivedAt"].is_null() {
        return Err(ApiError::new(
            409,
            "AI_CHAT_ISSUE_UNAVAILABLE",
            "The linked issue is no longer available",
        ));
    }
    let events = state.db("listAiChatEvents", &[json!(thread_id)])?;
    let summary = events
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|e| e["runId"] == run_id && e["role"] == "assistant")
        .and_then(|e| e["content"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::new(
                502,
                "HANDOFF_EMPTY",
                "Codex did not return a handoff summary",
            )
        })?;
    let thread = thread(state, thread_id)?;
    let title = thread["title"].as_str().unwrap_or("").replace('`', "\\`");
    let body=format!("<!-- codex-panel:ai-chat-handoff:v1 -->\n### AI 对话交接\n\n{summary}\n\n> 来源：内嵌 AI 对话「{title}」");
    let comment = state.db(
        "createComment",
        &[
            issue["id"].clone(),
            json!({"body":body,"actor":v::agent_actor()}),
        ],
    )?;
    state.emit("comment.created", json!({"comment":comment,"task":current}));
    Ok(())
}
