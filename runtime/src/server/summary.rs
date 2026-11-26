use super::{ai, AppState};
use crate::ApiError;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn due(summary: &Value) -> bool {
    let Some(at) = summary["attemptedAt"].as_str() else {
        return true;
    };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(at) else {
        return true;
    };
    let delay = if summary["error"].is_null() {
        24 * 60 * 60
    } else {
        match summary["failureCount"].as_u64() {
            Some(1) => 5 * 60,
            Some(2) => 15 * 60,
            Some(3) => 60 * 60,
            _ => return false,
        }
    };
    chrono::Utc::now().signed_duration_since(at).num_seconds() >= delay
}

pub async fn refresh(state: &Arc<AppState>, id: &str) -> Result<(), ApiError> {
    {
        let mut active = state
            .summary_active
            .lock()
            .map_err(|_| ApiError::new(500, "SUMMARY_LOCK", "Summary lock was poisoned"))?;
        if !active.insert(id.into()) {
            return Ok(());
        }
    }
    let generated=async{
        let project=state.db("getProject",&[json!(id)])?;if project.is_null(){return Err(ApiError::new(404,"PROJECT_NOT_FOUND",format!("Project '{id}' was not found")));}
        let tasks=state.db("listTasks",&[json!({"projectId":id,"archived":"false"})])?;
        let tasks=tasks.as_array().cloned().unwrap_or_default();
        let labels=[("backlog","积压事项"),("todo","待办"),("in_progress","处理中"),("in_review","等你确认"),("blocked","遇到阻碍"),("done","完成"),("canceled","取消")];
        let mut counts=json!({});for(status,label)in labels{counts[label]=json!(tasks.iter().filter(|task|task["status"]==status).count());}
        let cutoff=chrono::Utc::now()-chrono::Duration::days(7);
        let issues=tasks.iter().filter(|task|!["done","canceled"].contains(&task["status"].as_str().unwrap_or("")) || task["activityUpdatedAt"].as_str().and_then(|value|chrono::DateTime::parse_from_rfc3339(value).ok()).is_some_and(|at|at>=cutoff)).map(|task|json!({"id":task["identifier"],"title":task["title"],"status":labels.iter().find(|(status,_)|task["status"]==*status).map(|(_,label)|*label).unwrap_or(""),"priority":task["priority"],"labels":task["labels"],"dueDate":task["dueDate"],"updatedAt":task["activityUpdatedAt"]})).collect::<Vec<_>>();
        let prompt=format!("你是 Codex。请根据下面的任务面板快照，为项目负责人写一段项目总结。\n\n要求：只输出一段 60 至 120 字的简体中文；直接说明当前进展、主要风险或阻碍、下一步重点；不要使用标题、列表或 Markdown；不要调用工具。\n\n{}",json!({"project":project["name"],"generatedForDate":chrono::Utc::now().format("%Y-%m-%d").to_string(),"counts":counts,"issues":issues}));
        let answer=ai::run_readonly(&state.config.project_root,&prompt).await?;
        let answer=answer.split_whitespace().collect::<Vec<_>>().join(" ");
        state.db("saveProjectSummary",&[json!(id),json!(answer)])?;Ok::<_,ApiError>(())
    }.await;
    if let Err(error) = &generated {
        state.db(
            "saveProjectSummaryError",
            &[json!(id), json!(error.message)],
        )?;
    }
    state
        .summary_active
        .lock()
        .map_err(|_| ApiError::new(500, "SUMMARY_LOCK", "Summary lock was poisoned"))?
        .remove(id);
    generated
}

pub fn get(state: &Arc<AppState>, id: &str) -> Result<Value, ApiError> {
    if state.db("getProject", &[json!(id)])?.is_null() {
        return Err(ApiError::new(
            404,
            "PROJECT_NOT_FOUND",
            format!("Project '{id}' was not found"),
        ));
    }
    let summary = state.db("getProjectSummary", &[json!(id)])?;
    if due(&summary) {
        let state = state.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let _ = refresh(&state, &id).await;
        });
    }
    let active = state
        .summary_active
        .lock()
        .map_err(|_| ApiError::new(500, "SUMMARY_LOCK", "Summary lock was poisoned"))?
        .contains(id);
    Ok(
        json!({"projectId":id,"summary":summary["summary"],"updatedAt":summary["generatedAt"],"refreshing":active,"error":summary["error"]}),
    )
}
