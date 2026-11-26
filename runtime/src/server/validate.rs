use super::security::header;
use crate::ApiError;
use axum::http::HeaderMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const STATUSES: &[&str] = &[
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
];
pub const STAGES: &[&str] = &["planning", "execution", "review", "handoff"];
pub const JIRA_PROJECT: &str = "jira-my-tasks";

pub fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "INVALID_FIELD", message)
}
pub fn object(value: &Value) -> Result<&Map<String, Value>, ApiError> {
    value
        .as_object()
        .ok_or_else(|| ApiError::new(400, "INVALID_BODY", "Request body must be a JSON object"))
}
pub fn allowed(value: &Value, fields: &[&str]) -> Result<(), ApiError> {
    let unknown: Vec<_> = object(value)?
        .keys()
        .filter(|key| !fields.contains(&key.as_str()))
        .cloned()
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(ApiError::new(
            400,
            "UNKNOWN_FIELD",
            format!(
                "Unknown field{}: {}",
                if unknown.len() == 1 { "" } else { "s" },
                unknown.join(", ")
            ),
        ))
    }
}
pub fn string(
    value: Option<&Value>,
    name: &str,
    required: bool,
    nullable: bool,
    max: usize,
) -> Result<Option<Value>, ApiError> {
    let Some(value) = value else {
        return if required {
            Err(invalid(format!("'{name}' is required")))
        } else {
            Ok(None)
        };
    };
    if value.is_null() && nullable {
        return Ok(Some(Value::Null));
    }
    let value = value
        .as_str()
        .ok_or_else(|| {
            invalid(format!(
                "'{name}' must be a string{}",
                if nullable { " or null" } else { "" }
            ))
        })?
        .trim();
    if required && value.is_empty() {
        return Err(invalid(format!("'{name}' cannot be empty")));
    }
    if value.encode_utf16().count() > max {
        return Err(invalid(format!("'{name}' cannot exceed {max} characters")));
    }
    Ok(Some(json!(value)))
}
pub fn required_string(value: Option<&Value>, name: &str, max: usize) -> Result<String, ApiError> {
    Ok(string(value, name, true, false, max)?
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned())
}
pub fn version(value: Option<&Value>) -> Result<Value, ApiError> {
    let n = value
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("'version' must be a positive integer"))?;
    Ok(json!(n))
}
pub fn project_id(value: &str) -> Result<String, ApiError> {
    let valid = regex::Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
        .unwrap()
        .is_match(value);
    if !valid {
        Err(invalid(
            "'id' must be a lowercase slug containing letters, numbers, or hyphens",
        ))
    } else {
        Ok(value.into())
    }
}
pub fn issue_key(value: &Value) -> Result<Value, ApiError> {
    let key = required_string(Some(value), "issueKey", 32)?.to_uppercase();
    if !regex::Regex::new(r"^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$")
        .unwrap()
        .is_match(&key)
    {
        return Err(invalid(
            "'issueKey' must contain 1-32 letters, numbers or single internal hyphens or dots",
        ));
    }
    Ok(json!(key))
}
pub fn decode(value: &str) -> Result<String, ApiError> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(ApiError::new(
                    400,
                    "INVALID_PATH",
                    "Path contains invalid encoding",
                ));
            }
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            match (h, l) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => {
                    return Err(ApiError::new(
                        400,
                        "INVALID_PATH",
                        "Path contains invalid encoding",
                    ))
                }
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out)
        .map_err(|_| ApiError::new(400, "INVALID_PATH", "Path contains invalid encoding"))
}
pub fn path_segment(value: &str) -> Result<String, ApiError> {
    let s = decode(value)?;
    if s.is_empty() || s.encode_utf16().count() > 256 || s.contains('\0') {
        return Err(ApiError::new(
            400,
            "INVALID_PATH",
            "Path segment is invalid",
        ));
    }
    Ok(s)
}
pub fn query(raw: Option<&str>, fields: &[&str]) -> Result<HashMap<String, String>, ApiError> {
    let mut values = HashMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        if !fields.contains(&key.as_ref()) {
            return Err(ApiError::new(
                400,
                "UNKNOWN_QUERY_PARAMETER",
                format!("Unknown query parameter '{key}'"),
            ));
        }
        if values.insert(key.to_string(), value.to_string()).is_some() {
            return Err(ApiError::new(
                400,
                "INVALID_QUERY_PARAMETER",
                format!("Query parameter '{key}' cannot be repeated"),
            ));
        }
    }
    Ok(values)
}
pub fn status(value: Option<&Value>, fallback: Option<&str>) -> Result<Value, ApiError> {
    let value = value
        .and_then(Value::as_str)
        .or(fallback)
        .ok_or_else(|| invalid("'status' is required"))?;
    if !STATUSES.contains(&value) {
        return Err(invalid(format!(
            "'status' must be one of: {}",
            STATUSES.join(", ")
        )));
    }
    Ok(json!(value))
}
fn priority(value: Option<&Value>, fallback: Option<&str>) -> Result<Value, ApiError> {
    let value = value
        .and_then(Value::as_str)
        .or(fallback)
        .ok_or_else(|| invalid("'priority' is required"))?;
    if !["none", "urgent", "high", "medium", "low"].contains(&value) {
        return Err(invalid(
            "'priority' must be none, urgent, high, medium, or low",
        ));
    }
    Ok(json!(value))
}
fn labels(value: &Value) -> Result<Value, ApiError> {
    let entries = value
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or_else(|| invalid("'labels' must be an array with at most 20 entries"))?;
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in entries {
        let label = required_string(Some(item), "label", 64)?;
        if !seen.insert(label.clone()) {
            return Err(invalid("Labels must be unique"));
        }
        output.push(json!(label));
    }
    Ok(json!(output))
}
pub fn actor(headers: &HeaderMap) -> Result<Value, ApiError> {
    if header(headers, "x-panel-client") == Some("panelctl")
        || header(headers, "x-taskboard-client") == Some("taskctl")
    {
        return Ok(agent_actor());
    }
    let id = header(headers, "x-panel-user-id").or_else(|| header(headers, "x-taskboard-user-id"));
    let name =
        header(headers, "x-panel-user-name").or_else(|| header(headers, "x-taskboard-user-name"));
    let avatar = header(headers, "x-panel-user-avatar")
        .or_else(|| header(headers, "x-taskboard-user-avatar"));
    if id.is_none() && name.is_none() && avatar.is_none() {
        return Ok(json!({"type":"user","id":"local-user","name":"本地用户","avatarUrl":null}));
    }
    let id = id.ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_ACTOR",
            "User identity requires both an ID and name",
        )
    })?;
    let name = decode(name.ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_ACTOR",
            "User identity requires both an ID and name",
        )
    })?)?;
    if id.len() > 96
        || !regex::Regex::new(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
            .unwrap()
            .is_match(id)
        || name.trim().is_empty()
        || name.encode_utf16().count() > 120
    {
        return Err(ApiError::new(
            400,
            "INVALID_ACTOR",
            "User identity is invalid",
        ));
    }
    if let Some(avatar) = avatar {
        let parsed = url::Url::parse(avatar).ok();
        let valid = parsed
            .as_ref()
            .is_some_and(|v| ["http", "https"].contains(&v.scheme()))
            || regex::Regex::new(r"^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$")
                .unwrap()
                .is_match(avatar);
        if avatar.len() > 2048 || !valid {
            return Err(ApiError::new(
                400,
                "INVALID_ACTOR",
                "User avatar URL must use HTTP, HTTPS or a base64 WebP image",
            ));
        }
    }
    Ok(json!({"type":"user","id":id,"name":name.trim(),"avatarUrl":avatar}))
}
pub fn agent_actor() -> Value {
    json!({"type":"agent","id":"codex-agent","name":"Codex Agent","avatarUrl":null})
}
pub fn binding(value: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(Some(Value::Null));
    }
    allowed(
        value,
        &[
            "threadId",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
        ],
    )?;
    let thread = required_string(value.get("threadId"), "threadBinding.threadId", 256)?;
    let keys = [
        "codexProjectId",
        "codexProjectKind",
        "codexHostId",
        "workspacePath",
    ];
    if keys.iter().all(|k| value.get(k).is_none()) {
        return Ok(Some(json!({"threadId":thread})));
    }
    if keys.iter().any(|k| value.get(k).is_none()) {
        return Err(invalid(
            "Thread identity must include project, kind, host, and workspace",
        ));
    }
    let project = required_string(
        value.get("codexProjectId"),
        "threadBinding.codexProjectId",
        256,
    )?;
    let kind = value["codexProjectKind"].as_str().unwrap_or("");
    let host = required_string(value.get("codexHostId"), "threadBinding.codexHostId", 256)?;
    let workspace = required_string(
        value.get("workspacePath"),
        "threadBinding.workspacePath",
        4096,
    )?;
    if !["local", "remote"].contains(&kind)
        || (kind == "local") != (host == "local")
        || workspace.contains('\0')
    {
        return Err(invalid("Thread project identity is invalid"));
    }
    Ok(Some(
        json!({"threadId":thread,"codexProjectId":project,"codexProjectKind":kind,"codexHostId":host,"workspacePath":workspace}),
    ))
}
pub fn attribution(body: &Value) -> Result<Value, ApiError> {
    let mut result = json!({});
    if body.get("threadId").is_some() {
        if let Some(value) = string(body.get("threadId"), "threadId", true, false, 256)? {
            result["threadId"] = value;
        }
    }
    if let Some(value) = binding(body.get("threadBinding"))? {
        result["threadBinding"] = value;
    }
    if let Some(session) = body.get("agentSession") {
        if session.is_null() {
            result["agentSession"] = Value::Null;
        } else {
            allowed(session, &["platform", "sessionId"])?;
            let platform = session["platform"].as_str().unwrap_or("");
            if !["claude", "pi", "agy", "grok"].contains(&platform) {
                return Err(invalid(
                    "agentSession.platform must be claude, pi, agy, or grok",
                ));
            }
            let id = session["sessionId"]
                .as_str()
                .ok_or_else(|| invalid("agentSession.sessionId must be a string"))?;
            let max = if platform == "pi" { 4096 } else { 256 };
            if id.trim().is_empty()
                || id.encode_utf16().count() > max
                || id.trim_start().starts_with('-')
                || id.chars().any(|c| c.is_control())
            {
                return Err(invalid("agentSession.sessionId is invalid"));
            }
            if body.get("threadId").is_some() {
                return Err(invalid(
                    "Use agentSession or Codex threadId for controller attribution, not both",
                ));
            }
            result["agentSession"] = session.clone();
        }
    }
    Ok(result)
}
pub fn sort_order(value: &Value) -> Result<Value, ApiError> {
    let number = value
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 1e12)
        .ok_or_else(|| {
            invalid("'sortOrder' must be a finite number between -1000000000000 and 1000000000000")
        })?;
    Ok(json!(number))
}
fn date(value: &Value, name: &str) -> Result<Value, ApiError> {
    let value = string(Some(value), name, false, true, 10)?.unwrap();
    if let Some(s) = value.as_str() {
        if !regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
            .unwrap()
            .is_match(s)
        {
            return Err(invalid(format!("'{name}' must use YYYY-MM-DD")));
        }
    }
    Ok(value)
}
fn recurrence(value: &Value) -> Result<Value, ApiError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    allowed(value, &["interval", "unit"])?;
    if !value["interval"]
        .as_u64()
        .is_some_and(|v| (1..=365).contains(&v))
        || !["day", "week", "month", "year"].contains(&value["unit"].as_str().unwrap_or(""))
    {
        return Err(invalid(
            "'recurrence' must have an interval from 1 to 365 and a valid unit",
        ));
    }
    Ok(value.clone())
}
pub fn task(body: &Value, create: bool) -> Result<Value, ApiError> {
    let mut keys = vec![
        "projectId",
        "title",
        "description",
        "status",
        "priority",
        "labels",
        "threadId",
        "threadBinding",
        "agentSession",
        "assigneeTarget",
        "developmentContext",
        "startDate",
        "dueDate",
        "recurrence",
    ];
    keys.push(if create { "sortOrder" } else { "version" });
    allowed(body, &keys)?;
    let mut out = attribution(body)?;
    if !create {
        out["version"] = version(body.get("version"))?;
    }
    if create || body.get("projectId").is_some() {
        out["projectId"] = json!(project_id(
            body["projectId"]
                .as_str()
                .unwrap_or(if create { "local" } else { "" })
        )?);
    }
    for (key, required, max, fallback) in [
        ("title", true, 240, None),
        ("description", false, 100_000, Some("")),
    ] {
        if create || body.get(key).is_some() {
            if let Some(v) = string(
                body.get(key).or_else(|| if create { None } else { None }),
                key,
                required,
                false,
                max,
            )? {
                out[key] = v;
            } else if let Some(s) = fallback {
                out[key] = json!(s);
            }
        }
    }
    if create || body.get("status").is_some() {
        out["status"] = status(
            body.get("status"),
            if create { Some("backlog") } else { None },
        )?;
    }
    if create || body.get("priority").is_some() {
        out["priority"] = priority(
            body.get("priority"),
            if create { Some("none") } else { None },
        )?;
    }
    if let Some(v) = body.get("labels") {
        out["labels"] = labels(v)?;
    } else if create {
        out["labels"] = json!([]);
    }
    if let Some(v) = body.get("sortOrder") {
        out["sortOrder"] = sort_order(v)?;
    }
    for key in ["startDate", "dueDate"] {
        if let Some(v) = body.get(key) {
            out[key] = date(v, key)?;
        } else if create {
            out[key] = Value::Null;
        }
    }
    if let Some(v) = body.get("recurrence") {
        out["recurrence"] = recurrence(v)?;
    } else if create {
        out["recurrence"] = Value::Null;
    }
    if out.get("recurrence").is_some_and(|v| !v.is_null())
        && ((create && out["dueDate"].is_null()) || body.get("dueDate").is_some_and(Value::is_null))
    {
        return Err(invalid("A recurring issue requires 'dueDate'"));
    }
    if let Some(context) = body.get("developmentContext") {
        if context.is_null() {
            out["developmentContext"] = Value::Null;
        } else {
            let kind = context["type"].as_str().unwrap_or("");
            match kind {
                "branch" => {
                    allowed(context, &["type", "branch"])?;
                    out["developmentContext"] = json!({"type":"branch","branch":required_string(context.get("branch"),"developmentContext.branch",512)?});
                }
                "worktree" => {
                    allowed(context, &["type", "path", "branch"])?;
                    let path =
                        required_string(context.get("path"), "developmentContext.path", 4096)?;
                    if path.contains('\0') {
                        return Err(invalid("developmentContext.path cannot contain null bytes"));
                    }
                    out["developmentContext"] = json!({"type":"worktree","path":path,"branch":string(context.get("branch"),"developmentContext.branch",false,true,512)?.unwrap_or(Value::Null)});
                }
                _ => {
                    return Err(invalid(
                        "'developmentContext.type' must be branch or worktree",
                    ))
                }
            }
        }
    } else if create {
        out["developmentContext"] = Value::Null;
    }
    if let Some(v) = body.get("assigneeTarget") {
        if !["current-user", "codex-agent"].contains(&v.as_str().unwrap_or("")) {
            return Err(invalid(
                "'assigneeTarget' must be current-user or codex-agent",
            ));
        }
        out["assigneeTarget"] = v.clone();
    }
    if !create
        && !keys
            .iter()
            .filter(|k| !["version", "threadId", "threadBinding"].contains(k))
            .any(|k| body.get(*k).is_some())
    {
        return Err(ApiError::new(
            400,
            "INVALID_BODY",
            "PATCH requires at least one task field",
        ));
    }
    Ok(out)
}
pub fn attachment(headers: &HeaderMap) -> Result<Value, ApiError> {
    let encoded = header(headers, "x-panel-filename")
        .or_else(|| header(headers, "x-taskboard-filename"))
        .ok_or_else(|| ApiError::new(400, "INVALID_FILENAME", "X-Panel-Filename is required"))?;
    let filename = decode(encoded)?.trim().to_owned();
    if filename.is_empty()
        || filename.encode_utf16().count() > 240
        || [".", ".."].contains(&filename.as_str())
        || filename
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(ApiError::new(
            400,
            "INVALID_FILENAME",
            "Attachment filename is invalid",
        ));
    }
    let content_type = header(headers, "content-type")
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap()
        .trim()
        .to_ascii_lowercase();
    if content_type.len() > 200
        || !regex::Regex::new(r"^[!#$%&'*+.^_`|~0-9a-z-]+/[!#$%&'*+.^_`|~0-9a-z-]+$")
            .unwrap()
            .is_match(&content_type)
    {
        return Err(ApiError::new(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Attachment Content-Type is invalid",
        ));
    }
    let kind = header(headers, "x-panel-attachment-kind")
        .or_else(|| header(headers, "x-taskboard-attachment-kind"))
        .unwrap_or("");
    if !["inline", "attachment"].contains(&kind) {
        return Err(ApiError::new(
            400,
            "INVALID_ATTACHMENT_KIND",
            "X-Panel-Attachment-Kind must be inline or attachment",
        ));
    }
    Ok(json!({"filename":filename,"contentType":content_type,"kind":kind}))
}
