use super::*;

const PROJECT_QUERY:&str="SELECT projects.*,COUNT(tasks.id) AS issue_count FROM projects LEFT JOIN tasks ON tasks.project_id=projects.id AND tasks.archived_at IS NULL";
impl Database {
    pub(super) fn get_project(&self, id: &Value) -> Result<Value, ApiError> {
        rows::project(&self.get(
            &format!("{PROJECT_QUERY} WHERE projects.id=? GROUP BY projects.id"),
            &[id.clone()],
        )?)
    }
    pub(super) fn require_project(&self, id: &Value) -> Result<Value, ApiError> {
        let p = self.get_project(id)?;
        if p.is_null() {
            Err(missing("Project", id))
        } else {
            Ok(p)
        }
    }
    fn project_summary(&self, id: &Value) -> Result<Value, ApiError> {
        let r = self.get(
            "SELECT * FROM project_summaries WHERE project_id=?",
            &[id.clone()],
        )?;
        if r.is_null() {
            Ok(
                json!({"projectId":id,"summary":null,"generatedAt":null,"attemptedAt":null,"error":null,"failureCount":0}),
            )
        } else {
            Ok(fields(
                &r,
                "project_id summary generated_at attempted_at error failure_count",
            ))
        }
    }
    fn project_readme(&self, id: &Value) -> Result<Value, ApiError> {
        self.require_project(id)?;
        let r = self.get(
            "SELECT * FROM project_readmes WHERE project_id=?",
            &[id.clone()],
        )?;
        if r.is_null() {
            Ok(json!({"projectId":id,"content":"","version":0,"createdAt":null,"updatedAt":null}))
        } else {
            Ok(fields(
                &r,
                "project_id content version created_at updated_at",
            ))
        }
    }
    pub(super) fn automation_settings(&self) -> Result<Value, ApiError> {
        let r = self.get(
            "SELECT default_project_parallelism FROM automation_settings WHERE id=1",
            &[],
        )?;
        Ok(
            json!({"defaultProjectParallelism":fallback(&r["default_project_parallelism"],json!(3))}),
        )
    }
    pub(super) fn project_automation_policy(&self, id: &Value) -> Result<Value, ApiError> {
        self.require_project(id)?;
        let r = self.get(
            "SELECT * FROM project_automation_policies WHERE project_id=?",
            &[id.clone()],
        )?;
        let mut counts = HashMap::new();
        for row in self.all("SELECT state,COUNT(*) AS count FROM issue_claim_queue WHERE project_id=? GROUP BY state",&[id.clone()])?{counts.insert(text(&row["state"]).to_owned(),row["count"].as_i64().unwrap_or_default());}
        let default = self.automation_settings()?["defaultProjectParallelism"].clone();
        let active = truth(&r["enabled_by_user"]) && !truth(&r["paused"]);
        Ok(
            json!({"projectId":id,"status":if active {"ACTIVE"}else{"PAUSED"},"enabledByUser":truth(&r["enabled_by_user"]),"paused":truth(&r["paused"]),"intervalMinutes":fallback(&r["interval_minutes"],json!(5)),"model":fallback(&r["model"],json!("gpt-5.5")),"reasoningEffort":fallback(&r["reasoning_effort"],json!("high")),"defaultParallelism":default,"parallelismOverride":r["parallelism_override"],"parallelism":fallback(&r["parallelism_override"],default.clone()),"nextScanAt":r["next_scan_at"],"queue":{"queued":counts.get("queued").unwrap_or(&0)+counts.get("retry_wait").unwrap_or(&0),"running":counts.get("running").unwrap_or(&0),"blocked":counts.get("blocked").unwrap_or(&0),"failed":counts.get("failed").unwrap_or(&0)},"updatedAt":r["updated_at"]}),
        )
    }
    pub(super) fn call_projects(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "listProjects",
            "getProject",
            "createProject",
            "migrateProjectIssueKey",
            "ensureJiraProject",
            "deleteProject",
            "getProjectSummary",
            "listProjectSummaries",
            "saveProjectSummary",
            "saveProjectSummaryError",
            "getProjectReadme",
            "saveProjectReadme",
            "createProjectReadmeAttachment",
            "getProjectReadmeAttachment",
            "getProjectAutomationPolicy",
            "saveProjectAutomationPolicy",
            "getAutomationSettings",
            "saveAutomationSettings",
            "addProjectLabel",
            "deleteProjectLabel",
            "getWorkflowSettings",
            "saveWorkflowSettings",
            "listActiveJiraTasks",
            "getJiraSyncState",
            "recordJiraSyncAttempt",
            "recordJiraSyncSuccess",
            "markJiraSyncError",
            "getJiraSettings",
            "saveJiraSettings",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            match method{
            "listProjects"=>self.all(&format!("{PROJECT_QUERY} GROUP BY projects.id ORDER BY projects.created_at,projects.id"),&[])?.iter().map(rows::project).collect::<Result<Vec<_>,_>>().map(Value::Array),
            "getProject"=>self.get_project(&a),
            "createProject"|"ensureJiraProject"=>{
                let input=if method=="ensureJiraProject"{json!({"id":"jira-my-tasks","name":a})}else{a};let id=input["id"].clone();
                let existing=self.get("SELECT issue_key FROM projects WHERE id=?",&[id.clone()])?;
                let keys=self.all("SELECT issue_key FROM projects WHERE issue_key IS NOT NULL",&[])?.iter().map(|r|text(&r["issue_key"]).to_owned()).collect();
                let key=fallback(&input["issueKey"],fallback(&existing["issue_key"],json!(schema::issue_key(&input,&keys))));let timestamp=now();
                let conflict=if method=="ensureJiraProject"{" ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at"}else{""};
                if let Err(error)=self.run(&format!("INSERT INTO projects(id,name,issue_key,workspace_path,labels,next_task_number,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?){conflict}"),&[id.clone(),input["name"].clone(),key.clone(),input["workspacePath"].clone(),json!(schema::labels().to_string()),timestamp.clone(),timestamp]){if error.message.contains("projects.issue_key"){return Err(ApiError::new(409,"PROJECT_ISSUE_KEY_EXISTS",format!("Project Key '{}' already exists",text(&key))));}if error.message.contains("UNIQUE constraint failed"){return Err(ApiError::new(409,"PROJECT_EXISTS",format!("Project '{}' already exists",text(&id))));}return Err(error);}self.get_project(&id)
            },
            "migrateProjectIssueKey"=>{
                let key=text(&b).trim().to_uppercase();if key.is_empty()||key.len()>32||!regex::Regex::new(r"^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$").unwrap().is_match(&key){return Err(ApiError::new(400,"INVALID_FIELD","'issueKey' must contain 1-32 letters, numbers or single internal hyphens or dots"));}if a=="jira-my-tasks"{return Err(ApiError::new(403,"PROJECT_ISSUE_KEY_MIGRATION_FORBIDDEN","The Jira project Key cannot be migrated"));}
                let migrated=self.transaction(||{self.require_project(&a)?;let timestamp=now();self.run("UPDATE projects SET issue_key=?,updated_at=? WHERE id=? AND issue_key!=?",&[json!(key),timestamp.clone(),a.clone(),json!(key)])?;
                    let n=self.run("UPDATE tasks SET identifier=?||'-'||substr(identifier,length(rtrim(identifier,'0123456789'))+1),version=version+1,updated_at=? WHERE project_id=? AND external_source IS NULL AND identifier GLOB '*-[0-9]*' AND substr(identifier,length(rtrim(identifier,'0123456789')),1)='-' AND substr(identifier,1,length(rtrim(identifier,'0123456789'))-1)!=? AND NOT EXISTS(SELECT 1 FROM task_activities,json_each(task_activities.changes) WHERE task_activities.task_id=tasks.id AND json_extract(json_each.value,'$.field')='projectId')",&[json!(key),timestamp,a.clone(),json!(key)])?;
                    self.run("UPDATE ai_chat_threads SET origin_issue_identifier=(SELECT tasks.identifier FROM tasks WHERE tasks.id=ai_chat_threads.origin_issue_id) WHERE origin_project_id=? AND origin_issue_id IN(SELECT id FROM tasks WHERE project_id=?)",&[a.clone(),a.clone()])?;Ok(n)}).map_err(|error|{if error.message.contains("projects.issue_key"){ApiError::new(409,"PROJECT_ISSUE_KEY_EXISTS",format!("Project Key '{key}' already exists"))}else if error.message.contains("tasks.identifier"){ApiError::new(409,"PROJECT_ISSUE_IDENTIFIER_EXISTS",format!("Project Key '{key}' conflicts with an existing Issue identifier"))}else{error}})?;
                Ok(json!({"project":self.get_project(&a)?,"migratedIssueCount":migrated}))
            },
            "deleteProject"=>{let project=self.require_project(&a)?;if !text(&a).starts_with("temp-"){return Err(ApiError::new(403,"PROJECT_DELETE_FORBIDDEN","Only manually created projects can be deleted"));}if self.run("DELETE FROM projects WHERE id=? AND NOT EXISTS(SELECT 1 FROM tasks WHERE project_id=?)",&[a.clone(),a.clone()])?!=1{let count=self.get("SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id=?",&[a])?["issue_count"].clone();return Err(ApiError::new(409,"PROJECT_NOT_EMPTY","Project still contains issues").with_details(json!({"issueCount":count})));}Ok(project)},
            "getProjectSummary"=>self.project_summary(&a),
            "listProjectSummaries"=>Ok(Value::Array(self.all("SELECT * FROM project_summaries ORDER BY project_id",&[])?.iter().map(|r|fields(r,"project_id summary generated_at attempted_at error failure_count")).collect())),
            "saveProjectSummary"=>{let t=now();self.run("INSERT INTO project_summaries(project_id,summary,generated_at,attempted_at,error,failure_count) VALUES(?,?,?,?,NULL,0) ON CONFLICT(project_id) DO UPDATE SET summary=excluded.summary,generated_at=excluded.generated_at,attempted_at=excluded.attempted_at,error=NULL,failure_count=0",&[a.clone(),b,t.clone(),t])?;self.project_summary(&a)},
            "saveProjectSummaryError"=>{self.run("INSERT INTO project_summaries(project_id,summary,generated_at,attempted_at,error,failure_count) VALUES(?,NULL,NULL,?,?,1) ON CONFLICT(project_id) DO UPDATE SET attempted_at=excluded.attempted_at,error=excluded.error,failure_count=project_summaries.failure_count+1",&[a.clone(),now(),b])?;self.project_summary(&a)},
            "getProjectReadme"=>self.project_readme(&a),
            "saveProjectReadme"=>{self.transaction(||{let current=self.project_readme(&a)?;if let Some(expected)=optional(args,2).filter(|v|!v.is_null()){if current["version"]!=*expected{return Err(ApiError::new(409,"VERSION_CONFLICT","Project README changed since it was last read").with_details(json!({"expectedVersion":expected,"actualVersion":current["version"]})));}}let t=now();self.run("INSERT INTO project_readmes(project_id,content,version,created_at,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(project_id) DO UPDATE SET content=excluded.content,version=project_readmes.version+1,updated_at=excluded.updated_at",&[a.clone(),b.clone(),t.clone(),t])?;Ok(())})?;self.project_readme(&a)},
            "createProjectReadmeAttachment"=>{self.require_project(&a)?;self.run("INSERT INTO project_readme_attachments(id,project_id,filename,content_type,size,created_at) VALUES(?,?,?,?,?,?)",&[b["id"].clone(),a,b["filename"].clone(),b["contentType"].clone(),b["size"].clone(),now()])?;self.readme_attachment(&b["id"])},
            "getProjectReadmeAttachment"=>self.readme_attachment(&a),
            "getAutomationSettings"=>self.automation_settings(),
            "saveAutomationSettings"=>{self.run("INSERT INTO automation_settings(id,default_project_parallelism,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET default_project_parallelism=excluded.default_project_parallelism,updated_at=excluded.updated_at",&[a,fallback(&b,now())])?;self.automation_settings()},
            "getProjectAutomationPolicy"=>self.project_automation_policy(&a),
            "saveProjectAutomationPolicy"=>{let current=self.project_automation_policy(&a)?;let t=now();let default=fallback(&b["defaultParallelism"],current["defaultParallelism"].clone());let over=b.get("parallelismOverride").cloned().unwrap_or_else(||current["parallelismOverride"].clone());self.run("INSERT INTO automation_settings(id,default_project_parallelism,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET default_project_parallelism=excluded.default_project_parallelism,updated_at=excluded.updated_at",&[default,t.clone()])?;let starts=truth(&b["enabledByUser"])&&!truth(&b["paused"])&&(!truth(&current["enabledByUser"])||truth(&current["paused"])||current["intervalMinutes"]!=b["intervalMinutes"]);self.run("INSERT INTO project_automation_policies(project_id,enabled_by_user,paused,interval_minutes,model,reasoning_effort,parallelism_override,next_scan_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled_by_user=excluded.enabled_by_user,paused=excluded.paused,interval_minutes=excluded.interval_minutes,model=excluded.model,reasoning_effort=excluded.reasoning_effort,parallelism_override=excluded.parallelism_override,next_scan_at=excluded.next_scan_at,updated_at=excluded.updated_at",&[a.clone(),json!(truth(&b["enabledByUser"])),json!(truth(&b["paused"])),b["intervalMinutes"].clone(),b["model"].clone(),b["reasoningEffort"].clone(),over,if starts{t.clone()}else{current["nextScanAt"].clone()},fallback(&current["updatedAt"],t.clone()),t])?;self.project_automation_policy(&a)},
            "addProjectLabel"|"deleteProjectLabel"=>{self.transaction(||{let p=self.require_project(&a)?;let mut labels=array(&p["labels"]);let t=now();if method=="addProjectLabel"{if !labels.contains(&b){labels.push(b.clone());}}else{labels.retain(|v|v!=&b);for task in self.all("SELECT id,labels FROM tasks WHERE project_id=?",&[a.clone()])?{let mut items=array(&parse_json(&task["labels"])?);if items.contains(&b){items.retain(|v|v!=&b);self.run("UPDATE tasks SET labels=?,version=version+1,updated_at=? WHERE id=?",&[json!(Value::Array(items).to_string()),t.clone(),task["id"].clone()])?;}}}if labels!=array(&p["labels"]){self.run("UPDATE projects SET labels=?,updated_at=? WHERE id=?",&[json!(Value::Array(labels).to_string()),t,a.clone()])?;}Ok(())})?;self.get_project(&a)},
            "getWorkflowSettings"=>{let r=self.get("SELECT settings FROM workflow_settings WHERE id=1",&[])?;if r.is_null(){Ok(json!({"planning":[],"execution":[],"review":[],"handoff":[]}))}else{parse_json(&r["settings"])}},
            "saveWorkflowSettings"=>{self.run("INSERT INTO workflow_settings(id,settings) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings",&[json!(a.to_string())])?;Ok(a)},
            "listActiveJiraTasks"=>Ok(Value::Array(self.all("SELECT id,external_id AS externalId,external_key AS externalKey FROM tasks WHERE external_source='jira' AND external_origin=? AND archived_at IS NULL AND external_key IS NOT NULL ORDER BY created_at,id",&[a])?)),
            "getJiraSyncState"=>{let r=self.get("SELECT * FROM jira_sync_state WHERE id=1",&[])?;Ok(json!({"lastAttemptedAt":r["attempted_at"],"lastSuccessfulAt":r["succeeded_at"],"syncedIssueCount":fallback(&r["issue_count"],json!(0)),"unknownIssueCount":fallback(&r["unknown_issue_count"],json!(0)),"syncError":if truth(&r["error_message"]){json!({"code":fallback(&r["error_code"],json!("JIRA_SYNC_FAILED")),"message":r["error_message"]})}else{Value::Null}}))},
            "recordJiraSyncAttempt"=>{self.run("INSERT INTO jira_sync_state(id,attempted_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at",&[fallback(&a,now())])?;Ok(Value::Null)},
            "recordJiraSyncSuccess"=>{self.run("INSERT INTO jira_sync_state(id,attempted_at,succeeded_at,issue_count,unknown_issue_count,error_code,error_message) VALUES(1,?,?,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,succeeded_at=excluded.succeeded_at,issue_count=excluded.issue_count,unknown_issue_count=excluded.unknown_issue_count,error_code=NULL,error_message=NULL",&[a["attemptedAt"].clone(),a["succeededAt"].clone(),a["issueCount"].clone(),a["unknownIssueCount"].clone()])?;Ok(Value::Null)},
            "markJiraSyncError"=>{let message=json!(text(&a).chars().take(1000).collect::<String>());let code=json!(text(&fallback(&b,json!("JIRA_SYNC_FAILED"))).chars().take(120).collect::<String>());self.run("INSERT INTO jira_sync_state(id,attempted_at,error_code,error_message) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,error_code=excluded.error_code,error_message=excluded.error_message",&[fallback(&arg(args,2),now()),code,message.clone()])?;self.run("UPDATE tasks SET external_sync_error=? WHERE external_source='jira' AND archived_at IS NULL",&[message])?;Ok(Value::Null)},
            "getJiraSettings"=>self.jira_settings(),
            "saveJiraSettings"=>{self.transaction(||{let t=now();self.run("INSERT INTO jira_settings(id,auto_complete_enabled,auto_archive_enabled,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET auto_complete_enabled=excluded.auto_complete_enabled,auto_archive_enabled=excluded.auto_archive_enabled,updated_at=excluded.updated_at",&[json!(truth(&a["autoCompleteEnabled"])),json!(truth(&a["autoArchiveEnabled"])),t.clone()])?;if !truth(&a["autoCompleteEnabled"]){self.run("UPDATE jira_auto_completions SET state='dismissed',error_code=NULL,error_message=NULL,updated_at=? WHERE state IN('queued','retry_wait')",&[t.clone()])?;}if truth(&a["autoArchiveEnabled"]){self.archive_completed_jira_threads(&t,&Value::Null,false)?;}Ok(())})?;self.jira_settings()},
            _=>unreachable!()
        }
        })())
    }
    pub(super) fn jira_settings(&self) -> Result<Value, ApiError> {
        let r = self.get(
            "SELECT auto_complete_enabled,auto_archive_enabled FROM jira_settings WHERE id=1",
            &[],
        )?;
        Ok(
            json!({"autoCompleteEnabled":truth(&r["auto_complete_enabled"]),"autoArchiveEnabled":truth(&r["auto_archive_enabled"])}),
        )
    }
    fn readme_attachment(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(
            "SELECT * FROM project_readme_attachments WHERE id=?",
            &[id.clone()],
        )?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        let mut out = fields(&row, "id project_id filename content_type size created_at");
        out["kind"] = json!("inline");
        Ok(out)
    }
}
