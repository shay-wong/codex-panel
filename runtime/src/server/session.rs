use super::{store, AppState};
use crate::ApiError;
use serde_json::{json, Value};
use std::{io::SeekFrom, path::PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

async fn find(state: &AppState, thread: &str) -> Result<Option<PathBuf>, ApiError> {
    let suffix = format!("-{thread}.jsonl");
    let mut directories = vec![state.config.codex_home.join("sessions")];
    while let Some(directory) = directories.pop() {
        let mut entries = match tokio::fs::read_dir(directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            if kind.is_dir() {
                directories.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(&suffix) {
                return Ok(Some(entry.path()));
            }
        }
    }
    Ok(None)
}

pub async fn binding(state: &AppState, thread: &str) -> Result<Option<Value>, ApiError> {
    {
        let runtime = state
            .host_runtime
            .lock()
            .map_err(|_| ApiError::new(500, "RUNTIME_LOCK", "Runtime lock was poisoned"))?;
        if let Some(runtime) = runtime
            .as_ref()
            .filter(|runtime| runtime["threadId"] == thread)
        {
            if [
                "codexProjectId",
                "codexProjectKind",
                "codexHostId",
                "workspacePath",
            ]
            .iter()
            .all(|key| runtime[*key].is_string())
            {
                return Ok(Some(
                    json!({"threadId":thread,"codexProjectId":runtime["codexProjectId"],"codexProjectKind":runtime["codexProjectKind"],"codexHostId":runtime["codexHostId"],"workspacePath":runtime["workspacePath"]}),
                ));
            }
        }
    }
    let value = store::read(
        &state.config.codex_home.join(".codex-global-state.json"),
        json!({}),
    )
    .await?;
    let assignment = &value["thread-project-assignments"][thread];
    if assignment["projectKind"] != "local"
        || !assignment["projectId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Ok(None);
    }
    let Some(path) = find(state, thread).await? else {
        return Ok(None);
    };
    let file = tokio::fs::File::open(path).await?;
    let mut data = Vec::new();
    file.take(64 * 1024).read_to_end(&mut data).await?;
    for line in data.split(|b| *b == b'\n') {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if record["type"] == "session_meta" && record["payload"]["id"] == thread {
            if let Some(cwd) = record["payload"]["cwd"]
                .as_str()
                .filter(|s| std::path::Path::new(s).is_absolute())
            {
                return Ok(Some(
                    json!({"threadId":thread,"codexProjectId":assignment["projectId"],"codexProjectKind":"local","codexHostId":"local","workspacePath":cwd}),
                ));
            }
        }
    }
    Ok(None)
}

pub async fn progress(state: &AppState, thread: &str) -> Result<Value, ApiError> {
    let Some(path) = find(state, thread).await? else {
        return Ok(Value::Null);
    };
    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let length = size.min(16 * 1024 * 1024);
    file.seek(SeekFrom::Start(size - length)).await?;
    let mut data = Vec::new();
    file.take(length).read_to_end(&mut data).await?;
    let mut lines = data.split(|b| *b == b'\n');
    if length < size {
        lines.next();
    }
    let records = lines
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .collect::<Vec<_>>();
    let mut running = None;
    for record in &records {
        let payload = &record["payload"];
        if record["type"] != "event_msg" || !payload["turn_id"].is_string() {
            continue;
        }
        if payload["type"] == "task_started" {
            running = payload["turn_id"].as_str().map(str::to_owned);
        }
        if ["task_complete", "turn_aborted"].contains(&payload["type"].as_str().unwrap_or(""))
            && payload["turn_id"].as_str() == running.as_deref()
        {
            running = None;
        }
    }
    for record in records.iter().rev() {
        let payload = &record["payload"];
        if payload["type"] != "custom_tool_call" {
            continue;
        }
        let Some(input) = payload["input"].as_str() else {
            continue;
        };
        let statuses = if payload["name"] == "update_plan" {
            serde_json::from_str::<Value>(input)
                .ok()
                .and_then(|v| {
                    v["plan"].as_array().map(|plan| {
                        plan.iter()
                            .filter_map(|item| item["status"].as_str().map(str::to_owned))
                            .collect::<Vec<_>>()
                    })
                })
                .unwrap_or_default()
        } else if payload["name"] == "exec" {
            let Some((_, tail)) = input.rsplit_once("tools.update_plan(") else {
                continue;
            };
            regex::Regex::new(r#"["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']"#)
                .unwrap()
                .captures_iter(tail)
                .map(|capture| capture[1].to_owned())
                .collect()
        } else {
            continue;
        };
        if !statuses.is_empty() {
            return Ok(
                json!({"completed":statuses.iter().filter(|s|*s=="completed").count(),"total":statuses.len(),"running":running.is_some()}),
            );
        }
    }
    Ok(json!({"completed":null,"total":null,"running":running.is_some()}))
}
