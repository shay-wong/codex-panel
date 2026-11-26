use super::*;

pub(super) fn binding(row: &Value) -> Value {
    if [
        "thread_id",
        "thread_codex_project_id",
        "thread_codex_project_kind",
        "thread_codex_host_id",
        "thread_workspace_path",
    ]
    .iter()
    .any(|k| !truth(&row[k]))
    {
        return Value::Null;
    }
    fields(row,"thread_id thread_codex_project_id:codexProjectId thread_codex_project_kind:codexProjectKind thread_codex_host_id:codexHostId thread_workspace_path:workspacePath")
}
pub(super) fn legacy_thread(row: &Value) -> Value {
    if !truth(&row["thread_id"]) {
        return Value::Null;
    }
    if [
        "thread_codex_project_id",
        "thread_codex_project_kind",
        "thread_codex_host_id",
        "thread_workspace_path",
    ]
    .iter()
    .all(|k| row[k].is_null())
    {
        row["thread_id"].clone()
    } else {
        Value::Null
    }
}
pub(super) fn stored_binding(
    current: &Value,
    supplied: Option<&Value>,
    thread: Option<&Value>,
) -> Option<Vec<Value>> {
    // 仅更新会话 ID 时保留同一会话已有的完整宿主绑定；显式 null 才清空绑定。
    if supplied.is_none() && thread.map_or(true, Value::is_null) {
        return None;
    }
    let existing = &current["threadBinding"];
    let selected = supplied.cloned().unwrap_or_else(|| {
        if !existing.is_null() && thread == Some(&existing["threadId"]) {
            existing.clone()
        } else {
            json!({"threadId":thread})
        }
    });
    Some(
        [
            "threadId",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
        ]
        .map(|k| selected[k].clone())
        .to_vec(),
    )
}
pub(super) fn task(row: &Value) -> Result<Value, ApiError> {
    let mut out = fields(row,"id identifier project_id title description status priority sort_order thread_id creator_type creator_id creator_name creator_avatar_url start_date due_date external_origin external_key external_url external_status external_updated_at external_synced_at external_sync_error archived_at version created_at updated_at");
    out["labels"] = parse_json(&row["labels"])?;
    out["threadBinding"] = binding(row);
    out["legacyLocalThreadId"] = legacy_thread(row);
    out["agentSession"] = parse_json(&row["agent_session"])?;
    out["assignee"] = fields(
        row,
        "assignee_type:type assignee_id:id assignee_name:name assignee_avatar_url:avatarUrl",
    );
    out["developmentContext"] = if truth(&row["worktree_path"]) {
        json!({"type":"worktree","path":row["worktree_path"],"branch":row["worktree_branch"]})
    } else if truth(&row["git_branch"]) {
        json!({"type":"branch","branch":row["git_branch"]})
    } else {
        Value::Null
    };
    out["recurrence"] = if truth(&row["recurrence_interval"]) && truth(&row["recurrence_unit"]) {
        json!({"interval":row["recurrence_interval"],"unit":row["recurrence_unit"]})
    } else {
        Value::Null
    };
    out["source"] = json!(if row["external_source"] == "jira" {
        "jira"
    } else {
        "local"
    });
    if row["external_source"] == "jira" {
        out["description"] = json!(jira_description(text(&row["description"])));
    }
    Ok(out)
}
pub(super) fn jira_description(source: &str) -> String {
    regex::Regex::new(r"(?m)^([ \t]*)#\s+")
        .unwrap()
        .replace_all(source, "${1}1. ")
        .chars()
        .take(100_000)
        .collect()
}
pub(super) fn summary(row: &Value) -> Value {
    let mut out=fields(row,"id identifier external_key project_id title status external_url external_status priority archived_at version");
    out["assignee"] = fields(
        row,
        "assignee_type:type assignee_id:id assignee_name:name assignee_avatar_url:avatarUrl",
    );
    out
}
pub(super) fn project(row: &Value) -> Result<Value, ApiError> {
    if row.is_null() {
        return Ok(Value::Null);
    }
    let mut out = fields(
        row,
        "id name issue_key workspace_path created_at updated_at",
    );
    out["labels"] = parse_json(&row["labels"])?;
    out["source"] = json!(if row["id"] == "jira-my-tasks" {
        "jira"
    } else {
        "local"
    });
    out["issueCount"] = fallback(&row["issue_count"], json!(0));
    Ok(out)
}
pub(super) fn attachment(row: &Value, revision: bool) -> Value {
    if row.is_null() {
        return Value::Null;
    }
    let mut out = fields(
        row,
        "id task_id comment_id kind filename content_type size created_at",
    );
    out["bodyFallback"] = json!(row["body_fallback"] == 1);
    if revision {
        out["changeRevision"] = row["change_revision"].clone();
    }
    out
}
pub(super) fn comment(row: &Value, revision: bool) -> Result<Value, ApiError> {
    if row.is_null() {
        return Ok(Value::Null);
    }
    let mut out=fields(row,"id task_id body thread_id author_type author_id author_name author_avatar_url version created_at updated_at");
    out["threadBinding"] = binding(row);
    out["legacyLocalThreadId"] = legacy_thread(row);
    out["agentSession"] = parse_json(&row["agent_session"])?;
    out["attachments"] = json!([]);
    if revision {
        out["changeRevision"] = row["change_revision"].clone();
    }
    Ok(out)
}
pub(super) fn claim(row: &Value) -> Value {
    if row.is_null() {
        return Value::Null;
    }
    let mut out=fields(row,"task_id project_id thread_id source state attempt_count available_at enqueued_at started_at finished_at last_error updated_at");
    out["resumeRequested"] = json!(truth(&row["resume_requested"]));
    out
}
pub(super) fn changes(before: &Value, after: &Value) -> Vec<Value> {
    after
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, v)| !same(&before[*k], v))
                .map(|(k, v)| json!({"field":k,"before":before[k],"after":v}))
                .collect()
        })
        .unwrap_or_default()
}
pub(super) fn relation_value(kind: &str, task: &Value) -> Value {
    json!({"type":kind,"identifier":task["identifier"],"externalKey":task["externalKey"],"title":task["title"]})
}
