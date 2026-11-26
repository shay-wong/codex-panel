use super::{
    empty_response, json_body, json_response, methods, security, store, validate as v, AppState,
};
use crate::ApiError;
use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::{Component, Path},
    sync::Arc,
};

fn method_name(method: &Method) -> &str {
    method.as_str()
}
fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
fn argument(value: &Value, key: &str) -> Value {
    value
        .get(key)
        .cloned()
        .unwrap_or_else(|| json!({"$panelUndefined":true}))
}
fn no_query(raw: Option<&str>) -> Result<(), ApiError> {
    v::query(raw, &[]).map(|_| ())
}
fn missing(kind: &str, id: &str) -> ApiError {
    ApiError::new(
        404,
        format!("{}_NOT_FOUND", kind.to_uppercase()),
        format!("{kind} '{id}' does not exist"),
    )
}
fn task(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let value = state.db("resolveTaskReference", &[json!(id)])?;
    if value.is_null() {
        Err(missing("Task", id))
    } else {
        Ok(value)
    }
}
fn current_task(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let value = state.db("getTask", &[json!(id)])?;
    if value.is_null() {
        Err(missing("Task", id))
    } else {
        Ok(value)
    }
}

pub(super) async fn dispatch(
    state: &Arc<AppState>,
    method: &Method,
    path: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
    configured_trust: bool,
    peer: SocketAddr,
) -> Result<Response, ApiError> {
    let segments = path
        .trim_matches('/')
        .split('/')
        .map(v::path_segment)
        .collect::<Result<Vec<_>, _>>();
    let parts = if path == "/" { Vec::new() } else { segments? };
    let p = parts.iter().map(String::as_str).collect::<Vec<_>>();
    let m = method_name(method);
    let cloud_path = state.config.data_dir.join("cloud-companion.json");
    let cloud = store::read(&cloud_path, store::empty_cloud()).await?;
    if path.starts_with("/api/") && cloud["remoteUrl"].is_string() {
        if !peer.ip().is_loopback() {
            return Err(ApiError::new(
                403,
                "LOCAL_ONLY",
                "This endpoint is only available on this device",
            ));
        }
        if !local_companion(path) {
            return cloud_forward(state, method, path, raw, headers, bytes, &cloud).await;
        }
    }
    if let Some(response) = super::jira::handle(state, method, &p, raw, headers, bytes).await? {
        return Ok(response);
    }
    match p.as_slice() {
        ["api", "meta"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            no_query(raw)?;
            let mut value = json!({"capabilities":{"localAiChat":!configured_trust && peer.ip().is_loopback()}});
            if !configured_trust {
                value["managePanelSkillPath"] = json!(state
                    .config
                    .project_root
                    .join("skills/manage-panel/SKILL.md")
                    .to_string_lossy());
            }
            if cloud["remoteUrl"].is_string() {
                value["mode"] = json!("cloud");
                value["realtime"] = json!({"transport":"websocket","endpoint":"/api/events"});
                value["localCapabilities"] = json!({"available":!configured_trust});
            }
            Ok(json_response(200, value))
        }
        ["api", "events"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            no_query(raw)?;
            Ok(super::events(state))
        }
        ["api", "client-storage"] => client_storage(state, method, headers, bytes, &cloud).await,
        ["api", "local", "cloud-session"] => {
            no_query(raw)?;
            let status = |value: &Value| {
                if value["remoteUrl"].is_string() {
                    json!({"mode":"cloud","remoteUrl":value["remoteUrl"],"actorName":value["actorName"],"authenticated":true})
                } else {
                    json!({"mode":"local","authenticated":false})
                }
            };
            if m == "GET" {
                return Ok(json_response(200, status(&cloud)));
            }
            if m != "PUT" && m != "DELETE" {
                return Ok(methods(&["GET", "PUT", "DELETE"]));
            }
            let _guard = state.store_write.lock().await;
            let mut cloud = store::read(&cloud_path, store::empty_cloud()).await?;
            if m == "PUT" {
                let body = json_body(headers, bytes)?;
                v::allowed(&body, &["remoteUrl", "actorName", "sharedKey"])?;
                let url = store::cloud_url(&body["remoteUrl"])?;
                let actor = v::required_string(body.get("actorName"), "actorName", 120)?;
                if actor.contains(':') {
                    return Err(ApiError::new(
                        400,
                        "INVALID_CLOUD_ACTOR",
                        "Cloud actor name cannot contain ':'",
                    ));
                }
                let key = body["sharedKey"]
                    .as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 4096)
                    .ok_or_else(|| {
                        ApiError::new(
                            400,
                            "INVALID_CLOUD_KEY",
                            "Cloud shared key must be 1 to 4096 characters",
                        )
                    })?;
                cloud["remoteUrl"] = json!(url);
                cloud["actorName"] = json!(actor);
                cloud["sharedKey"] = json!(key);
            } else {
                cloud["remoteUrl"] = Value::Null;
                cloud["actorName"] = Value::Null;
                cloud["sharedKey"] = Value::Null;
            }
            store::write(&cloud_path, &cloud).await?;
            Ok(json_response(200, status(&cloud)))
        }
        ["api", "local", "project-mappings", id] => {
            if m != "PUT" {
                return Ok(methods(&["PUT"]));
            }
            no_query(raw)?;
            v::project_id(id)?;
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["workspacePath"])?;
            let path = v::required_string(body.get("workspacePath"), "workspacePath", 4096)?;
            if !Path::new(&path).is_absolute() || path.contains('\0') {
                return Err(v::invalid("'workspacePath' must be absolute"));
            }
            let _guard = state.store_write.lock().await;
            let mut value = store::read(&cloud_path, store::empty_cloud()).await?;
            value["projectMappings"][*id] = json!(path);
            store::write(&cloud_path, &value).await?;
            Ok(json_response(
                200,
                json!({"projectId":id,"workspacePath":path}),
            ))
        }
        ["api", "local", "host-runtime"] => host_runtime(state, m, headers, bytes),
        ["api", "local", "codex-thread-progress"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let mut ids = std::collections::HashSet::new();
            for (key, value) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
                if key != "threadId" {
                    return Err(ApiError::new(
                        400,
                        "UNKNOWN_QUERY_PARAMETER",
                        "Only 'threadId' is supported",
                    ));
                }
                let value = value.trim();
                let value = value
                    .strip_prefix("local:")
                    .or_else(|| value.strip_prefix("cloud:"))
                    .unwrap_or(value);
                if uuid::Uuid::parse_str(value).is_err() {
                    return Err(v::invalid("'threadId' must contain valid Codex thread IDs"));
                }
                ids.insert(value.to_owned());
            }
            if ids.len() > 64 {
                return Err(v::invalid(
                    "'threadId' must contain at most 64 Codex thread IDs",
                ));
            }
            let mut progress = json!({});
            for id in ids {
                progress[&id] = super::session::progress(state, &id).await?;
            }
            Ok(json_response(200, json!({"progress":progress})))
        }
        ["api", "local", "ai", "catalog"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let query = v::query(
                raw,
                &[
                    "projectId",
                    "codexProjectId",
                    "codexProjectKind",
                    "codexHostId",
                    "workspacePath",
                ],
            )?;
            let project = query
                .get("projectId")
                .map(String::as_str)
                .unwrap_or("local");
            let target = serde_json::to_value(&query)?;
            let context = super::ai::context(state, project, None, Some(&target)).await?;
            match super::ai::catalog(state, &context).await {
                Ok(catalog) => Ok(json_response(200, catalog)),
                Err(error) if error.code == "CODEX_UNAVAILABLE" => Ok(json_response(
                    200,
                    json!({"available":false,"models":[],"skills":[],"commands":[],"sandboxes":["read-only","workspace-write","danger-full-access"]}),
                )),
                Err(error) => Err(error),
            }
        }
        ["api", "local", "ai", "composer", "candidates"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let query = v::query(
                raw,
                &[
                    "projectId",
                    "threadId",
                    "trigger",
                    "query",
                    "surface",
                    "codexProjectId",
                    "codexProjectKind",
                    "codexHostId",
                    "workspacePath",
                ],
            )?;
            let trigger = query.get("trigger").map(String::as_str).unwrap_or("");
            if !["@", "/"].contains(&trigger) {
                return Err(ApiError::new(
                    400,
                    "INVALID_COMPOSER_QUERY",
                    "Composer trigger must be '/' or '@'",
                ));
            }
            let search = query.get("query").map(String::as_str).unwrap_or("");
            if search.encode_utf16().count() > 256 {
                return Err(ApiError::new(
                    400,
                    "INVALID_COMPOSER_QUERY",
                    "Composer query cannot exceed 256 characters",
                ));
            }
            let surface = query
                .get("surface")
                .map(String::as_str)
                .unwrap_or("ai-chat");
            if !["ai-chat", "issue-description", "comment"].contains(&surface) {
                return Err(ApiError::new(
                    400,
                    "INVALID_COMPOSER_QUERY",
                    "Unknown composer surface",
                ));
            }
            let thread = if let Some(id) = query.get("threadId") {
                Some(super::ai::thread(state, id)?)
            } else {
                None
            };
            let project = thread
                .as_ref()
                .and_then(|t| t["origin"]["projectId"].as_str())
                .or_else(|| query.get("projectId").map(String::as_str));
            if let (Some(thread), Some(project)) = (&thread, query.get("projectId")) {
                if thread["origin"]["projectId"] != *project {
                    return Err(ApiError::new(
                        400,
                        "INVALID_COMPOSER_QUERY",
                        "Composer thread does not belong to the selected project",
                    ));
                }
            }
            let target = serde_json::to_value(&query)?;
            let context = if let Some(project) = project {
                Some(
                    super::ai::context(
                        state,
                        project,
                        thread
                            .as_ref()
                            .and_then(|t| t["origin"]["issueId"].as_str()),
                        thread
                            .as_ref()
                            .and_then(|t| {
                                t.get("origin")
                                    .filter(|origin| origin["codexProjectKind"] == "remote")
                            })
                            .or(Some(&target)),
                    )
                    .await?,
                )
            } else {
                None
            };
            if let (Some(thread), Some(context)) = (&thread, &context) {
                if thread["origin"]["workspacePath"] != context.workspace {
                    return Err(ApiError::new(
                        400,
                        "INVALID_COMPOSER_QUERY",
                        "Composer thread workspace no longer matches the selected project",
                    ));
                }
            }
            let catalog = super::composer::load(state, context.as_ref()).await?;
            Ok(json_response(
                200,
                super::composer::candidates(
                    &catalog,
                    trigger,
                    search,
                    surface,
                    thread.as_ref().is_some_and(|t| {
                        t["codexThreadId"].is_string() && t["status"] != "running"
                    }),
                ),
            ))
        }
        ["api", "local", "ai", "composer", "rebind"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(
                &body,
                &["contractVersion", "projectId", "threadId", "document"],
            )?;
            if body["contractVersion"] != "composer.v1" || body["document"]["version"] != 1 {
                return Err(ApiError::new(
                    400,
                    "INVALID_COMPOSER_QUERY",
                    "Unknown composer contract",
                ));
            }
            v::allowed(&body["document"], &["version", "nodes"])?;
            let nodes = body["document"]["nodes"]
                .as_array()
                .filter(|nodes| nodes.len() <= 200)
                .ok_or_else(|| {
                    ApiError::new(
                        400,
                        "INVALID_COMPOSER_QUERY",
                        "Composer document must contain at most 200 nodes",
                    )
                })?;
            let project = v::required_string(body.get("projectId"), "projectId", 64)?;
            let thread = if let Some(id) = body["threadId"].as_str() {
                Some(super::ai::thread(state, id)?)
            } else {
                None
            };
            if thread
                .as_ref()
                .is_some_and(|thread| thread["origin"]["projectId"] != project)
            {
                return Err(ApiError::new(
                    400,
                    "INVALID_COMPOSER_QUERY",
                    "Composer thread does not belong to the selected project",
                ));
            }
            let context = super::ai::context(
                state,
                &project,
                thread
                    .as_ref()
                    .and_then(|thread| thread["origin"]["issueId"].as_str()),
                thread.as_ref().and_then(|t| {
                    t.get("origin")
                        .filter(|origin| origin["codexProjectKind"] == "remote")
                }),
            )
            .await?;
            let catalog = super::composer::load(state, Some(&context)).await?;
            Ok(json_response(
                200,
                super::composer::rebind(&catalog, nodes)?,
            ))
        }
        ["api", "local", "ai", "threads"] => {
            no_query(raw)?;
            if m == "GET" {
                return Ok(json_response(
                    200,
                    json!({"threads":state.db("listAiChatThreads",&[])?}),
                ));
            }
            if m != "POST" {
                return Ok(methods(&["GET", "POST"]));
            }
            let body = json_body(headers, bytes)?;
            Ok(json_response(
                201,
                json!({"thread":super::ai::create_thread(state,&body).await?}),
            ))
        }
        ["api", "local", "ai", "threads", id] => {
            no_query(raw)?;
            if m == "GET" {
                return Ok(json_response(
                    200,
                    json!({"thread":super::ai::thread(state,id)?,"events":state.db("listAiChatEvents",&[json!(id)])?,"runs":state.db("listAiChatRuns",&[json!(id)])?}),
                ));
            }
            if m == "PATCH" {
                let body = json_body(headers, bytes)?;
                return Ok(json_response(
                    200,
                    json!({"thread":super::ai::update_thread(state,id,&body).await?}),
                ));
            }
            if m == "DELETE" {
                if !bytes.is_empty() {
                    return Err(ApiError::new(
                        400,
                        "INVALID_BODY",
                        "DELETE /api/local/ai/threads/:id does not accept a request body",
                    ));
                }
                let thread = super::ai::thread(state, id)?;
                if thread["status"] == "running" {
                    return Err(ApiError::new(
                        409,
                        "THREAD_BUSY",
                        format!("AI chat thread '{id}' has a running turn"),
                    ));
                }
                state.db("deleteAiChatThread", &[json!(id)])?;
                return Ok(empty_response(204));
            }
            Ok(methods(&["GET", "PATCH", "DELETE"]))
        }
        ["api", "local", "ai", "threads", id, "summary"] => {
            no_query(raw)?;
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            Ok(json_response(
                200,
                json!({"thread":super::ai::thread(state,id)?,"runs":state.db("listAiChatRuns",&[json!(id)])?}),
            ))
        }
        ["api", "local", "ai", "threads", id, "turns"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let input = json_body(headers, bytes)?;
            Ok(json_response(
                202,
                json!({"run":super::ai::start_turn(state,id,&input).await?}),
            ))
        }
        ["api", "local", "ai", "threads", id, "compact"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            if !bytes.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_BODY",
                    "Compact does not accept a request body",
                ));
            }
            Ok(json_response(
                200,
                json!({"thread":super::ai::compact(state,id).await?}),
            ))
        }
        ["api", "local", "ai", "threads", id, "events"] => {
            no_query(raw)?;
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            super::ai::thread(state, id)?;
            Ok(super::ai_events(state, id))
        }
        ["api", "local", "ai", "runs", id, "interrupt"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            if !bytes.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_BODY",
                    "Interrupt does not accept a request body",
                ));
            }
            Ok(json_response(
                200,
                json!({"run":super::ai::interrupt(state,id).await?}),
            ))
        }
        ["api", "local", "ai", "events", id, "images", offset] => {
            no_query(raw)?;
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let offset = offset.parse::<usize>().map_err(|_| {
                ApiError::new(
                    404,
                    "AI_CHAT_LOCAL_IMAGE_NOT_FOUND",
                    "Local image position is invalid",
                )
            })?;
            let event = state.db("getAiChatEvent", &[json!(id)])?;
            if event.is_null() {
                return Err(ApiError::new(
                    404,
                    "AI_CHAT_EVENT_NOT_FOUND",
                    "AI chat event does not exist",
                ));
            }
            let source = event["content"].as_str().unwrap_or("");
            let destination = pulldown_cmark::Parser::new(source)
                .into_offset_iter()
                .find_map(|(event, range)| {
                    if source[..range.start].encode_utf16().count() != offset {
                        return None;
                    }
                    if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image {
                        dest_url,
                        ..
                    }) = event
                    {
                        Some(dest_url.to_string())
                    } else {
                        None
                    }
                })
                .ok_or_else(|| {
                    ApiError::new(
                        404,
                        "AI_CHAT_LOCAL_IMAGE_NOT_FOUND",
                        "Local image is not present at this message position",
                    )
                })?;
            let filename = if destination.to_lowercase().starts_with("file:") {
                url::Url::parse(&destination)
                    .ok()
                    .and_then(|u| u.to_file_path().ok())
            } else {
                v::decode(&destination).ok().map(std::path::PathBuf::from)
            }
            .filter(|p| p.is_absolute() && !p.to_string_lossy().contains('\0'))
            .ok_or_else(|| {
                ApiError::new(
                    404,
                    "AI_CHAT_LOCAL_IMAGE_NOT_FOUND",
                    "Message position does not reference a local image",
                )
            })?;
            let data = tokio::fs::read(&filename).await.map_err(|_| {
                ApiError::new(
                    404,
                    "AI_CHAT_LOCAL_IMAGE_NOT_FOUND",
                    "Local image is unavailable",
                )
            })?;
            let mime = if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                "image/png"
            } else if data.starts_with(&[255, 216, 255]) {
                "image/jpeg"
            } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
                "image/gif"
            } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                return Err(ApiError::new(
                    415,
                    "AI_CHAT_LOCAL_IMAGE_UNSUPPORTED",
                    "Local file is not a supported image",
                ));
            };
            Response::builder()
                .status(200)
                .header("cache-control", "no-store")
                .header("content-type", mime)
                .header("x-content-type-options", "nosniff")
                .body(Body::from(data))
                .map_err(|e| ApiError::new(500, "INVALID_RESPONSE", e.to_string()))
        }
        ["api", "device-workspaces"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            no_query(raw)?;
            let workspaces = device_workspaces(state).await?;
            Ok(json_response(200, json!({"workspaces":workspaces})))
        }
        ["api", "projects"] => {
            if m == "GET" {
                no_query(raw)?;
                let mut projects = state.db("listProjects", &[])?;
                let device = device_workspaces(state).await?;
                if let Some(projects) = projects.as_array_mut() {
                    for project in projects {
                        let id = project["id"].as_str().unwrap_or("");
                        project["workspacePath"] = if id == "local" {
                            Value::Null
                        } else {
                            cloud["projectMappings"]
                                .get(id)
                                .or_else(|| device.get(id))
                                .cloned()
                                .unwrap_or_else(|| field(project, "workspacePath"))
                        };
                    }
                }
                return Ok(json_response(200, json!({"projects":projects})));
            }
            if m == "POST" {
                let body = json_body(headers, bytes)?;
                v::allowed(&body, &["id", "name", "issueKey", "workspacePath"])?;
                let name = v::required_string(body.get("name"), "name", 120)?;
                let generated = regex::Regex::new("[^a-z0-9]+")
                    .unwrap()
                    .replace_all(&name.to_ascii_lowercase(), "-")
                    .trim_matches('-')
                    .chars()
                    .take(64)
                    .collect::<String>();
                let id = v::project_id(body["id"].as_str().unwrap_or(&generated))?;
                let mut input = json!({"id":id,"name":name,"workspacePath":v::string(body.get("workspacePath"),"workspacePath",false,true,4096)?.unwrap_or(Value::Null)});
                if input["workspacePath"]
                    .as_str()
                    .is_some_and(|s| s.is_empty() || s.contains('\0'))
                {
                    return Err(v::invalid("'workspacePath' is invalid"));
                }
                if let Some(key) = body.get("issueKey") {
                    input["issueKey"] = v::issue_key(key)?;
                }
                let project = state.db("createProject", &[input])?;
                state.emit("project.created", json!({"project":project}));
                return Ok(json_response(201, json!({"project":project})));
            }
            Ok(methods(&["GET", "POST"]))
        }
        ["api", "projects", id] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m != "DELETE" {
                return Ok(methods(&["DELETE"]));
            }
            state.db("deleteProject", &[json!(id)])?;
            Ok(empty_response(204))
        }
        ["api", "projects", id, "issue-key"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m != "PUT" {
                return Ok(methods(&["PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["issueKey"])?;
            let result = state.db(
                "migrateProjectIssueKey",
                &[json!(id), v::issue_key(&body["issueKey"])?],
            )?;
            state.emit("project.updated", json!({"project":result["project"]}));
            Ok(json_response(200, result))
        }
        ["api", "projects", id, "labels"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if !["POST", "DELETE"].contains(&m) {
                return Ok(methods(&["POST", "DELETE"]));
            }
            if m == "DELETE" && *id == v::JIRA_PROJECT {
                return Err(ApiError::new(
                    409,
                    "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
                    "Jira 标签目录由同步管理，不能在 Panel 中删除",
                ));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["label"])?;
            let label = v::required_string(body.get("label"), "label", 64)?;
            let project = state.db(
                if m == "POST" {
                    "addProjectLabel"
                } else {
                    "deleteProjectLabel"
                },
                &[json!(id), json!(label)],
            )?;
            state.emit("project.labels.updated", json!({"project":project}));
            Ok(json_response(200, json!({"project":project})))
        }
        ["api", "projects", id, "readme"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m == "GET" {
                return Ok(json_response(
                    200,
                    json!({"readme":state.db("getProjectReadme",&[json!(id)])?}),
                ));
            }
            if m != "PUT" {
                return Ok(methods(&["GET", "PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["content", "version"])?;
            let content = body.get("content").and_then(Value::as_str).unwrap_or("");
            if body.get("content").is_some_and(|v| !v.is_string())
                || content.encode_utf16().count() > 500_000
            {
                return Err(v::invalid(
                    "'content' must be a string of at most 500000 characters",
                ));
            }
            if body.get("version").is_some_and(|v| v.as_u64().is_none()) {
                return Err(v::invalid("'version' must be a non-negative integer"));
            }
            let readme = state.db(
                "saveProjectReadme",
                &[json!(id), json!(content), field(&body, "version")],
            )?;
            state.emit(
                "project.readme.updated",
                json!({"projectId":id,"readmeVersion":readme["version"]}),
            );
            Ok(json_response(200, json!({"readme":readme})))
        }
        ["api", "projects", id, "readme", "attachments"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let metadata = v::attachment(headers)?;
            if metadata["kind"] != "inline" {
                return Err(ApiError::new(
                    400,
                    "INVALID_ATTACHMENT_KIND",
                    "Project README attachments must be inline",
                ));
            }
            upload(state, id, "createProjectReadmeAttachment", metadata, bytes).await
        }
        ["api", "projects", id, "development-contexts"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            v::project_id(id)?;
            let query = v::query(raw, &["codexProjectId", "codexThreadId", "workspacePath"])?;
            let project = state.db("getProject", &[json!(id)])?;
            if project.is_null() {
                return Err(missing("Project", id));
            }
            let devices = device_workspaces(state).await?;
            let workspace = query
                .get("workspacePath")
                .cloned()
                .or_else(|| cloud["projectMappings"][*id].as_str().map(str::to_owned))
                .or_else(|| devices[*id].as_str().map(str::to_owned))
                .or_else(|| project["workspacePath"].as_str().map(str::to_owned));
            let result = scan_contexts(workspace.as_deref()).await?;
            Ok(json_response(200, result))
        }
        ["api", "tasks"] => {
            if m == "GET" {
                let query = v::query(raw, &["projectId", "status", "archived"])?;
                let mut filter = json!({"archived":query.get("archived").map(String::as_str).unwrap_or("false")});
                if !["true", "false", "all"].contains(&filter["archived"].as_str().unwrap()) {
                    return Err(ApiError::new(
                        400,
                        "INVALID_QUERY_PARAMETER",
                        "'archived' must be true, false, or all",
                    ));
                }
                if let Some(id) = query.get("projectId") {
                    filter["projectId"] = json!(v::project_id(id)?);
                }
                if let Some(status) = query.get("status") {
                    filter["status"] = v::status(Some(&json!(status)), None)?;
                }
                return Ok(json_response(
                    200,
                    json!({"tasks":state.db("listTasks",&[filter])?}),
                ));
            }
            if m != "POST" {
                return Ok(methods(&["GET", "POST"]));
            }
            let mut input = v::task(&json_body(headers, bytes)?, true)?;
            if input["projectId"] == v::JIRA_PROJECT {
                return Err(ApiError::new(
                    409,
                    "JIRA_CREATE_UNAVAILABLE",
                    "请在 Jira 中新建议题，Panel 当前只同步已分配给你的任务",
                ));
            }
            resolve_attribution(state, &mut input)?;
            let actor = v::actor(headers)?;
            input["actor"] = actor.clone();
            input["assignee"] = assignee(&input, &actor)?;
            input.as_object_mut().unwrap().remove("assigneeTarget");
            let task = state.db("createTask", &[input])?;
            state.emit("task.created", json!({"task":task}));
            Ok(json_response(201, json!({"task":task})))
        }
        ["api", "tasks", id] => task_route(state, m, id, raw, headers, bytes).await,
        ["api", "tasks", id, action]
            if ["move", "archive", "restore", "bind-thread"].contains(action) =>
        {
            task_action(state, m, id, action, raw, headers, bytes).await
        }
        ["api", "tasks", id, "tree"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let query = v::query(raw, &["direction", "depth"])?;
            let direction = query.get("direction").map(String::as_str).unwrap_or("");
            let depth = query
                .get("depth")
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| (1..=25).contains(n));
            if !["ancestors", "descendants"].contains(&direction) || depth.is_none() {
                return Err(ApiError::new(
                    400,
                    "INVALID_TREE_QUERY",
                    "direction must be ancestors or descendants and depth must be 1 through 25",
                ));
            }
            let task = task(state, id)?;
            Ok(json_response(
                200,
                json!({"tree":state.db("getTaskTree",&[task["id"].clone(),json!(direction),json!(depth.unwrap())])?}),
            ))
        }
        ["api", "tasks", id, "activities"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            no_query(raw)?;
            let task = task(state, id)?;
            Ok(json_response(
                200,
                json!({"activities":state.db("listTaskActivities",&[task["id"].clone()])?}),
            ))
        }
        ["api", "tasks", id, "comments"] => comments(state, m, id, raw, headers, bytes).await,
        ["api", "comments", id] => comment_route(state, m, id, raw, headers, bytes),
        ["api", "tasks", id, "attachments"] => {
            attachments(state, m, id, false, raw, headers, bytes).await
        }
        ["api", "comments", id, "attachments"] => {
            attachments(state, m, id, true, raw, headers, bytes).await
        }
        ["api", "attachments", id, action] if ["content", "download"].contains(action) => {
            attachment_content(state, m, id, action, raw).await
        }
        ["api", "attachments", id] => delete_attachment(state, m, id, raw).await,
        ["api", "tasks", id, "relations", kind, related] => {
            no_query(raw)?;
            if !["POST", "DELETE"].contains(&m) {
                return Ok(methods(&["POST", "DELETE"]));
            }
            if !["parent", "blocks", "blocked_by", "related"].contains(kind) {
                return Err(v::invalid("Unknown relation type"));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(
                &body,
                &[
                    "version",
                    "threadId",
                    "threadBinding",
                    "agentSession",
                    "origin",
                ],
            )?;
            let mut attribution = v::attribution(&body)?;
            resolve_attribution(state, &mut attribution)?;
            if body
                .get("origin")
                .is_some_and(|v| !["manual", "mention"].contains(&v.as_str().unwrap_or("")))
            {
                return Err(v::invalid("'origin' must be manual or mention"));
            }
            let result = state.db(
                if m == "POST" {
                    "addTaskRelation"
                } else {
                    "removeTaskRelation"
                },
                &[
                    json!(id),
                    v::version(body.get("version"))?,
                    json!(kind),
                    json!(related),
                    argument(&attribution, "threadId"),
                    argument(&attribution, "threadBinding"),
                    v::actor(headers)?,
                    field(&body, "origin"),
                    argument(&attribution, "agentSession"),
                ],
            )?;
            state.emit("task.relation.updated", result.clone());
            Ok(json_response(200, result))
        }
        ["api", "tasks", id, "planning"] => {
            no_query(raw)?;
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            Ok(json_response(
                200,
                json!({"plan":state.db("getTaskPlan",&[json!(id)])?}),
            ))
        }
        ["api", "tasks", id, "planning", "spec"] => {
            no_query(raw)?;
            if m != "PUT" {
                return Ok(methods(&["PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "spec"])?;
            let plan = state.db(
                "saveTaskPlanSpec",
                &[
                    json!(id),
                    v::version(body.get("version"))?,
                    json!(v::required_string(body.get("spec"), "spec", 200_000)?),
                ],
            )?;
            state.emit(
                "task.plan.updated",
                json!({"taskId":id,"task":state.db("getTask",&[json!(id)])?}),
            );
            Ok(json_response(200, json!({"plan":plan})))
        }
        ["api", "local", "workflow-settings"] => workflow_settings(state, m, raw, headers, bytes),
        ["api", "local", "workflow"] => {
            if m != "GET" {
                return Ok(methods(&["GET"]));
            }
            let query = v::query(raw, &["stage", "projectId"])?;
            let stage = query.get("stage").map(String::as_str).unwrap_or("");
            if !v::STAGES.contains(&stage) {
                return Err(v::invalid("Unknown workflow stage"));
            }
            let project = query
                .get("projectId")
                .map(String::as_str)
                .unwrap_or("local");
            v::project_id(project)?;
            Ok(json_response(200, workflow(state, project, stage).await?))
        }
        ["api", "local", "projects", id, "automation"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m == "GET" {
                return Ok(json_response(
                    200,
                    json!({"policy":state.db("getProjectAutomationPolicy",&[json!(id)])?}),
                ));
            }
            if m != "PUT" {
                return Ok(methods(&["GET", "PUT"]));
            }
            let body = json_body(headers, bytes)?;
            let input = super::claims::policy(&body)?;
            let policy = state.db("saveProjectAutomationPolicy", &[json!(id), input])?;
            state.emit(
                "automation.updated",
                json!({"projectId":id,"policy":policy}),
            );
            Ok(json_response(200, json!({"policy":policy})))
        }
        ["api", "local", "projects", id, "summary"] => {
            no_query(raw)?;
            v::project_id(id)?;
            if m == "POST" {
                if !bytes.is_empty() {
                    return Err(ApiError::new(
                        400,
                        "INVALID_BODY",
                        "Summary refresh does not accept a request body",
                    ));
                }
                super::summary::refresh(state, id).await?;
            } else if m != "GET" {
                return Ok(methods(&["GET", "POST"]));
            }
            Ok(json_response(200, super::summary::get(state, id)?))
        }
        ["api", "local", "tasks", id, "claim"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            if !bytes.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_BODY",
                    "Claim does not accept a request body",
                ));
            }
            Ok(json_response(
                202,
                super::claims::enqueue(state, id, "manual")?,
            ))
        }
        ["api", "local", "tasks", id, "prepare-execution"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["useWorktree"])?;
            let use_worktree = body["useWorktree"]
                .as_bool()
                .ok_or_else(|| v::invalid("useWorktree must be a boolean"))?;
            Ok(json_response(
                200,
                super::claims::prepare_manual(state, id, use_worktree).await?,
            ))
        }
        ["api", "local", "tasks", id, "prepare-planning"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            if !bytes.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_BODY",
                    "Planning preparation does not accept a request body",
                ));
            }
            Ok(json_response(
                200,
                super::planning::prepare_local(state, id).await?,
            ))
        }
        ["api", "local", "native-claims", "next"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            if !bytes.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_BODY",
                    "Claim reservation does not accept a request body",
                ));
            }
            Ok(json_response(
                200,
                json!({"claim":super::claims::reserve(state).await?}),
            ))
        }
        ["api", "local", "native-claims", action] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            if *action == "bind" {
                v::allowed(
                    &body,
                    &[
                        "reservationId",
                        "taskId",
                        "threadBinding",
                        "developmentContext",
                    ],
                )?;
                let reservation =
                    v::required_string(body.get("reservationId"), "reservationId", 128)?;
                let id = v::required_string(body.get("taskId"), "taskId", 128)?;
                let binding = v::binding(body.get("threadBinding"))?
                    .filter(|v| v["codexProjectId"].is_string())
                    .ok_or_else(|| v::invalid("threadBinding requires full identity"))?;
                let development = body
                    .get("developmentContext")
                    .cloned()
                    .unwrap_or(Value::Null);
                if !development.is_null() {
                    let parsed = v::task(
                        &json!({"title":"validation","developmentContext":development}),
                        true,
                    )?;
                    if parsed["developmentContext"] != development {
                        return Err(v::invalid("Invalid development context"));
                    }
                }
                return Ok(json_response(
                    200,
                    super::claims::bind(state, &reservation, &id, binding, development)?,
                ));
            }
            if *action == "fail" {
                v::allowed(&body, &["reservationId", "taskId", "error"])?;
                let reservation =
                    v::required_string(body.get("reservationId"), "reservationId", 128)?;
                let id = v::required_string(body.get("taskId"), "taskId", 128)?;
                let error = v::required_string(body.get("error"), "error", 4096)?;
                return Ok(json_response(
                    200,
                    json!({"claim":super::claims::fail(state,&reservation,&id,&error)?}),
                ));
            }
            Err(ApiError::new(
                404,
                "NOT_FOUND",
                "Native claim action not found",
            ))
        }
        ["api", "local", "jira-settings"] => {
            no_query(raw)?;
            if m == "GET" {
                return Ok(json_response(
                    200,
                    json!({"settings":state.db("getJiraSettings",&[])?}),
                ));
            }
            if m != "PUT" {
                return Ok(methods(&["GET", "PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["autoCompleteEnabled", "autoArchiveEnabled"])?;
            if !body["autoCompleteEnabled"].is_boolean() || !body["autoArchiveEnabled"].is_boolean()
            {
                return Err(v::invalid("Jira switches must be boolean"));
            }
            let settings = state.db("saveJiraSettings", &[body])?;
            if settings["autoCompleteEnabled"] == true {
                state.db("queueEligibleJiraAutoCompletions", &[])?;
            }
            Ok(json_response(200, json!({"settings":settings})))
        }
        ["api", "tasks", id, "jira-context"] => {
            no_query(raw)?;
            if m == "GET" {
                let task = task(state, id)?;
                return Ok(json_response(
                    200,
                    json!({"context":state.db("getJiraContext",&[task["id"].clone()])?}),
                ));
            }
            if m != "PUT" {
                return Ok(methods(&["GET", "PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "projectIds"])?;
            let ids = body["projectIds"]
                .as_array()
                .ok_or_else(|| v::invalid("'projectIds' must be an array"))?;
            for id in ids {
                v::project_id(id.as_str().unwrap_or(""))?;
            }
            let devices = device_workspaces(state).await?;
            let mut mapped = devices
                .as_object()
                .map(|v| v.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if let Some(mappings) = cloud["projectMappings"].as_object() {
                mapped.extend(mappings.keys().cloned());
            }
            let context = state.db(
                "setJiraProjects",
                &[
                    json!(id),
                    v::version(body.get("version"))?,
                    body["projectIds"].clone(),
                    v::actor(headers)?,
                    json!(mapped),
                ],
            )?;
            state.emit(
                "task.jira.updated",
                json!({"taskId":id,"task":context["jira"]}),
            );
            Ok(json_response(200, json!({"context":context})))
        }
        ["api", "tasks", id, "jira-links", linked] => {
            no_query(raw)?;
            if !["POST", "DELETE"].contains(&m) {
                return Ok(methods(&["POST", "DELETE"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(
                &body,
                &["version", "threadId", "threadBinding", "agentSession"],
            )?;
            let context = state.db(
                if m == "POST" {
                    "addJiraTaskLink"
                } else {
                    "removeJiraTaskLink"
                },
                &[
                    json!(id),
                    v::version(body.get("version"))?,
                    json!(linked),
                    v::actor(headers)?,
                ],
            )?;
            state.emit(
                "task.jira.updated",
                json!({"taskId":id,"task":context["jira"]}),
            );
            Ok(json_response(200, json!({"context":context})))
        }
        ["api", "tasks", id, "jira-conversation-archive"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version"])?;
            let context = state.db(
                "archiveJiraConversations",
                &[json!(id), v::version(body.get("version"))?],
            )?;
            state.emit(
                "task.jira.updated",
                json!({"taskId":id,"task":context["jira"]}),
            );
            Ok(json_response(200, json!({"context":context})))
        }
        ["api", "tasks", id, "jira-planning", "spec"] => {
            no_query(raw)?;
            if m != "PUT" {
                return Ok(methods(&["PUT"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "spec"])?;
            let plan = state.db(
                "saveJiraPlanSpec",
                &[
                    json!(id),
                    v::version(body.get("version"))?,
                    json!(v::required_string(body.get("spec"), "spec", 200_000)?),
                ],
            )?;
            let context = state.db("getJiraContext", &[json!(id)])?;
            state.emit(
                "task.jira.updated",
                json!({"taskId":id,"task":state.db("getTask",&[json!(id)])?}),
            );
            Ok(json_response(200, json!({"context":context,"plan":plan})))
        }
        ["api", "tasks", id, "jira-planning"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "threadId", "projectId", "reuseThread"])?;
            if body.get("reuseThread").is_some_and(|v| !v.is_boolean()) {
                return Err(v::invalid("reuseThread must be a boolean"));
            }
            if body["reuseThread"] == true && !body["threadId"].is_string() {
                return Err(v::invalid("reuseThread requires threadId"));
            }
            Ok(json_response(
                200,
                super::planning::start(
                    state,
                    id,
                    v::version(body.get("version"))?,
                    body["threadId"].as_str(),
                    body["projectId"].as_str(),
                    body["reuseThread"] == true,
                )
                .await?,
            ))
        }
        ["api", "tasks", id, "jira-lifecycle"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            Ok(json_response(
                200,
                super::planning::lifecycle(state, id, &body, v::actor(headers)?).await?,
            ))
        }
        ["api", "tasks", id, "jira-simple-start"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "clarification"])?;
            let clarification = v::string(
                body.get("clarification"),
                "clarification",
                false,
                false,
                20_000,
            )?
            .unwrap_or_else(|| json!(""));
            Ok(json_response(
                200,
                super::planning::simple_start(
                    state,
                    id,
                    v::version(body.get("version"))?,
                    v::actor(headers)?,
                    clarification.as_str().unwrap_or(""),
                )
                .await?,
            ))
        }
        ["api", "tasks", id, "jira-planning", "publish"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "items"])?;
            Ok(json_response(
                200,
                super::planning::publish(
                    state,
                    id,
                    v::version(body.get("version"))?,
                    body["items"].clone(),
                    v::actor(headers)?,
                )?,
            ))
        }
        ["api", "tasks", id, "jira-shared-execution"] => {
            no_query(raw)?;
            if m != "POST" {
                return Ok(methods(&["POST"]));
            }
            let body = json_body(headers, bytes)?;
            v::allowed(&body, &["version", "threadId"])?;
            let thread = v::required_string(body.get("threadId"), "threadId", 256)?;
            let context = state.db(
                "enableSharedJiraExecution",
                &[json!(id), v::version(body.get("version"))?, json!(thread)],
            )?;
            if let Some(jiras) = context["sharedExecutionJira"].as_array() {
                for jira in jiras {
                    state.emit("task.jira.updated",json!({"taskId":jira["id"],"task":state.db("getTask",&[jira["id"].clone()])?}));
                }
            }
            Ok(json_response(200, json!({"context":context})))
        }
        ["api", ..] => Err(ApiError::new(404, "NOT_FOUND", "API route not found")),
        _ => static_file(state, method, path).await,
    }
}

fn assignee(input: &Value, actor: &Value) -> Result<Value, ApiError> {
    match input["assigneeTarget"].as_str() {
        Some("codex-agent") => Ok(v::agent_actor()),
        Some("current-user") if actor["type"] != "user" => Err(v::invalid(
            "'current-user' requires a user request identity",
        )),
        _ => Ok(actor.clone()),
    }
}

fn resolve_attribution(state: &AppState, input: &mut Value) -> Result<(), ApiError> {
    if input.get("threadBinding").is_none() && input["threadId"].is_string() {
        let host = state
            .host_runtime
            .lock()
            .map_err(|_| ApiError::new(500, "RUNTIME_LOCK", "Runtime lock was poisoned"))?;
        if let Some(host) = host.as_ref() {
            if host["threadId"] == input["threadId"]
                && [
                    "codexProjectId",
                    "codexProjectKind",
                    "codexHostId",
                    "workspacePath",
                ]
                .iter()
                .all(|key| host[*key].is_string())
            {
                input["threadBinding"] = json!({"threadId":host["threadId"],"codexProjectId":host["codexProjectId"],"codexProjectKind":host["codexProjectKind"],"codexHostId":host["codexHostId"],"workspacePath":host["workspacePath"]});
            }
        }
    }
    Ok(())
}

async fn task_route(
    state: &AppState,
    m: &str,
    id: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    if m == "GET" {
        no_query(raw)?;
        return Ok(json_response(200, json!({"task":task(state,id)?})));
    }
    if m == "PATCH" {
        let mut input = v::task(&json_body(headers, bytes)?, false)?;
        resolve_attribution(state, &mut input)?;
        let current = current_task(state, id)?;
        if current["source"] != "jira" && input["projectId"] == v::JIRA_PROJECT {
            return Err(ApiError::new(
                409,
                "JIRA_PROJECT_MOVE_UNAVAILABLE",
                "本地任务不能移入 Jira 同步项目",
            ));
        }
        let actor = v::actor(headers)?;
        if input.get("assigneeTarget").is_some() {
            input["assignee"] = assignee(&input, &actor)?;
        }
        let mut changes = input.clone();
        for name in [
            "version",
            "threadId",
            "threadBinding",
            "agentSession",
            "assigneeTarget",
        ] {
            changes.as_object_mut().unwrap().remove(name);
        }
        if current["source"] == "jira" {
            if current["version"] != input["version"] {
                return Err(ApiError::new(
                    409,
                    "VERSION_CONFLICT",
                    "Task changed since it was last read",
                )
                .with_details(
                    json!({"expectedVersion":input["version"],"actualVersion":current["version"]}),
                ));
            }
            if !current["archivedAt"].is_null() {
                return Err(ApiError::new(
                    409,
                    "TASK_ARCHIVED",
                    "Archived tasks cannot be updated",
                ));
            }
            if changes.get("projectId").is_some() {
                return Err(ApiError::new(
                    409,
                    "JIRA_PROJECT_MOVE_UNAVAILABLE",
                    "Jira 任务不能移到本地项目",
                ));
            }
            if input.get("assigneeTarget").is_some() {
                return Err(ApiError::new(
                    409,
                    "JIRA_ASSIGNEE_UNAVAILABLE",
                    "请在 Jira 中修改经办人",
                ));
            }
        }
        let jira_changed = if current["source"] == "jira" {
            super::jira::update_task(state, &current, &changes).await?
        } else {
            false
        };
        let updated = state.db(
            "updateTask",
            &[
                json!(id),
                input["version"].clone(),
                changes,
                argument(&input, "threadId"),
                argument(&input, "threadBinding"),
                actor,
                argument(&input, "agentSession"),
            ],
        );
        let mut task = match updated {
            Ok(task) => task,
            Err(error) => {
                if jira_changed {
                    super::jira::reconcile(state).await.map_err(|_| {
                        ApiError::new(
                            502,
                            "JIRA_RECONCILE_FAILED",
                            "Jira 已更新，但 Panel 重新同步失败，请手动同步",
                        )
                    })?;
                }
                return Err(error);
            }
        };
        if current["source"] != "jira" && task["status"] == "done" {
            task = super::claims::cleanup_completed(state, task).await?;
        }
        state.emit("task.updated", json!({"task":task}));
        return Ok(json_response(200, json!({"task":task})));
    }
    if m == "DELETE" {
        let current = current_task(state, id)?;
        if current["source"] == "jira" {
            return Err(ApiError::new(
                409,
                "JIRA_DELETE_UNAVAILABLE",
                "Jira 任务不能从 Panel 永久删除",
            ));
        }
        let body = json_body(headers, bytes)?;
        v::allowed(
            &body,
            &["version", "threadId", "threadBinding", "agentSession"],
        )?;
        let deleted = state.db(
            "deleteArchivedTask",
            &[json!(id), v::version(body.get("version"))?],
        )?;
        if let Some(ids) = deleted["attachmentIds"].as_array() {
            for id in ids {
                if let Some(id) = id.as_str() {
                    remove_file(&state.config.data_dir.join("attachments").join(id)).await?;
                }
            }
        }
        state.emit("task.deleted", json!({"task":deleted["task"]}));
        return Ok(empty_response(204));
    }
    Ok(methods(&["GET", "PATCH", "DELETE"]))
}

async fn task_action(
    state: &AppState,
    m: &str,
    id: &str,
    action: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    no_query(raw)?;
    if m != "POST" {
        return Ok(methods(&["POST"]));
    }
    let body = json_body(headers, bytes)?;
    if action == "bind-thread" {
        v::allowed(&body, &["threadId", "replaceThreadId"])?;
        let thread = v::required_string(body.get("threadId"), "threadId", 256)?;
        let mut input = json!({"threadId":thread});
        resolve_attribution(state, &mut input)?;
        if input.get("threadBinding").is_none() {
            if let Some(binding) = super::session::binding(state, &thread).await? {
                input["threadBinding"] = binding;
            }
        }
        let binding = input
            .get("threadBinding")
            .filter(|binding| binding["codexProjectId"].is_string())
            .ok_or_else(|| {
                ApiError::new(
                    409,
                    "THREAD_BINDING_IDENTITY_UNAVAILABLE",
                    "当前 Codex 会话没有完整的项目、主机和工作区身份，无法绑定议题",
                )
            })?;
        let current = task(state, id)?;
        if !current["archivedAt"].is_null() {
            return Err(ApiError::new(
                409,
                "TASK_ARCHIVED",
                "Archived tasks cannot bind a conversation",
            ));
        }
        let existing = current
            .pointer("/threadBinding/threadId")
            .filter(|v| v.is_string())
            .or_else(|| current.get("legacyLocalThreadId"))
            .cloned()
            .unwrap_or(Value::Null);
        let replacement = body.get("replaceThreadId");
        if replacement.is_some_and(|r| *r != existing)
            || (replacement.is_none() && existing.is_string() && existing != json!(thread))
        {
            return Err(ApiError::new(409,"TASK_THREAD_BINDING_CONFLICT","该议题的会话绑定与预期不符；请重读任务，用户明确要求接手后使用 --replace-thread-id 指定当前绑定").with_details(json!({"existingThreadId":existing})));
        }
        if current["source"] == "jira"
            && state.db("getJiraPlan", &[current["id"].clone()])?.is_null()
        {
            let context = state.db("getJiraContext", &[current["id"].clone()])?;
            let project = if context["projects"].as_array().is_some_and(|p| p.len() > 1) {
                binding["codexProjectId"].as_str()
            } else {
                None
            };
            let reuse = context["planningThreads"]
                .as_array()
                .is_some_and(|threads| threads.iter().any(|t| t["id"] == thread));
            super::planning::start(
                state,
                current["id"].as_str().unwrap_or(id),
                current["version"].clone(),
                Some(&thread),
                project,
                reuse,
            )
            .await?;
        }
        let task = state.db(
            "updateTask",
            &[
                current["id"].clone(),
                current["version"].clone(),
                json!({}),
                json!(thread),
                binding.clone(),
                v::actor(headers)?,
                Value::Null,
                json!(replacement.is_some()),
            ],
        )?;
        state.emit("task.updated", json!({"task":task}));
        return Ok(json_response(200, json!({"task":task})));
    }
    let mut allowed = vec!["version", "threadId", "threadBinding", "agentSession"];
    if action == "move" {
        allowed.extend(["status", "sortOrder"]);
    }
    v::allowed(&body, &allowed)?;
    let mut input = v::attribution(&body)?;
    resolve_attribution(state, &mut input)?;
    let current = current_task(state, id)?;
    if current["source"] == "jira" {
        if action == "move" {
            if current["version"] != body["version"] {
                return Err(ApiError::new(
                    409,
                    "VERSION_CONFLICT",
                    "Task changed since it was last read",
                ));
            }
            if !current["archivedAt"].is_null() {
                return Err(ApiError::new(
                    409,
                    "TASK_ARCHIVED",
                    "Archived tasks cannot be moved",
                ));
            }
            let status = v::status(body.get("status"), None)?;
            super::jira::move_task(state, &current, status.as_str().unwrap()).await?;
        } else {
            return Err(ApiError::new(
                409,
                if action == "archive" {
                    "JIRA_ARCHIVE_UNAVAILABLE"
                } else {
                    "JIRA_RESTORE_UNAVAILABLE"
                },
                "Jira 任务由同步范围自动管理，不能手动归档或恢复",
            ));
        }
    }
    let mut args = vec![json!(id), v::version(body.get("version"))?];
    if action == "move" {
        args.push(v::status(body.get("status"), None)?);
        args.push(
            body.get("sortOrder")
                .map(v::sort_order)
                .transpose()?
                .unwrap_or(Value::Null),
        );
    }
    args.extend([
        argument(&input, "threadId"),
        argument(&input, "threadBinding"),
        v::actor(headers)?,
        argument(&input, "agentSession"),
    ]);
    let mutated = state.db(
        match action {
            "move" => "moveTask",
            "archive" => "archiveTask",
            _ => "restoreTask",
        },
        &args,
    );
    let mut task = match mutated {
        Ok(task) => task,
        Err(error) => {
            if current["source"] == "jira" && action == "move" {
                super::jira::reconcile(state).await.map_err(|_| {
                    ApiError::new(
                        502,
                        "JIRA_RECONCILE_FAILED",
                        "Jira 已更新，但 Panel 重新同步失败，请手动同步",
                    )
                })?;
            }
            return Err(error);
        }
    };
    if current["source"] != "jira" && task["status"] == "done" {
        task = super::claims::cleanup_completed(state, task).await?;
    }
    state.emit(
        match action {
            "move" => "task.moved",
            "archive" => "task.archived",
            _ => "task.restored",
        },
        json!({"task":task}),
    );
    Ok(json_response(200, json!({"task":task})))
}

async fn comments(
    state: &AppState,
    m: &str,
    id: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    let task = task(state, id)?;
    if m == "GET" {
        let after = after_cursor(raw)?;
        let comments = if let Some(after) = after {
            state.db(
                "listCommentsAfter",
                &[
                    task["id"].clone(),
                    json!({"value":after.to_string(),"revision":after}),
                ],
            )?
        } else {
            state.db("listComments", &[task["id"].clone()])?
        };
        let cursor = comments
            .as_array()
            .map(|comments| {
                comments
                    .iter()
                    .filter_map(|comment| comment["changeRevision"].as_u64())
                    .max()
                    .unwrap_or(after.unwrap_or(0))
            })
            .unwrap_or(after.unwrap_or(0));
        return Ok(json_response(
            200,
            json!({"comments":comments,"nextCursor":cursor.to_string()}),
        ));
    }
    if m != "POST" {
        return Ok(methods(&["GET", "POST"]));
    }
    no_query(raw)?;
    let body = json_body(headers, bytes)?;
    v::allowed(
        &body,
        &["body", "threadId", "threadBinding", "agentSession"],
    )?;
    let mut input = v::attribution(&body)?;
    resolve_attribution(state, &mut input)?;
    input["body"] =
        v::string(body.get("body"), "body", false, false, 100_000)?.unwrap_or_else(|| json!(""));
    input["actor"] = v::actor(headers)?;
    let comment = state.db("createComment", &[task["id"].clone(), input])?;
    state.emit(
        "comment.created",
        json!({"comment":comment,"task":state.db("getTask",&[task["id"].clone()])?}),
    );
    if comment["authorType"] == "user" {
        super::claims::resume_comment(state, task["id"].as_str().unwrap_or(id))?;
    }
    Ok(json_response(201, json!({"comment":comment})))
}

fn comment_route(
    state: &AppState,
    m: &str,
    id: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    no_query(raw)?;
    let body = json_body(headers, bytes)?;
    if m == "PATCH" {
        v::allowed(
            &body,
            &[
                "version",
                "body",
                "threadId",
                "threadBinding",
                "agentSession",
            ],
        )?;
        if body.get("body").is_none() {
            return Err(v::invalid("'body' is required"));
        }
        let text = v::string(body.get("body"), "body", false, false, 100_000)?.unwrap();
        let mut attribution = v::attribution(&body)?;
        resolve_attribution(state, &mut attribution)?;
        let comment = state.db(
            "updateComment",
            &[
                json!(id),
                v::version(body.get("version"))?,
                text,
                argument(&attribution, "threadId"),
                argument(&attribution, "threadBinding"),
                argument(&attribution, "agentSession"),
            ],
        )?;
        state.emit("comment.updated", json!({"comment":comment}));
        return Ok(json_response(200, json!({"comment":comment})));
    }
    if m == "DELETE" {
        v::allowed(
            &body,
            &["version", "threadId", "threadBinding", "agentSession"],
        )?;
        let comment = state.db("getComment", &[json!(id)])?;
        state.db(
            "deleteComment",
            &[json!(id), v::version(body.get("version"))?],
        )?;
        state.emit("comment.deleted", json!({"comment":comment}));
        return Ok(empty_response(204));
    }
    Ok(methods(&["PATCH", "DELETE"]))
}

fn after_cursor(raw: Option<&str>) -> Result<Option<u64>, ApiError> {
    let query = v::query(raw, &["after"])?;
    query
        .get("after")
        .map(|s| {
            s.parse::<u64>()
                .ok()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    ApiError::new(
                        400,
                        "INVALID_CURSOR",
                        "Cursor must be a non-negative integer revision",
                    )
                })
        })
        .transpose()
}

async fn attachments(
    state: &AppState,
    m: &str,
    id: &str,
    comment: bool,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    let owner = if comment {
        let value = state.db("getComment", &[json!(id)])?;
        if value.is_null() {
            return Err(missing("Comment", id));
        }
        value
    } else {
        task(state, id)?
    };
    if m == "GET" {
        let after = after_cursor(raw)?;
        let entries = state.db(
            if comment {
                "listCommentAttachments"
            } else {
                "listAttachments"
            },
            &[
                owner["id"].clone(),
                after.map_or(Value::Null, |v| json!({"value":v.to_string(),"revision":v})),
            ],
        )?;
        let cursor = entries
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|e| e["changeRevision"].as_u64())
                    .max()
                    .unwrap_or(after.unwrap_or(0))
            })
            .unwrap_or(0);
        return Ok(json_response(
            200,
            json!({"attachments":entries,"nextCursor":cursor.to_string()}),
        ));
    }
    if m != "POST" {
        return Ok(methods(&["GET", "POST"]));
    }
    no_query(raw)?;
    upload(
        state,
        owner["id"].as_str().unwrap_or(id),
        if comment {
            "createCommentAttachment"
        } else {
            "createAttachment"
        },
        v::attachment(headers)?,
        bytes,
    )
    .await
}

async fn upload(
    state: &AppState,
    owner: &str,
    method: &str,
    mut metadata: Value,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    let id = uuid::Uuid::new_v4().to_string();
    let directory = state.config.data_dir.join("attachments");
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join(&id);
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await?;
    if let Err(error) = file.write_all(bytes).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error.into());
    }
    file.sync_all().await?;
    drop(file);
    metadata["id"] = json!(id);
    metadata["size"] = json!(bytes.len());
    let attachment = match state.db(method, &[json!(owner), metadata]) {
        Ok(value) => value,
        Err(error) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
    };
    state.emit("attachment.created", json!({"attachment":attachment}));
    Ok(json_response(201, json!({"attachment":attachment})))
}

async fn attachment_content(
    state: &AppState,
    m: &str,
    id: &str,
    action: &str,
    raw: Option<&str>,
) -> Result<Response, ApiError> {
    no_query(raw)?;
    if !["GET", "HEAD"].contains(&m) {
        return Ok(methods(&["GET", "HEAD"]));
    }
    let mut attachment = state.db("getAttachment", &[json!(id)])?;
    if attachment.is_null() {
        attachment = state.db("getProjectReadmeAttachment", &[json!(id)])?;
    }
    if attachment.is_null() {
        return Err(missing("Attachment", id));
    }
    let filename = attachment["id"].as_str().ok_or_else(|| {
        ApiError::new(
            500,
            "INVALID_ATTACHMENT",
            "Attachment identifier is missing",
        )
    })?;
    if filename.contains(['/', '\\']) || filename == ".." {
        return Err(ApiError::new(
            500,
            "INVALID_ATTACHMENT",
            "Attachment identifier is invalid",
        ));
    }
    let bytes = tokio::fs::read(state.config.data_dir.join("attachments").join(filename)).await?;
    let content_type = attachment["contentType"]
        .as_str()
        .unwrap_or("application/octet-stream");
    let inline = action == "content"
        && ([
            "application/pdf",
            "image/avif",
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/webp",
            "text/plain",
        ]
        .contains(&content_type)
            || content_type.starts_with("video/"));
    let encoded = url::form_urlencoded::byte_serialize(
        attachment["filename"]
            .as_str()
            .unwrap_or("download")
            .as_bytes(),
    )
    .collect::<String>();
    let mut response = Response::builder()
        .status(200)
        .header("cache-control", "private, no-store")
        .header("content-security-policy", "sandbox; default-src 'none'")
        .header(
            "content-type",
            if inline {
                content_type
            } else {
                "application/octet-stream"
            },
        )
        .header("content-length", bytes.len())
        .header(
            "content-disposition",
            format!(
                "{}; filename*=UTF-8''{encoded}",
                if inline { "inline" } else { "attachment" }
            ),
        )
        .body(if m == "HEAD" {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .map_err(|e| ApiError::new(500, "INVALID_RESPONSE", e.to_string()))?;
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    Ok(response)
}

async fn remove_file(path: &Path) -> Result<(), ApiError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
async fn delete_attachment(
    state: &AppState,
    m: &str,
    id: &str,
    raw: Option<&str>,
) -> Result<Response, ApiError> {
    no_query(raw)?;
    if m != "DELETE" {
        return Ok(methods(&["DELETE"]));
    }
    let attachment = state.db("getAttachment", &[json!(id)])?;
    if attachment.is_null() {
        return Err(missing("Attachment", id));
    }
    let storage_id = attachment["id"].as_str().ok_or_else(|| {
        ApiError::new(
            500,
            "INVALID_ATTACHMENT",
            "Attachment identifier is missing",
        )
    })?;
    if storage_id.contains(['/', '\\']) || storage_id == ".." {
        return Err(ApiError::new(
            500,
            "INVALID_ATTACHMENT",
            "Attachment identifier is invalid",
        ));
    }
    remove_file(&state.config.data_dir.join("attachments").join(storage_id)).await?;
    state.db("deleteAttachment", &[json!(id)])?;
    state.emit("attachment.deleted", json!({"attachment":attachment}));
    Ok(empty_response(204))
}

fn workflow_settings(
    state: &AppState,
    m: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    no_query(raw)?;
    if m == "GET" {
        return Ok(json_response(
            200,
            json!({"settings":state.db("getWorkflowSettings",&[])?}),
        ));
    }
    if m != "PUT" {
        return Ok(methods(&["GET", "PUT"]));
    }
    let body = json_body(headers, bytes)?;
    v::allowed(
        &body,
        &["planning", "execution", "review", "handoff", "prompts"],
    )?;
    for stage in v::STAGES {
        let skills = body[*stage]
            .as_array()
            .filter(|v| v.len() <= 20)
            .ok_or_else(|| {
                v::invalid(format!(
                    "'{stage}' must contain up to 20 unique workflow Skill IDs"
                ))
            })?;
        let mut seen = std::collections::HashSet::new();
        for skill in skills {
            let id = skill.as_str().unwrap_or("");
            if id.len() > 256
                || ["manage-panel", "handoff-panel"].contains(&id)
                || !regex::Regex::new(r"(?i)^[a-z0-9_-]+(?::[a-z0-9_-]+)?$")
                    .unwrap()
                    .is_match(id)
                || !seen.insert(id)
            {
                return Err(v::invalid(format!(
                    "'{stage}' must contain up to 20 unique workflow Skill IDs"
                )));
            }
        }
    }
    if let Some(prompts) = body.get("prompts") {
        let prompts = v::object(prompts)?;
        if prompts.iter().any(|(stage, prompt)| {
            !v::STAGES.contains(&stage.as_str())
                || prompt
                    .as_str()
                    .map_or(true, |s| s.encode_utf16().count() > 4000)
        }) {
            return Err(v::invalid(
                "'prompts' must contain workflow stage prompt strings",
            ));
        }
    }
    let combined = body["execution"]
        .as_array()
        .unwrap()
        .iter()
        .chain(body["review"].as_array().unwrap())
        .filter_map(Value::as_str)
        .collect::<std::collections::HashSet<_>>();
    if combined.len() > 20 {
        return Err(v::invalid(
            "Execution and review together support up to 20 unique Skills",
        ));
    }
    Ok(json_response(
        200,
        json!({"settings":state.db("saveWorkflowSettings",&[body])?}),
    ))
}

async fn client_storage(
    state: &AppState,
    method: &Method,
    headers: &HeaderMap,
    bytes: &[u8],
    cloud: &Value,
) -> Result<Response, ApiError> {
    let filename = state.config.data_dir.join("client-storage.json");
    let _guard = state.store_write.lock().await;
    let mut entries = store::read(&filename, json!({})).await?;
    if !entries.is_object() {
        entries = json!({});
    }
    if method == Method::GET {
        if cloud["remoteUrl"].is_string() {
            let upstream = cloud_forward(
                state,
                method,
                "/api/client-storage",
                None,
                headers,
                bytes,
                cloud,
            )
            .await?;
            let status = upstream.status();
            let body = axum::body::to_bytes(upstream.into_body(), 1024 * 1024)
                .await
                .map_err(|e| ApiError::new(502, "INVALID_CLOUD_RESPONSE", e.to_string()))?;
            if !status.is_success() {
                let mut response = Response::new(Body::from(body));
                *response.status_mut() = status;
                response
                    .headers_mut()
                    .insert("content-type", "application/json".parse().unwrap());
                return Ok(response);
            }
            let shared: Value = serde_json::from_slice(&body)?;
            let prefix = "taskboard.project-board-display-settings.v3.";
            entries
                .as_object_mut()
                .unwrap()
                .retain(|key, _| !key.starts_with(prefix));
            if let Some(shared) = shared["entries"].as_object() {
                for (key, value) in shared {
                    if key.starts_with(prefix) {
                        entries[key] = value.clone();
                    }
                }
            }
        }
        return Ok(json_response(200, json!({"entries":entries})));
    }
    if method != Method::PATCH {
        return Ok(methods(&["GET", "PATCH"]));
    }
    let body = json_body(headers, bytes)?;
    v::allowed(&body, &["key", "value"])?;
    let key = v::required_string(body.get("key"), "key", 512)?;
    let value = v::string(body.get("value"), "value", false, true, 100_000)?
        .ok_or_else(|| v::invalid("'value' is required"))?;
    if cloud["remoteUrl"].is_string()
        && key.starts_with("taskboard.project-board-display-settings.v3.")
    {
        return cloud_forward(
            state,
            method,
            "/api/client-storage",
            None,
            headers,
            bytes,
            cloud,
        )
        .await;
    }
    if value.is_null() {
        entries.as_object_mut().unwrap().remove(&key);
    } else {
        entries[&key] = value;
    }
    store::write(&filename, &entries).await?;
    if key.starts_with("taskboard.project-board-display-settings.v3.") {
        state.emit("client-storage.updated", json!({"key":key}));
    }
    Ok(empty_response(204))
}

fn host_runtime(
    state: &AppState,
    m: &str,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<Response, ApiError> {
    let now = chrono::Utc::now().timestamp_millis();
    if m == "GET" {
        let runtime = state
            .host_runtime
            .lock()
            .map_err(|_| ApiError::new(500, "RUNTIME_LOCK", "Runtime lock was poisoned"))?;
        let value = runtime
            .as_ref()
            .filter(|value| now - value["updatedAt"].as_i64().unwrap_or(0) <= 3000)
            .cloned()
            .unwrap_or(Value::Null);
        return Ok(json_response(200, json!({"runtime":value})));
    }
    if m != "PUT" {
        return Ok(methods(&["GET", "PUT"]));
    }
    let body = json_body(headers, bytes)?;
    v::allowed(
        &body,
        &[
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
        ],
    )?;
    let thread = v::required_string(body.get("threadId"), "threadId", 256)?;
    if !body["threadRunning"].is_boolean() {
        return Err(v::invalid("'threadRunning' must be a boolean"));
    }
    let mut runtime = json!({"threadId":thread,"threadRunning":body["threadRunning"],"threadTodoProgress":null,"updatedAt":now});
    if let Some(progress) = body.get("threadTodoProgress").filter(|v| !v.is_null()) {
        v::allowed(progress, &["completed", "total"])?;
        let completed = progress["completed"]
            .as_u64()
            .ok_or_else(|| v::invalid("'threadTodoProgress' is invalid"))?;
        let total = progress["total"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| v::invalid("'threadTodoProgress' is invalid"))?;
        runtime["threadTodoProgress"] = json!({"completed":completed.min(total),"total":total});
    }
    for key in ["codexProjectId", "codexHostId", "workspacePath"] {
        runtime[key] = v::string(
            body.get(key),
            key,
            false,
            true,
            if key == "workspacePath" { 4096 } else { 256 },
        )?
        .unwrap_or(Value::Null);
    }
    runtime["codexProjectKind"] =
        if ["local", "remote"].contains(&body["codexProjectKind"].as_str().unwrap_or("")) {
            body["codexProjectKind"].clone()
        } else {
            Value::Null
        };
    *state
        .host_runtime
        .lock()
        .map_err(|_| ApiError::new(500, "RUNTIME_LOCK", "Runtime lock was poisoned"))? =
        Some(runtime.clone());
    Ok(json_response(200, json!({"runtime":runtime})))
}

pub(super) async fn device_workspaces(state: &AppState) -> Result<Value, ApiError> {
    let path = state.config.codex_home.join(".codex-global-state.json");
    let value = store::read(&path, json!({})).await?;
    let mut workspaces = json!({});
    async fn existing_directory(value: &Value) -> Option<std::path::PathBuf> {
        let path = Path::new(value.as_str()?.trim());
        if !path.is_absolute() {
            return None;
        }
        let path = tokio::fs::canonicalize(path).await.ok()?;
        if path.is_dir() {
            Some(path)
        } else {
            None
        }
    }
    if let Some(projects) = value["local-projects"].as_object() {
        for (id, project) in projects {
            // Codex 可能保留失效的旧路径，应继续查找同项目下仍存在的目录。
            for root in project["rootPaths"].as_array().into_iter().flatten() {
                if let Some(root) = existing_directory(root).await {
                    workspaces[id] = json!(root);
                    break;
                }
            }
        }
    }
    for project in state
        .db("listProjects", &[])?
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(id) = project["id"].as_str() {
            if workspaces.get(id).is_none() {
                if let Some(root) = existing_directory(&project["workspacePath"]).await {
                    workspaces[id] = json!(root);
                }
            }
        }
    }
    Ok(workspaces)
}

pub(super) async fn workflow(
    state: &AppState,
    project_id: &str,
    stage: &str,
) -> Result<Value, ApiError> {
    let settings = state.db("getWorkflowSettings", &[])?;
    let defaults: Value =
        serde_json::from_str(include_str!("../../../shared/workflow-prompts.json"))?;
    let definition = &defaults[stage];
    let ids = settings[stage].as_array().cloned().unwrap_or_default();
    let available = if ids.is_empty() {
        json!({"skills":[]})
    } else {
        let context = super::ai::context(state, project_id, None, None).await?;
        super::ai::catalog(state, &context).await?
    };
    let skills = available["skills"].as_array().cloned().unwrap_or_default();
    let missing = ids
        .iter()
        .filter(|id| !skills.iter().any(|skill| skill["id"] == **id))
        .cloned()
        .collect::<Vec<_>>();
    let selected = if missing.is_empty() {
        ids.iter()
            .filter_map(|id| skills.iter().find(|skill| skill["id"] == *id))
            .map(|skill| json!({"id":skill["id"],"label":skill["label"],"path":skill["path"]}))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let method = if selected.is_empty() {
        definition["defaultMethod"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    } else {
        format!(
            "按顺序使用已选择的 Skill：{}。",
            selected
                .iter()
                .filter_map(|skill| skill["id"].as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        )
    };
    let prompt = settings
        .pointer(&format!("/prompts/{stage}"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| definition["prompt"].as_str())
        .unwrap_or("");
    Ok(
        json!({"appliesWhen":definition["appliesWhen"],"skills":selected,"missing":missing,"mode":if selected.is_empty(){"default"}else{"custom"},"prompt":prompt.replace("{{skill_instructions}}",&method),"rules":definition["rules"]}),
    )
}

async fn scan_contexts(workspace: Option<&str>) -> Result<Value, ApiError> {
    let Some(workspace) = workspace else {
        return Ok(json!({"workspacePath":null,"contexts":[]}));
    };
    if workspace.contains('\0') {
        return Err(v::invalid("'workspacePath' cannot contain null bytes"));
    }
    async fn git(workspace: &str, args: &[&str]) -> Option<String> {
        let mut command = tokio::process::Command::new("git");
        command
            .arg("-C")
            .arg(workspace)
            .args(args)
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
        let output = tokio::time::timeout(std::time::Duration::from_secs(4), command.output())
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }
    let Some(root) = git(workspace, &["rev-parse", "--show-toplevel"]).await else {
        return Ok(json!({"workspacePath":workspace,"contexts":[]}));
    };
    let root = root.trim();
    let (branches, trees) = tokio::join!(
        git(
            root,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"]
        ),
        git(root, &["worktree", "list", "--porcelain"])
    );
    let mut contexts = Vec::new();
    if let Some(branches) = branches {
        for branch in branches.lines().map(str::trim).filter(|s| !s.is_empty()) {
            contexts.push(json!({"type":"branch","branch":branch}));
        }
    }
    if let Some(trees) = trees {
        for block in trees.split("\n\n") {
            let path = block
                .lines()
                .find_map(|line| line.strip_prefix("worktree "));
            if block.lines().any(|line| line.starts_with("prunable")) {
                continue;
            }
            if let Some(path) = path.filter(|path| Path::new(path).exists()) {
                let branch = block
                    .lines()
                    .find_map(|line| line.strip_prefix("branch refs/heads/"));
                contexts.push(json!({"type":"worktree","path":path,"branch":branch}));
            }
        }
    }
    Ok(json!({"workspacePath":root,"contexts":contexts}))
}

fn local_companion(path: &str) -> bool {
    [
        "/health",
        "/api/meta",
        "/api/device-workspaces",
        "/api/local/cloud-session",
    ]
    .contains(&path)
        || path.starts_with("/api/local/")
        || (path.starts_with("/api/projects/") && path.ends_with("/development-contexts"))
}

pub(super) async fn cloud_websocket(
    state: &Arc<AppState>,
    upgrade: axum::extract::WebSocketUpgrade,
) -> Result<Response, ApiError> {
    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let cloud = store::read(
        &state.config.data_dir.join("cloud-companion.json"),
        store::empty_cloud(),
    )
    .await?;
    if !cloud["remoteUrl"].is_string()
        || !cloud["actorName"].is_string()
        || !cloud["sharedKey"].is_string()
    {
        return Err(ApiError::new(
            409,
            "CLOUD_NOT_CONFIGURED",
            "Cloud collaboration is not configured",
        ));
    }
    let origin = store::cloud_url(&cloud["remoteUrl"])?;
    let mut url = url::Url::parse(&format!("{origin}/api/events"))
        .map_err(|e| ApiError::new(500, "INVALID_CLOUD_CONFIG", e.to_string()))?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| ApiError::new(500, "INVALID_CLOUD_CONFIG", "Invalid cloud protocol"))?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| ApiError::new(502, "REMOTE_UNAVAILABLE", e.to_string()))?;
    let auth = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        cloud["actorName"].as_str().unwrap(),
        cloud["sharedKey"].as_str().unwrap()
    ));
    request.headers_mut().insert(
        "authorization",
        format!("Basic {auth}")
            .parse()
            .map_err(|_| ApiError::new(500, "INVALID_CLOUD_CONFIG", "Invalid cloud credentials"))?,
    );
    let (remote, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|_| {
            ApiError::new(
                502,
                "REMOTE_UNAVAILABLE",
                "Cloud realtime connection failed",
            )
        })?;
    Ok(upgrade.on_upgrade(move |local|async move{
        let(mut output,mut input)=local.split();let(mut remote_output,mut remote_input)=remote.split();
        loop{
            tokio::select!{
                message=remote_input.next()=>{
                    let Some(Ok(message))=message else{let _=output.send(axum::extract::ws::Message::Close(Some(axum::extract::ws::CloseFrame{code:1011,reason:"Cloud realtime connection failed".into()}))).await;break};
                    let message=match message{
                        Message::Text(value)=>axum::extract::ws::Message::Text(value.to_string().into()),
                        Message::Binary(value)=>axum::extract::ws::Message::Binary(value),
                        Message::Ping(value)=>axum::extract::ws::Message::Ping(value),
                        Message::Pong(value)=>axum::extract::ws::Message::Pong(value),
                        Message::Close(frame)=>{let _=output.send(axum::extract::ws::Message::Close(frame.map(|frame|axum::extract::ws::CloseFrame{code:frame.code.into(),reason:frame.reason.to_string().into()}))).await;break},
                        Message::Frame(_)=>continue,
                    };if output.send(message).await.is_err(){break;}
                }
                message=input.next()=>{
                    match message{
                        Some(Ok(axum::extract::ws::Message::Close(_)))|None|Some(Err(_))=>break,
                        Some(Ok(axum::extract::ws::Message::Pong(_)))=>{},
                        Some(Ok(axum::extract::ws::Message::Ping(value)))=>{let _=output.send(axum::extract::ws::Message::Pong(value)).await;},
                        _=>{let _=output.send(axum::extract::ws::Message::Close(Some(axum::extract::ws::CloseFrame{code:1008,reason:"Client messages are not supported".into()}))).await;break;}
                    }
                }
            }
        }
        let _=remote_output.close().await;
    }))
}

async fn cloud_forward(
    state: &AppState,
    method: &Method,
    path: &str,
    raw: Option<&str>,
    headers: &HeaderMap,
    bytes: &[u8],
    cloud: &Value,
) -> Result<Response, ApiError> {
    let origin = store::cloud_url(&cloud["remoteUrl"])?;
    let mut url = url::Url::parse(&origin)
        .map_err(|e| ApiError::new(500, "INVALID_CLOUD_CONFIG", e.to_string()))?;
    url.set_path(path);
    url.set_query(raw);
    let mut request = state.client.request(method.clone(), url).basic_auth(
        cloud["actorName"].as_str().unwrap_or(""),
        cloud["sharedKey"].as_str(),
    );
    for (name, value) in headers {
        if [
            "authorization",
            "host",
            "connection",
            "transfer-encoding",
            "accept-encoding",
            "content-length",
        ]
        .contains(&name.as_str())
            || name.as_str().starts_with("x-panel-user-")
            || name.as_str().starts_with("x-taskboard-user-")
        {
            continue;
        }
        request = request.header(name, value);
    }
    let mut payload = bytes.to_vec();
    let mut mapping = None;
    if security::header(headers, "content-type").is_some_and(|s| s.contains("application/json"))
        && !bytes.is_empty()
    {
        let mut value: Value = serde_json::from_slice(bytes)?;
        v::object(&value)?;
        if method == Method::PATCH && path.starts_with("/api/tasks/") && !path[11..].contains('/') {
            if let Some(project) = value.get("projectId") {
                let id = v::decode(&path[11..])?;
                if state.db(
                    "hasAiChatThreadProjectConflict",
                    &[json!(id), project.clone()],
                )? == true
                {
                    return Err(ApiError::new(409,"AI_CHAT_PROJECT_MOVE_BLOCKED","Delete issue-linked AI conversations before moving the issue to another project"));
                }
            }
        }
        if method == Method::POST && path == "/api/projects" {
            if let Some(workspace) = value["workspacePath"].as_str() {
                if !Path::new(workspace).is_absolute() {
                    return Err(ApiError::new(
                        400,
                        "INVALID_PROJECT_MAPPING",
                        "Project workspacePath must be absolute",
                    ));
                }
                mapping = Some((
                    value["id"].as_str().map(str::to_owned),
                    workspace.to_owned(),
                ));
            }
            value.as_object_mut().unwrap().remove("workspacePath");
        }
        if (method == Method::POST && path == "/api/tasks")
            || (method == Method::PATCH
                && path.starts_with("/api/tasks/")
                && !path[11..].contains('/'))
        {
            if value
                .pointer("/developmentContext/type")
                .and_then(Value::as_str)
                == Some("worktree")
            {
                value["developmentContext"]
                    .as_object_mut()
                    .unwrap()
                    .remove("path");
            }
        }
        if method != Method::GET
            && (path.starts_with("/api/tasks") || path.starts_with("/api/comments/"))
        {
            resolve_attribution(state, &mut value)?;
        }
        payload = serde_json::to_vec(&value)?;
    }
    if method != Method::GET && method != Method::HEAD {
        request = request.body(payload);
    }
    let upstream = request.send().await.map_err(|e| {
        ApiError::new(
            502,
            "REMOTE_UNAVAILABLE",
            format!("Cannot reach cloud panel at {origin}"),
        )
        .with_details(json!(e.to_string()))
    })?;
    let status = upstream.status();
    let source_headers = upstream.headers().clone();
    let json = source_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    let body = if json && status != StatusCode::UNAUTHORIZED {
        let mut payload: Value = upstream.json().await?;
        let mut config = cloud.clone();
        if status.is_success() {
            if let Some((project, workspace)) = mapping {
                if let Some(id) = project.or_else(|| {
                    payload
                        .pointer("/project/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                }) {
                    let _guard = state.store_write.lock().await;
                    config = store::read(
                        &state.config.data_dir.join("cloud-companion.json"),
                        store::empty_cloud(),
                    )
                    .await?;
                    config["projectMappings"][id] = json!(workspace);
                    store::write(&state.config.data_dir.join("cloud-companion.json"), &config)
                        .await?;
                }
            }
        }
        if let Some(projects) = payload["projects"].as_array_mut() {
            for project in projects {
                localize_project(project, &config);
            }
        }
        if payload["project"].is_object() {
            localize_project(&mut payload["project"], &config);
        }
        if let Some(tasks) = payload["tasks"].as_array_mut() {
            for task in tasks {
                localize_task(task, &config).await?;
            }
        }
        if payload["task"].is_object() {
            localize_task(&mut payload["task"], &config).await?;
        }
        Body::from(serde_json::to_vec(&payload)?)
    } else {
        // 附件和事件流不需要改写正文，持续转发可避免等待整个响应并占满内存。
        Body::from_stream(upstream.bytes_stream())
    };
    let mut response = Response::builder().status(status);
    for (name, value) in &source_headers {
        if ![
            "connection",
            "content-encoding",
            "content-length",
            "transfer-encoding",
        ]
        .contains(&name.as_str())
        {
            response = response.header(name, value);
        }
    }
    response
        .body(body)
        .map_err(|e| ApiError::new(500, "INVALID_RESPONSE", e.to_string()))
}

fn localize_project(project: &mut Value, cloud: &Value) {
    let id = project["id"].as_str().unwrap_or("");
    project["workspacePath"] = if id == "local" {
        Value::Null
    } else {
        cloud["projectMappings"]
            .get(id)
            .cloned()
            .unwrap_or(Value::Null)
    };
}
async fn localize_task(task: &mut Value, cloud: &Value) -> Result<(), ApiError> {
    if task
        .pointer("/developmentContext/type")
        .and_then(Value::as_str)
        == Some("worktree")
    {
        let project = task["projectId"].as_str().unwrap_or("");
        let branch = task["developmentContext"]["branch"].clone();
        let contexts = scan_contexts(cloud["projectMappings"][project].as_str()).await?;
        let path = contexts["contexts"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry["type"] == "worktree" && entry["branch"] == branch)
            })
            .map(|entry| entry["path"].clone())
            .unwrap_or(Value::Null);
        task["developmentContext"]["path"] = path;
    }
    Ok(())
}

async fn static_file(state: &AppState, method: &Method, path: &str) -> Result<Response, ApiError> {
    if method != Method::GET && method != Method::HEAD {
        return Err(ApiError::new(404, "NOT_FOUND", "Route not found"));
    }
    let decoded = v::decode(path)?;
    let relative = Path::new(decoded.trim_start_matches('/'));
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(ApiError::new(
            403,
            "INVALID_PATH",
            "Static path escapes the content directory",
        ));
    }
    let root = tokio::fs::canonicalize(&state.config.static_dir).await?;
    let requested = root.join(relative);
    let file = match tokio::fs::canonicalize(&requested).await {
        Ok(file) if file.is_file() => file,
        Ok(_) => root.join("index.html"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => root.join("index.html"),
        Err(error) => return Err(error.into()),
    };
    if !file.starts_with(&root) {
        return Err(ApiError::new(
            403,
            "INVALID_PATH",
            "Static path escapes the content directory",
        ));
    }
    let bytes = tokio::fs::read(&file).await?;
    let mime = match file.extension().and_then(|v| v.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("content-length", bytes.len())
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .map_err(|e| ApiError::new(500, "INVALID_RESPONSE", e.to_string()))
}
