use super::{ai, validate as v, AppState};
use crate::ApiError;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

fn undefined() -> Value {
    json!({"$panelUndefined":true})
}
fn values(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn get_task(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let task = state.db("getTask", &[json!(id)])?;
    if task.is_null() {
        Err(ApiError::new(
            404,
            "TASK_NOT_FOUND",
            format!("Task '{id}' does not exist"),
        ))
    } else {
        Ok(task)
    }
}
fn emit_claim(state: &AppState, claim: Value) {
    state.emit(
        "claim.updated",
        json!({"projectId":claim["projectId"],"taskId":claim["taskId"],"claim":claim}),
    );
}
fn move_task(state: &AppState, task: &Value, status: &str) -> Result<Value, ApiError> {
    let moved = state.db(
        "moveTask",
        &[
            task["id"].clone(),
            task["version"].clone(),
            json!(status),
            undefined(),
            undefined(),
            undefined(),
            v::agent_actor(),
        ],
    )?;
    state.emit("task.moved", json!({"task":moved}));
    Ok(moved)
}

pub fn tick(state: &AppState) -> Result<(), ApiError> {
    let jira = state.db("enqueueAuthorizedJiraClaims", &[])?;
    let scans = state.db("enqueueDueProjectScans", &[])?;
    let changed = state.db("reconcileClaimQueue", &[])?;
    for id in values(&changed) {
        emit_claim(state, state.db("getClaimQueueItem", &[id])?);
    }
    for claim in values(&jira).into_iter().chain(values(&scans)) {
        emit_claim(state, claim);
    }
    Ok(())
}

pub fn enqueue(state: &AppState, id: &str, source: &str) -> Result<Value, ApiError> {
    let mut task = get_task(state, id)?;
    let mut source = source;
    if source == "manual" {
        state.db("assertIssueExecutionAllowed", &[json!(id)])?;
    }
    if task["status"] == "blocked" {
        if source == "manual" {
            let claim = state.db("getClaimQueueItem", &[json!(id)])?;
            if claim["state"] != "blocked" || claim["lastError"].is_null() {
                return Err(ApiError::new(
                    409,
                    "CLAIM_USER_INPUT_REQUIRED",
                    "Reply to the blocked issue or conversation before continuing execution",
                ));
            }
            source = "resume";
        }
        if source != "resume" {
            return Err(ApiError::new(
                409,
                "CLAIM_TASK_STATUS",
                "Only waiting issues can be started manually",
            ));
        }
        task = move_task(state, &task, "todo")?;
    }
    let claim = state.db("enqueueClaim", &[task["id"].clone(), json!(source)])?;
    emit_claim(state, claim.clone());
    Ok(json!({"task":get_task(state,id)?,"claim":claim}))
}

pub fn resume_comment(state: &AppState, id: &str) -> Result<(), ApiError> {
    let task = get_task(state, id)?;
    let claim = state.db("getClaimQueueItem", &[json!(id)])?;
    if claim.is_null() || task["status"] != "blocked" {
        return Ok(());
    }
    if let Err(error) = state.db("assertIssueExecutionAllowed", &[json!(id)]) {
        if error.code.starts_with("JIRA_") {
            return Ok(());
        }
        return Err(error);
    }
    if claim["state"] == "blocked" && claim["lastError"].is_null() {
        enqueue(state, id, "resume")?;
    } else if claim["state"] == "running" {
        let next = state.db("requestClaimResume", &[json!(id)])?;
        if !next.is_null() {
            emit_claim(state, next);
        }
    }
    Ok(())
}

pub fn recover(state: &AppState) -> Result<(), ApiError> {
    let interrupted = state.db("recoverInterruptedClaims", &[])?;
    for id in values(&interrupted) {
        let Some(id) = id.as_str() else { continue };
        let task = get_task(state, id)?;
        let claim = state.db("getClaimQueueItem", &[json!(id)])?;
        let attempts = state.db("listClaimAttempts", &[json!(id)])?;
        let previous = attempts
            .as_array()
            .and_then(|a| a.last())
            .cloned()
            .unwrap_or(Value::Null);
        let thread = if claim["threadId"].is_string() {
            state.db("getAiChatThread", &[claim["threadId"].clone()])?
        } else {
            Value::Null
        };
        let consistent = claim["threadId"].is_string()
            && previous["runId"].is_string()
            && previous["threadId"] == claim["threadId"]
            && task["developmentContext"]["type"] == "worktree"
            && thread["origin"]["issueId"] == task["id"]
            && thread["origin"]["projectId"] == task["projectId"]
            && thread["origin"]["workspacePath"] == task["developmentContext"]["path"];
        if consistent && task["status"] == "blocked" && claim["resumeRequested"] == true {
            enqueue(state, id, "resume")?;
            continue;
        }
        if !consistent {
            if ["in_progress", "todo"].contains(&task["status"].as_str().unwrap_or("")) {
                move_task(state, &task, "blocked")?;
            }
            emit_claim(state,state.db("finishClaim",&[json!(id),json!("blocked"),json!("Interrupted execution context could not be verified after Panel restarted")])?);
        } else if task["status"] == "in_progress" {
            move_task(state, &task, "todo")?;
            emit_claim(state, state.db("getClaimQueueItem", &[json!(id)])?);
        }
    }
    Ok(())
}

pub fn policy(body: &Value) -> Result<Value, ApiError> {
    v::allowed(
        body,
        &[
            "enabledByUser",
            "paused",
            "intervalMinutes",
            "model",
            "reasoningEffort",
            "defaultParallelism",
            "parallelismOverride",
        ],
    )?;
    if !body["enabledByUser"].is_boolean() || !body["paused"].is_boolean() {
        return Err(v::invalid("Automation switches must be boolean"));
    }
    if !body["intervalMinutes"]
        .as_u64()
        .is_some_and(|v| [5, 10, 15, 30, 60].contains(&v))
    {
        return Err(v::invalid("'intervalMinutes' must be 5, 10, 15, 30, or 60"));
    }
    v::required_string(body.get("model"), "model", 256)?;
    v::required_string(body.get("reasoningEffort"), "reasoningEffort", 100)?;
    if !body["defaultParallelism"]
        .as_u64()
        .is_some_and(|v| (1..=8).contains(&v))
        || (!body["parallelismOverride"].is_null()
            && !body["parallelismOverride"]
                .as_u64()
                .is_some_and(|v| (1..=8).contains(&v)))
    {
        return Err(v::invalid("Parallelism must be between 1 and 8"));
    }
    Ok(body.clone())
}

fn peers(state: &AppState, task: &Value) -> Result<Vec<Value>, ApiError> {
    let jira = values(&state.db("jiraExecutionPeers", &[task["id"].clone()])?);
    let mut peers = jira.clone();
    for item in std::iter::once(task).chain(jira.iter()) {
        peers.extend(values(
            &state.db("executionContextPeers", &[item["id"].clone()])?,
        ));
    }
    Ok(peers)
}

fn available(state: &AppState, task: &Value, peers: &[Value]) -> Result<bool, ApiError> {
    let reservations = state
        .native_reservations
        .lock()
        .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?;
    for peer in peers {
        if peer["id"] == task["id"] {
            continue;
        }
        let claim = state.db("getClaimQueueItem", &[peer["id"].clone()])?;
        if peer["status"] == "in_progress"
            || (peer["status"] == "blocked"
                && (!peer["threadBinding"].is_null() || !claim.is_null()))
            || claim["state"] == "running"
            || peer["id"]
                .as_str()
                .is_some_and(|id| reservations.contains_key(id))
        {
            return Ok(false);
        }
    }
    let jira_peers = values(&state.db("jiraExecutionPeers", &[task["id"].clone()])?);
    for dependency in task["relations"]["blockedBy"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !["done", "canceled"].contains(&dependency["status"].as_str().unwrap_or(""))
            && !(dependency["status"] == "in_review"
                && jira_peers.iter().any(|peer| peer["id"] == dependency["id"]))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn owner(state: &AppState, task: &Value) -> Result<Option<Value>, ApiError> {
    if !task["threadBinding"].is_null() {
        return Ok(Some(task.clone()));
    }
    let jira = values(&state.db("jiraExecutionPeers", &[task["id"].clone()])?);
    let owners = jira
        .into_iter()
        .filter(|peer| {
            !peer["threadBinding"].is_null()
                && !peer["developmentContext"].is_null()
                && ["in_review", "done"].contains(&peer["status"].as_str().unwrap_or(""))
        })
        .collect::<Vec<_>>();
    let prerequisites = owners
        .iter()
        .filter(|peer| {
            task["relations"]["blockedBy"]
                .as_array()
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|dependency| dependency["id"] == peer["id"])
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    let candidates = if prerequisites.is_empty() {
        owners
    } else {
        prerequisites
    };
    if candidates
        .iter()
        .map(|peer| peer["threadBinding"].to_string())
        .collect::<std::collections::HashSet<_>>()
        .len()
        > 1
    {
        return Err(ApiError::new(
            409,
            "CLAIM_THREAD_CONFLICT",
            "共享执行组存在多个执行上下文，请先绑定要继续的会话",
        ));
    }
    Ok(candidates.into_iter().next())
}

async fn preparation(state: &AppState, task: &Value) -> Result<Value, ApiError> {
    let context = ai::context(state, task["projectId"].as_str().unwrap_or(""), None, None).await?;
    let workspace = if task["developmentContext"]["type"] == "worktree" {
        task["developmentContext"]["path"]
            .as_str()
            .unwrap_or(&context.workspace)
    } else {
        &context.workspace
    };
    let canonical = tokio::fs::canonicalize(workspace).await?;
    Ok(
        json!({"workspacePath":canonical,"workspaceKey":canonical,"projectName":context.project["name"],"codexProjectId":task["projectId"],"useWorktree":task["developmentContext"].is_null()}),
    )
}

fn prompt(task: &Value, identifier: &str, peers: &[Value], reuse: bool) -> String {
    let task_id = task["id"].as_str().unwrap_or("");
    let panel = task["identifier"].as_str().unwrap_or("");
    let title = task["title"].as_str().unwrap_or("");
    let mut parts=vec![format!("执行 {identifier} 对应的 Panel 议题 {panel}：{title}"),
        format!("先使用 Manage Panel 读取议题 {panel} 的最新描述、全部评论和相关附件，按实际工作判断适用阶段；通过 panelctl workflow get <阶段> --project PROJECT_ID --json 读取当前配置，PROJECT_ID 使用 issue get 返回的 task.projectId。遵循返回的适用条件、提示词、固定规则及 Skill 路径。"),
        format!("通过 panelctl issue planning get {task_id} --json 读取已保存的 Spec；需要先规划时进入 planning，保存方案不代表授权实现。"),
        "纯调研、解释或结论报告不启用实现与代码审核 Skill：核实来源、结论依据和未确定事项后交付。只有获授权的实现工作才进入 execution；本次涉及代码修改或用户明确要求代码审核时才进入 review。配置本身不扩大任务授权。".into(),
        "只处理当前已授权议题，复用当前执行对话。完成适用阶段和必要验证后记录结果并移动到 in_review；需要用户输入或无法继续时记录原因并移动到 blocked。不自动标记 done。".into(),
        if identifier==panel{format!("创建分支时使用任务标识 {identifier}。")}else{format!("创建分支时使用 Jira 标识 {identifier}，不要使用 Panel Issue 标识 {panel}。")}];
    if peers.len() > 1 {
        parts.push(format!("同仓库共享执行组的议题：{}。共用当前执行对话、分支和工作树，按依赖顺序逐项处理；每张议题独立绑定、记录进度和审核结果。本轮只处理 {panel}，后续议题由队列继续派发；不要执行尚未授权的 backlog 议题。",peers.iter().map(|p|format!("{}（{}）",p["identifier"].as_str().unwrap_or(""),p["status"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("、")));
    }
    if reuse {
        parts.push(
            "继续使用当前会话已有的分支和工作树，不要重新创建分支、工作树或执行对话。".into(),
        );
    }
    parts.join("\n\n")
}

pub async fn prepare_manual(
    state: &AppState,
    id: &str,
    use_worktree: bool,
) -> Result<Value, ApiError> {
    let task = get_task(state, id)?;
    state.db("assertIssueExecutionAllowed", &[json!(id)])?;
    let claim = state.db("getClaimQueueItem", &[json!(id)])?;
    if !task["archivedAt"].is_null()
        || task["source"] != "local"
        || !(task["status"] == "todo"
            || (task["status"] == "blocked" && !claim["lastError"].is_null()))
        || ["queued", "retry_wait", "running"].contains(&claim["state"].as_str().unwrap_or(""))
    {
        return Err(ApiError::new(
            409,
            "CLAIM_TASK_STATUS",
            "Only waiting issues can prepare execution",
        ));
    }
    let peers = peers(state, &task)?;
    if !available(state, &task, &peers)? {
        return Err(ApiError::new(
            409,
            "CLAIM_THREAD_BUSY",
            "共享执行对话正在处理其他议题，或依赖尚未完成",
        ));
    }
    let owner = owner(state, &task)?;
    let prepared = if let Some(owner) = &owner {
        json!({"workspacePath":owner["threadBinding"]["workspacePath"],"codexProjectId":owner["threadBinding"]["codexProjectId"]})
    } else {
        preparation(state, &task).await?
    };
    let context = state.db("getJiraContext", &[json!(id)])?;
    let identifier = context["jira"]["externalKey"]
        .as_str()
        .or_else(|| task["identifier"].as_str())
        .unwrap_or("");
    Ok(
        json!({"taskId":id,"identifier":identifier,"title":format!("{identifier} · {}",task["title"].as_str().unwrap_or("")),"instruction":format!("{}\n\n执行位置已由用户在准备阶段选择。使用本次 Codex 任务的实际运行目录；需要分支时在该目录内创建，不要另建 worktree 或执行对话。",prompt(&task,identifier,&peers,owner.is_some())),"collaborationMode":"default","autoSubmit":false,"executionPreparation":true,"workspacePath":prepared["workspacePath"],"projectName":prepared["projectName"],"codexProjectId":prepared.get("codexProjectId").unwrap_or(&task["projectId"]),"codexProjectKind":"local","codexHostId":"local","threadBinding":owner.as_ref().map(|v|v["threadBinding"].clone()).unwrap_or(Value::Null),"developmentContext":owner.as_ref().map(|v|v["developmentContext"].clone()).unwrap_or(task["developmentContext"].clone()),"useWorktree":owner.is_none()&&task["developmentContext"].is_null()&&use_worktree,"skillReferences":[{"name":"manage-panel","displayName":"Manage Panel","path":state.config.project_root.join("skills/manage-panel/SKILL.md")}] }),
    )
}

pub async fn reserve(state: &Arc<AppState>) -> Result<Value, ApiError> {
    let _gate = state.claim_gate.lock().await;
    tick(state)?;
    let now = chrono::Utc::now().timestamp_millis();
    let expired = state
        .native_reservations
        .lock()
        .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?
        .values()
        .filter(|v| v["expiresAt"].as_i64().unwrap_or(0) <= now)
        .cloned()
        .collect::<Vec<_>>();
    for reservation in expired {
        fail(
            state,
            reservation["reservationId"].as_str().unwrap_or(""),
            reservation["taskId"].as_str().unwrap_or(""),
            "Codex native claim reservation timed out",
        )?;
    }
    let mut running = HashMap::<String, u64>::new();
    for entry in values(&state.db("listRunningClaims", &[])?) {
        if let Some(id) = entry["task"]["projectId"].as_str() {
            *running.entry(id.into()).or_default() += 1;
        }
    }
    for next in values(&state.db("listReadyClaims", &[])?) {
        let task = &next["task"];
        let id = task["id"].as_str().unwrap_or("");
        let project = task["projectId"].as_str().unwrap_or("");
        if state
            .native_reservations
            .lock()
            .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?
            .contains_key(id)
        {
            continue;
        }
        let peers = peers(state, task)?;
        if !available(state, task, &peers)? {
            continue;
        }
        if running.get(project).copied().unwrap_or(0)
            >= next["policy"]["parallelism"].as_u64().unwrap_or(1)
        {
            continue;
        }
        let mut reservation = json!({"reservationId":uuid::Uuid::new_v4().to_string(),"taskId":id,"projectId":project,"expiresAt":now+10*60_000});
        state
            .native_reservations
            .lock()
            .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?
            .insert(id.into(), reservation.clone());
        let prepared=async{
            emit_claim(state,state.db("markClaimRunning",&[json!(id),json!(true)])?);
            let owner=owner(state,task)?;
            let prepared=if let Some(owner)=&owner{json!({"workspacePath":owner["threadBinding"]["workspacePath"],"codexProjectId":owner["threadBinding"]["codexProjectId"],"useWorktree":false})}else{preparation(state,task).await?};
            reservation["workspacePath"]=prepared["workspacePath"].clone();reservation["threadBinding"]=owner.as_ref().map(|v|v["threadBinding"].clone()).unwrap_or(Value::Null);reservation["developmentContext"]=owner.as_ref().map(|v|v["developmentContext"].clone()).unwrap_or(Value::Null);
            state.native_reservations.lock().map_err(|_|ApiError::new(500,"CLAIM_LOCK","Claim lock was poisoned"))?.insert(id.into(),reservation.clone());
            let context=state.db("getJiraContext",&[json!(id)])?;let identifier=context["jira"]["externalKey"].as_str().or_else(||task["identifier"].as_str()).unwrap_or("");
            let mut response=reservation.clone();
            let extra=json!({"identifier":identifier,"panelIdentifier":task["identifier"],"title":format!("{identifier} · {}",task["title"].as_str().unwrap_or("")),"instruction":prompt(task,identifier,&peers,owner.is_some()),"collaborationMode":"default","workspaceLabel":prepared["workspaceLabel"],"projectName":prepared["projectName"],"codexProjectId":prepared.get("codexProjectId").unwrap_or(&task["projectId"]),"codexProjectKind":"local","codexHostId":"local","autoSubmit":true,"useWorktree":prepared["useWorktree"]!=false,"skillReferences":[{"name":"manage-panel","displayName":"Manage Panel","path":state.config.project_root.join("skills/manage-panel/SKILL.md")}]});
            response.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());Ok::<_,ApiError>(response)
        }.await;
        match prepared {
            Ok(value) => return Ok(value),
            Err(error) => {
                fail(
                    state,
                    reservation["reservationId"].as_str().unwrap_or(""),
                    id,
                    &error.message,
                )?;
            }
        }
    }
    Ok(Value::Null)
}

pub fn bind(
    state: &AppState,
    reservation_id: &str,
    id: &str,
    binding: Value,
    development: Value,
) -> Result<Value, ApiError> {
    let reservation = state
        .native_reservations
        .lock()
        .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?
        .get(id)
        .filter(|v| v["reservationId"] == reservation_id)
        .cloned()
        .ok_or_else(|| {
            ApiError::new(
                409,
                "CLAIM_RESERVATION_EXPIRED",
                "The native claim reservation expired",
            )
        })?;
    if !reservation["threadBinding"].is_null()
        && ["threadId", "codexProjectId", "codexHostId"]
            .iter()
            .any(|key| reservation["threadBinding"][*key] != binding[*key])
    {
        return Err(ApiError::new(
            409,
            "CLAIM_THREAD_CONFLICT",
            "Codex returned a different shared execution conversation",
        ));
    }
    let expected = development
        .get("path")
        .unwrap_or(&reservation["workspacePath"]);
    if binding["workspacePath"] != *expected {
        return Err(ApiError::new(
            409,
            "CLAIM_WORKSPACE_CONFLICT",
            "Codex returned an unexpected execution workspace",
        ));
    }
    let current = get_task(state, id)?;
    let result = if ["in_progress", "in_review", "done"]
        .contains(&current["status"].as_str().unwrap_or(""))
        && current["threadBinding"]["threadId"] == binding["threadId"]
        && current["threadBinding"]["workspacePath"] == binding["workspacePath"]
    {
        state.db("reconcileClaimQueue", &[])?;
        json!({"task":get_task(state,id)?,"claim":state.db("getClaimQueueItem",&[json!(id)])?})
    } else {
        state.db(
            "bindNativeClaim",
            &[
                json!(id),
                binding,
                v::agent_actor(),
                if reservation["developmentContext"].is_null() {
                    development
                } else {
                    reservation["developmentContext"].clone()
                },
            ],
        )?
    };
    state
        .native_reservations
        .lock()
        .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?
        .remove(id);
    state.emit("task.moved", json!({"task":result["task"]}));
    emit_claim(state, result["claim"].clone());
    Ok(result)
}

pub fn fail(
    state: &AppState,
    reservation_id: &str,
    id: &str,
    message: &str,
) -> Result<Value, ApiError> {
    let mut reservations = state
        .native_reservations
        .lock()
        .map_err(|_| ApiError::new(500, "CLAIM_LOCK", "Claim lock was poisoned"))?;
    if !reservations
        .get(id)
        .is_some_and(|v| v["reservationId"] == reservation_id)
    {
        return Ok(Value::Null);
    }
    reservations.remove(id);
    drop(reservations);
    let task = get_task(state, id)?;
    if !task["threadBinding"].is_null()
        && ["in_progress", "in_review", "done"].contains(&task["status"].as_str().unwrap_or(""))
    {
        state.db("reconcileClaimQueue", &[])?;
        let claim = state.db("getClaimQueueItem", &[json!(id)])?;
        emit_claim(state, claim.clone());
        return Ok(claim);
    }
    let claim = state.db("getClaimQueueItem", &[json!(id)])?;
    let transient=regex::Regex::new(r"(?i)(connection|network|timed? out|temporar|rate.?limit|\b429\b|spawn|codex exited|did not provide a thread id)").unwrap().is_match(message);
    if transient && claim["attemptCount"].as_u64().unwrap_or(0) <= 2 {
        if task["status"] == "in_progress" {
            move_task(state, &task, "todo")?;
        }
        let delay = if claim["attemptCount"].as_u64().unwrap_or(1) <= 1 {
            30
        } else {
            120
        };
        let next = state.db(
            "scheduleClaimRetry",
            &[
                json!(id),
                json!(message),
                json!((chrono::Utc::now() + chrono::Duration::seconds(delay)).to_rfc3339()),
            ],
        )?;
        emit_claim(state, next.clone());
        return Ok(next);
    }
    if ["in_progress", "todo"].contains(&task["status"].as_str().unwrap_or("")) {
        move_task(state, &task, "blocked")?;
    }
    let comment = state.db(
        "createComment",
        &[
            json!(id),
            json!({"body":format!("执行派发失败，未确认开始：{message}"),"actor":v::agent_actor()}),
        ],
    )?;
    state.emit(
        "comment.created",
        json!({"comment":comment,"task":get_task(state,id)?}),
    );
    let next = state.db(
        "finishClaim",
        &[json!(id), json!("blocked"), json!(message)],
    )?;
    emit_claim(state, next.clone());
    if next["resumeRequested"] == true {
        enqueue(state, id, "resume")?;
    }
    Ok(next)
}

pub async fn cleanup_completed(state: &AppState, task: Value) -> Result<Value, ApiError> {
    if task["status"] != "done" || task["developmentContext"]["type"] != "worktree" {
        return Ok(task);
    }
    let id = task["id"].as_str().unwrap_or("");
    for peer in values(&state.db("jiraExecutionPeers", &[json!(id)])?)
        .into_iter()
        .chain(values(&state.db("executionContextPeers", &[json!(id)])?))
    {
        if peer["id"] != id && peer["status"] != "done" {
            return Ok(task);
        }
    }
    let Some(path) = task["developmentContext"]["path"].as_str() else {
        return Ok(task);
    };
    let Some(branch) = task["developmentContext"]["branch"]
        .as_str()
        .filter(|branch| branch.starts_with("panel/"))
    else {
        return Ok(task);
    };
    let path = match tokio::fs::canonicalize(path).await {
        Ok(path) => path,
        Err(_) => return Ok(task),
    };
    let root = match tokio::fs::canonicalize(state.config.data_dir.join("worktrees")).await {
        Ok(path) => path,
        Err(_) => return Ok(task),
    };
    // 只清理由旧自动执行流程拥有、任务ID匹配且已合并的干净工作树。
    if path.parent() != Some(root.as_path())
        || path.file_name().and_then(|n| n.to_str()) != Some(id)
    {
        return Ok(task);
    }
    async fn git(path: &std::path::Path, args: &[&str], timeout: u64) -> Option<String> {
        let mut command = tokio::process::Command::new("git");
        command.arg("-C").arg(path).args(args).kill_on_drop(true);
        for (key, _) in std::env::vars() {
            if key.starts_with("CODEX_PANEL_") || key.starts_with("CODEX_TASKBOARD_") {
                command.env_remove(key);
            }
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(timeout), command.output())
                .await
                .ok()?
                .ok()?;
        if result.status.success() {
            Some(String::from_utf8_lossy(&result.stdout).into_owned())
        } else {
            None
        }
    }
    let Some(status) = git(&path, &["status", "--porcelain"], 10).await else {
        return Ok(task);
    };
    if !status.trim().is_empty() {
        return Ok(task);
    }
    let Some(list) = git(&path, &["worktree", "list", "--porcelain"], 10).await else {
        return Ok(task);
    };
    let Some(repository) = list
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(std::path::PathBuf::from)
    else {
        return Ok(task);
    };
    let mut merged = false;
    for target in ["refs/remotes/origin/main", "refs/heads/main"] {
        if git(&repository, &["show-ref", "--verify", target], 10)
            .await
            .is_some()
            && git(
                &repository,
                &["merge-base", "--is-ancestor", branch, target],
                10,
            )
            .await
            .is_some()
        {
            merged = true;
            break;
        }
    }
    if !merged
        || git(
            &repository,
            &["worktree", "remove", path.to_str().unwrap_or("")],
            30,
        )
        .await
        .is_none()
    {
        return Ok(task);
    }
    let current = get_task(state, id)?;
    if current["status"] != "done" || current["developmentContext"] != task["developmentContext"] {
        return Ok(current);
    }
    state.db(
        "updateTask",
        &[
            json!(id),
            current["version"].clone(),
            json!({"developmentContext":null}),
            undefined(),
            undefined(),
            v::agent_actor(),
        ],
    )
}
