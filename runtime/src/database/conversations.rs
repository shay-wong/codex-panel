use super::*;

fn run_row(row: &Value) -> Value {
    if row.is_null() {
        Value::Null
    } else {
        fields(
            row,
            "id thread_id status exit_code error started_at finished_at",
        )
    }
}
fn event_row(row: &Value) -> Result<Value, ApiError> {
    if row.is_null() {
        return Ok(Value::Null);
    }
    let mut out = fields(row, "id thread_id run_id type role content created_at");
    out["data"] = parse_json(&row["data"])?;
    Ok(out)
}
fn todo_progress(row: &Value) -> Option<Value> {
    let data = parse_json(&row["data"]).ok()?;
    let detail = if data["detail"].is_string() {
        parse_json(&data["detail"]).ok()?
    } else {
        data["detail"].clone()
    };
    let items: Vec<_> = detail
        .as_array()?
        .iter()
        .filter(|v| {
            v["text"]
                .as_str()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();
    if items.is_empty() {
        return None;
    }
    Some(
        json!({"completed":items.iter().filter(|i|i["completed"]==true).count(),"total":items.len(),"eventId":row["id"],"updatedAt":row["created_at"]}),
    )
}
impl Database {
    pub(super) fn ai_thread(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get("SELECT * FROM ai_chat_threads WHERE id=?", &[id.clone()])?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        let mut out=fields(&row,"id title status purpose codex_thread_id model reasoning_effort sandbox archived_at created_at updated_at");
        out["purpose"] = fallback(&out["purpose"], json!("temporary"));
        let mut origin=fields(&row,"origin_project_id:projectId origin_project_name:projectName origin_workspace_path:workspacePath");
        for (source, destination) in [
            ("origin_codex_project_id", "codexProjectId"),
            ("origin_codex_project_kind", "codexProjectKind"),
            ("origin_codex_host_id", "codexHostId"),
            ("origin_issue_id", "issueId"),
            ("origin_issue_identifier", "issueIdentifier"),
        ] {
            if truth(&row[source]) {
                origin[destination] = row[source].clone();
            }
        }
        out["origin"] = origin;
        let current=self.get("SELECT * FROM ai_chat_runs WHERE thread_id=? AND status='running' ORDER BY started_at DESC,id DESC LIMIT 1",&[id.clone()])?;
        out["currentRun"] = run_row(&current);
        out["latestTodo"] = Value::Null;
        for event in self.all("SELECT id,thread_id,run_id,data,created_at FROM ai_chat_events WHERE thread_id=? AND type='todo_list' ORDER BY created_at DESC,rowid DESC",&[id.clone()])?{if !current.is_null()&&current["id"]!=event["run_id"]{continue;}if let Some(progress)=todo_progress(&event){out["latestTodo"]=progress;break;}}
        Ok(out)
    }
    pub(super) fn ai_run(&self, id: &Value) -> Result<Value, ApiError> {
        Ok(run_row(&self.get(
            "SELECT * FROM ai_chat_runs WHERE id=?",
            &[id.clone()],
        )?))
    }
    pub(super) fn interrupt_abandoned_ai_chat_runs(&self) -> Result<Value, ApiError> {
        self.transaction(||{let t=now();let n=self.run("UPDATE ai_chat_runs SET status='interrupted',error=COALESCE(error,'Panel service restarted'),finished_at=COALESCE(finished_at,?) WHERE status='running'",&[t.clone()])?;if n>0{self.run("UPDATE ai_chat_threads SET status='idle',updated_at=? WHERE status='running' AND NOT EXISTS(SELECT 1 FROM ai_chat_runs WHERE ai_chat_runs.thread_id=ai_chat_threads.id AND ai_chat_runs.status='running')",&[t])?;}Ok(json!(n))})
    }
    pub(super) fn archive_completed_jira_threads(
        &self,
        timestamp: &Value,
        jira_id: &Value,
        manual: bool,
    ) -> Result<(), ApiError> {
        if !manual && !truth(&self.jira_settings()?["autoArchiveEnabled"]) {
            return Ok(());
        }
        let ids = if jira_id.is_null() {
            self.all(
                "SELECT id FROM tasks WHERE external_source='jira' AND status='done'",
                &[],
            )?
            .iter()
            .map(|r| r["id"].clone())
            .collect()
        } else {
            vec![jira_id.clone()]
        };
        for id in ids {
            if !truth(&self.jira_conversation_archive(&id)?["eligible"]) {
                continue;
            }
            self.run("UPDATE ai_chat_threads SET archived_at=?,updated_at=? WHERE archived_at IS NULL AND id IN(SELECT thread_id FROM jira_plan_threads WHERE jira_task_id=? UNION SELECT items.thread_id FROM jira_simple_start_operations AS operations JOIN jira_simple_start_items AS items ON items.operation_id=operations.id WHERE operations.jira_task_id=? UNION SELECT queue.thread_id FROM jira_task_links AS links JOIN issue_claim_queue AS queue ON queue.task_id=links.task_id WHERE links.jira_task_id=? AND queue.thread_id IS NOT NULL UNION SELECT attempts.thread_id FROM jira_task_links AS links JOIN issue_claim_attempts AS attempts ON attempts.task_id=links.task_id WHERE links.jira_task_id=? UNION SELECT thread_id FROM jira_rework_items WHERE jira_task_id=?)",&[timestamp.clone(),timestamp.clone(),id.clone(),id.clone(),id.clone(),id.clone(),id])?;
        }
        Ok(())
    }
    pub(super) fn ai_project_conflict(
        &self,
        reference: &Value,
        project: &Value,
    ) -> Result<bool, ApiError> {
        Ok(!self.get("SELECT 1 FROM ai_chat_threads WHERE(origin_issue_id=? OR origin_issue_identifier=?) AND origin_project_id!=? LIMIT 1",&[reference.clone(),reference.clone(),project.clone()])?.is_null())
    }
    pub(super) fn call_conversations(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "listAiChatThreads",
            "getAiChatThread",
            "hasAiChatThreadProjectConflict",
            "createAiChatThread",
            "updateAiChatThread",
            "deleteAiChatThread",
            "listAiChatRuns",
            "getAiChatRun",
            "createAiChatRun",
            "updateAiChatRun",
            "insertAiChatEvent",
            "getAiChatEvent",
            "listAiChatEvents",
            "interruptAbandonedAiChatRuns",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            match method{
            "listAiChatThreads"=>Ok(Value::Array(self.all("SELECT id FROM ai_chat_threads WHERE archived_at IS NULL OR status='running' ORDER BY updated_at DESC,id",&[])?.iter().map(|r|self.ai_thread(&r["id"])).collect::<Result<_,_>>()?)),
            "getAiChatThread"=>self.ai_thread(&a),
            "hasAiChatThreadProjectConflict"=>Ok(json!(self.ai_project_conflict(&a,&b)?)),
            "createAiChatThread"=>{let id=fallback(&a["id"],id());let t=fallback(&a["createdAt"],now());self.run("INSERT INTO ai_chat_threads(id,title,status,purpose,origin_project_id,origin_project_name,origin_workspace_path,origin_codex_project_id,origin_codex_project_kind,origin_codex_host_id,origin_issue_id,origin_issue_identifier,codex_thread_id,model,reasoning_effort,sandbox,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",&[id.clone(),a["title"].clone(),fallback(&a["status"],json!("idle")),fallback(&a["purpose"],json!("temporary")),a["origin"]["projectId"].clone(),a["origin"]["projectName"].clone(),a["origin"]["workspacePath"].clone(),a["origin"]["codexProjectId"].clone(),a["origin"]["codexProjectKind"].clone(),a["origin"]["codexHostId"].clone(),a["origin"]["issueId"].clone(),a["origin"]["issueIdentifier"].clone(),a["codexThreadId"].clone(),a["model"].clone(),a["reasoningEffort"].clone(),a["sandbox"].clone(),t.clone(),fallback(&a["updatedAt"],t)])?;self.ai_thread(&id)},
            "updateAiChatThread"=>{let current=self.ai_thread(&a)?;if current.is_null(){return Err(ApiError::new(404,"AI_CHAT_THREAD_NOT_FOUND",format!("AI chat thread '{}' does not exist",text(&a))));}let mut assignments=Vec::new();let mut values=Vec::new();for(key,col)in[("title","title"),("status","status"),("originIssueId","origin_issue_id"),("originIssueIdentifier","origin_issue_identifier"),("codexThreadId","codex_thread_id"),("model","model"),("reasoningEffort","reasoning_effort"),("sandbox","sandbox")]{if let Some(v)=b.get(key){assignments.push(format!("{col}=?"));values.push(v.clone());}}if assignments.is_empty(){return Ok(current);}assignments.push("updated_at=?".into());values.extend([fallback(&b["updatedAt"],now()),a.clone()]);self.run(&format!("UPDATE ai_chat_threads SET {} WHERE id=?",assignments.join(",")),&values)?;self.ai_thread(&a)},
            "deleteAiChatThread"=>{let current=self.ai_thread(&a)?;if current.is_null(){return Err(ApiError::new(404,"AI_CHAT_THREAD_NOT_FOUND",format!("AI chat thread '{}' does not exist",text(&a))));}self.run("DELETE FROM ai_chat_threads WHERE id=?",&[a])?;Ok(current)},
            "listAiChatRuns"=>Ok(Value::Array(self.all("SELECT * FROM ai_chat_runs WHERE thread_id=? ORDER BY started_at,id",&[a])?.iter().map(run_row).collect())),
            "getAiChatRun"=>self.ai_run(&a),
            "createAiChatRun"=>{if truth(&self.ai_thread(&a["threadId"])?["archivedAt"]){return Err(ApiError::new(409,"AI_CHAT_THREAD_ARCHIVED","Cannot continue an archived conversation"));}let id=fallback(&a["id"],id());let t=fallback(&a["startedAt"],now());let status=fallback(&a["status"],json!("running"));self.transaction(||{self.run("INSERT INTO ai_chat_runs(id,thread_id,status,exit_code,error,started_at,finished_at) VALUES(?,?,?,?,?,?,?)",&[id.clone(),a["threadId"].clone(),status.clone(),a["exitCode"].clone(),a["error"].clone(),t.clone(),a["finishedAt"].clone()])?;if status=="running"{self.run("UPDATE ai_chat_threads SET status='running',updated_at=? WHERE id=?",&[t,a["threadId"].clone()])?;}Ok(())})?;self.ai_run(&id)},
            "updateAiChatRun"=>{let current=self.ai_run(&a)?;if current.is_null(){return Err(ApiError::new(404,"AI_CHAT_RUN_NOT_FOUND",format!("AI chat run '{}' does not exist",text(&a))));}let mut assignments=Vec::new();let mut values=Vec::new();for(key,col)in[("status","status"),("exitCode","exit_code"),("error","error"),("finishedAt","finished_at")]{if let Some(v)=b.get(key){assignments.push(format!("{col}=?"));values.push(v.clone());}}if assignments.is_empty(){return Ok(current);}self.transaction(||{values.push(a.clone());self.run(&format!("UPDATE ai_chat_runs SET {} WHERE id=?",assignments.join(",")),&values)?;let status=fallback(&b["status"],current["status"].clone());if status!="running"{self.run("UPDATE ai_chat_threads SET status=?,updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM ai_chat_runs WHERE thread_id=? AND status='running')",&[json!(if status=="failed"{"failed"}else{"idle"}),fallback(&b["finishedAt"],now()),current["threadId"].clone(),current["threadId"].clone()])?;}Ok(())})?;self.ai_run(&a)},
            "insertAiChatEvent"=>{let id=fallback(&a["id"],id());self.run("INSERT INTO ai_chat_events(id,thread_id,run_id,type,role,content,data,created_at) VALUES(?,?,?,?,?,?,?,?)",&[id.clone(),a["threadId"].clone(),a["runId"].clone(),a["type"].clone(),a["role"].clone(),a["content"].clone(),json_text(&a["data"]),fallback(&a["createdAt"],now())])?;event_row(&self.get("SELECT * FROM ai_chat_events WHERE id=?",&[id])?)},
            "getAiChatEvent"=>event_row(&self.get("SELECT * FROM ai_chat_events WHERE id=?",&[a])?),
            "listAiChatEvents"=>Ok(Value::Array(self.all("SELECT * FROM ai_chat_events WHERE thread_id=? ORDER BY created_at,rowid",&[a])?.iter().map(event_row).collect::<Result<_,_>>()?)),
            "interruptAbandonedAiChatRuns"=>self.interrupt_abandoned_ai_chat_runs(),
            _=>unreachable!()
        }
        })())
    }
}
