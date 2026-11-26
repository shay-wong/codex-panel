use super::*;
#[path = "claims_sql.rs"]
mod sql;
fn rank(source: &Value) -> Option<u8> {
    match text(source) {
        "manual" => Some(0),
        "resume" => Some(1),
        "jira" | "scan" => Some(2),
        _ => None,
    }
}
fn blocks_automatic_claim(labels: &Value) -> bool {
    array(labels).iter().any(|label| {
        matches!(
            text(label).trim().to_ascii_lowercase().as_str(),
            "ssh-import" | "no-auto-claim"
        )
    })
}
fn attempt(row: &Value) -> Value {
    if row.is_null() {
        Value::Null
    } else {
        fields(
            row,
            "id task_id thread_id run_id status error started_at finished_at",
        )
    }
}
impl Database {
    pub(super) fn claim_item(&self, task: &Value) -> Result<Value, ApiError> {
        Ok(rows::claim(&self.get(
            "SELECT * FROM issue_claim_queue WHERE task_id=?",
            &[task.clone()],
        )?))
    }
    pub(super) fn enqueue_claim(
        &self,
        task: &Value,
        source: &Value,
        available: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(task)?;
        if task["source"] == "jira" || !task["archivedAt"].is_null() {
            return Err(ApiError::new(
                409,
                "CLAIM_TASK_UNAVAILABLE",
                "Only active Panel issues can be queued",
            ));
        }
        let current = self.claim_item(&task["id"])?;
        if !matches!(text(&task["status"]), "todo" | "blocked") {
            if current["state"] == "running" {
                return Ok(current);
            }
            return Err(ApiError::new(
                409,
                "CLAIM_TASK_STATUS",
                "Only waiting or blocked issues can be queued",
            ));
        }
        let source_rank = rank(source).ok_or_else(|| {
            ApiError::new(
                400,
                "INVALID_CLAIM_SOURCE",
                format!("Unknown claim source '{}'", text(source)),
            )
        })?;
        if current["state"] == "running" {
            return Ok(current);
        }
        let pending = matches!(text(&current["state"]), "queued" | "retry_wait");
        let effective = if pending && rank(&current["source"]).unwrap_or(3) <= source_rank {
            current["source"].clone()
        } else {
            source.clone()
        };
        let t = now();
        let enqueued = if pending {
            current["enqueuedAt"].clone()
        } else {
            t.clone()
        };
        self.run(
            sql::ENQUEUE_CLAIM[0],
            &[
                task["id"].clone(),
                task["projectId"].clone(),
                effective,
                available.clone(),
                enqueued,
                t,
            ],
        )?;
        self.claim_item(&task["id"])
    }
    pub(super) fn jira_execution_peers(&self, id: &Value) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        let context = self.jira_context(id)?;
        if context["jira"].is_null() {
            return Ok(json!([]));
        }
        let publication: Vec<Value> = array(&context["plan"]["items"])
            .iter()
            .filter_map(|i| {
                i.get("task")
                    .filter(|v| !v.is_null())
                    .map(|t| t["id"].clone())
            })
            .collect();
        let in_publication = publication.contains(id);
        let mut peers = Vec::new();
        let mut seen = HashSet::new();
        for issue in array(&context["issues"]) {
            if issue["projectId"] != task["projectId"]
                || in_publication && !publication.contains(&issue["id"])
            {
                continue;
            }
            let peer = self.get_task(&issue["id"])?;
            if peer["archivedAt"].is_null()
                && peer["status"] != "canceled"
                && (peer["status"] != "done" || in_publication)
            {
                seen.insert(text(&peer["id"]).to_owned());
                peers.push(peer);
            }
        }
        if in_publication
            && array(&context["sharedExecutionJira"])
                .iter()
                .any(|j| j["id"] == context["jira"]["id"])
        {
            for jira in array(&context["sharedExecutionJira"]) {
                if jira["id"] == context["jira"]["id"] {
                    continue;
                }
                for item in array(&self.jira_plan(&jira["id"])?["items"]) {
                    if item["task"].is_null() {
                        continue;
                    }
                    let peer = self.get_task(&item["task"]["id"])?;
                    if peer["projectId"] == task["projectId"]
                        && peer["archivedAt"].is_null()
                        && peer["status"] != "canceled"
                        && seen.insert(text(&peer["id"]).to_owned())
                    {
                        peers.push(peer);
                    }
                }
            }
        }
        Ok(json!(peers))
    }
    fn ready_claims(&self, at: &Value) -> Result<Value, ApiError> {
        let mut values = Vec::new();
        for row in self.all(sql::LIST_READY_CLAIMS[0], &[at.clone()])? {
            let task = self.get_task(&row["task_id"])?;
            let claim = self.claim_item(&row["task_id"])?;
            if matches!(text(&claim["source"]), "scan" | "jira")
                && blocks_automatic_claim(&task["labels"])
            {
                continue;
            }
            values.push(json!({"policy":self.project_automation_policy(&task["projectId"])?,"task":task,"claim":claim}));
        }
        Ok(json!(values))
    }
    fn enqueue_authorized_jira_claims(&self) -> Result<Value, ApiError> {
        for row in self.all(sql::ENQUEUE_AUTHORIZED_JIRA_CLAIMS[0], &[])? {
            let jira = &row["jira_task_id"];
            if self.jira_lifecycle(jira)?["pending"].is_null()
                && !truth(&self.jira_plan(jira)?["needsReview"])
            {
                self.release_jira_frontier(jira, &json!([]), &now())?;
            }
        }
        let mut queued = Vec::new();
        for row in self.all(sql::ENQUEUE_AUTHORIZED_JIRA_CLAIMS[1], &[])? {
            let task = self.get_task(&row["task_id"])?;
            if blocks_automatic_claim(&task["labels"]) {
                continue;
            }
            queued.push(self.enqueue_claim(&row["task_id"], &json!("jira"), &now())?);
        }
        Ok(json!(queued))
    }
    fn reconcile_claims(&self) -> Result<Value, ApiError> {
        let t = now();
        let mut changed = Vec::new();
        for row in self.all(sql::RECONCILE_CLAIM_QUEUE[0], &[t.clone(), t.clone()])? {
            changed.push(row["task_id"].clone());
        }
        for row in self.all(sql::RECONCILE_CLAIM_QUEUE[1], &[])? {
            if !changed.contains(&row["task_id"]) {
                changed.push(row["task_id"].clone());
            }
        }
        self.run(sql::RECONCILE_CLAIM_QUEUE[2], &[t.clone()])?;
        self.run(sql::RECONCILE_CLAIM_QUEUE[3], &[t.clone(), t])?;
        Ok(json!(changed))
    }
    fn bind_native_claim(
        &self,
        task: &Value,
        binding: &Value,
        actor: &Value,
        context: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(task)?;
        let claim = self.claim_item(&task["id"])?;
        if !task["archivedAt"].is_null() || task["status"] != "todo" {
            return Err(ApiError::new(
                409,
                "CLAIM_TASK_STATUS",
                "Only waiting issues can bind a native execution",
            ));
        }
        if claim.is_null()
            || claim["state"] != "running"
            || !claim["threadId"].is_null() && claim["threadId"] != binding["threadId"]
        {
            return Err(ApiError::new(
                409,
                "CLAIM_NOT_READY",
                format!("Claim queue item '{}' is not ready", text(&task["id"])),
            ));
        }
        self.assert_jira_plan_allows_execution(&task["id"], &json!("in_progress"))?;
        let t = now();
        let attempt_id = id();
        let minimum = self.get(
            sql::BIND_NATIVE_CLAIM[0],
            &[task["projectId"].clone(), task["id"].clone()],
        )?["minimum"]
            .as_f64();
        let order = minimum.map(|n| json!(n - 1000.0)).unwrap_or(json!(1000));
        self.transaction(|| {
            if self.run(
                sql::BIND_NATIVE_CLAIM[1],
                &[
                    binding["threadId"].clone(),
                    t.clone(),
                    t.clone(),
                    task["id"].clone(),
                    binding["threadId"].clone(),
                ],
            )? != 1
            {
                return Err(ApiError::new(
                    409,
                    "CLAIM_NOT_READY",
                    format!("Claim queue item '{}' is not ready", text(&task["id"])),
                ));
            }
            let mut parameters = vec![order];
            parameters.extend(
                rows::stored_binding(&Value::Null, Some(binding), Some(&binding["threadId"]))
                    .unwrap(),
            );
            parameters.extend([
                if context["type"] == "branch" {
                    context["branch"].clone()
                } else {
                    Value::Null
                },
                if context["type"] == "worktree" {
                    context["path"].clone()
                } else {
                    Value::Null
                },
                if context["type"] == "worktree" {
                    context["branch"].clone()
                } else {
                    Value::Null
                },
                t.clone(),
                task["id"].clone(),
            ]);
            if self.run(sql::BIND_NATIVE_CLAIM[2], &parameters)? != 1 {
                return Err(ApiError::new(
                    409,
                    "CLAIM_TASK_STATUS",
                    "Only waiting issues can bind a native execution",
                ));
            }
            self.run(
                sql::BIND_NATIVE_CLAIM[3],
                &[
                    attempt_id.clone(),
                    task["id"].clone(),
                    binding["threadId"].clone(),
                    t.clone(),
                ],
            )?;
            self.run(
                sql::BIND_NATIVE_CLAIM[4],
                &[binding["threadId"].clone(), t.clone(), task["id"].clone()],
            )?;
            self.record_activity(
                &task["id"],
                actor,
                &rows::changes(&task, &json!({"status":"in_progress"})),
                &t,
            )?;
            Ok(())
        })?;
        Ok(
            json!({"task":self.get_task(&task["id"])?,"claim":self.claim_item(&task["id"])?,"attempt":attempt(&self.get("SELECT * FROM issue_claim_attempts WHERE id=?",&[attempt_id])?)}),
        )
    }
    pub(super) fn call_claims(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "getClaimQueueItem",
            "listClaimAttempts",
            "enqueueClaim",
            "enqueueAuthorizedJiraClaims",
            "enqueueDueProjectScans",
            "reconcileClaimQueue",
            "jiraExecutionPeers",
            "executionContextPeers",
            "listReadyClaims",
            "nextClaim",
            "listRunningClaims",
            "setClaimThread",
            "markClaimRunning",
            "bindNativeClaim",
            "requestClaimResume",
            "createClaimAttempt",
            "attachClaimAttemptRun",
            "finishClaimAttempt",
            "scheduleClaimRetry",
            "finishClaim",
            "recoverInterruptedClaims",
            "suggestedExecutionThreadId",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            match method {
                "getClaimQueueItem" => self.claim_item(&a),
                "listClaimAttempts" => Ok(json!(self
                    .all(
                        "SELECT * FROM issue_claim_attempts WHERE task_id=? ORDER BY started_at,id",
                        &[a]
                    )?
                    .iter()
                    .map(attempt)
                    .collect::<Vec<_>>())),
                "enqueueClaim" => self.enqueue_claim(&a, &b, &fallback(&arg(args, 2), now())),
                "enqueueAuthorizedJiraClaims" => self.enqueue_authorized_jira_claims(),
                "reconcileClaimQueue" => self.reconcile_claims(),
                "jiraExecutionPeers" => self.jira_execution_peers(&a),
                "executionContextPeers" => {
                    let task = self.require_task(&a)?;
                    let path = if task["developmentContext"]["type"] == "worktree" {
                        task["developmentContext"]["path"].clone()
                    } else {
                        Value::Null
                    };
                    Ok(json!(self
                        .all(
                            sql::EXECUTION_CONTEXT_PEERS[0],
                            &[
                                task["projectId"].clone(),
                                task["threadId"].clone(),
                                task["threadBinding"]["codexHostId"].clone(),
                                path
                            ]
                        )?
                        .iter()
                        .map(|r| self.get_task(&r["id"]))
                        .collect::<Result<Vec<_>, _>>()?))
                }
                "enqueueDueProjectScans" => {
                    let at = fallback(&a, now());
                    let mut queued = Vec::new();
                    for policy in self.all(sql::ENQUEUE_DUE_PROJECT_SCANS[0], &[at.clone()])? {
                        for row in self.all(
                            sql::ENQUEUE_DUE_PROJECT_SCANS[1],
                            &[policy["project_id"].clone()],
                        )? {
                            let task = self.get_task(&row["id"])?;
                            if blocks_automatic_claim(&task["labels"]) {
                                continue;
                            }
                            queued.push(self.enqueue_claim(&task["id"], &json!("scan"), &at)?);
                        }
                        let time = chrono::DateTime::parse_from_rfc3339(text(&at))
                            .map_err(|e| ApiError::new(400, "INVALID_DATE", e.to_string()))?;
                        let next = time
                            + chrono::Duration::minutes(
                                policy["interval_minutes"].as_i64().unwrap_or(5),
                            );
                        self.run(
                            sql::ENQUEUE_DUE_PROJECT_SCANS[2],
                            &[
                                json!(next.to_rfc3339_opts(SecondsFormat::Millis, true)),
                                at.clone(),
                                policy["project_id"].clone(),
                            ],
                        )?;
                    }
                    Ok(json!(queued))
                }
                "listReadyClaims" => self.ready_claims(&fallback(&a, now())),
                "nextClaim" => Ok(array(&self.ready_claims(&fallback(&a, now()))?)
                    .first()
                    .cloned()
                    .unwrap_or(Value::Null)),
                "listRunningClaims" => {
                    let mut items = Vec::new();
                    for row in self.all("SELECT task_id FROM issue_claim_queue WHERE state='running' ORDER BY started_at,task_id",&[])?{items.push(json!({"task":self.get_task(&row["task_id"])?,"claim":self.claim_item(&row["task_id"])?}));}
                    Ok(json!(items))
                }
                "setClaimThread" => {
                    if self.run(
                        "UPDATE issue_claim_queue SET thread_id=?,updated_at=? WHERE task_id=?",
                        &[b, now(), a.clone()],
                    )? != 1
                    {
                        return Err(ApiError::new(
                            404,
                            "CLAIM_NOT_FOUND",
                            format!("Claim queue item '{}' does not exist", text(&a)),
                        ));
                    }
                    self.claim_item(&a)
                }
                "markClaimRunning" => {
                    let t = now();
                    if self.run("UPDATE issue_claim_queue SET state='running',attempt_count=attempt_count+1,thread_id=CASE WHEN ? THEN NULL ELSE thread_id END,resume_requested=0,started_at=?,finished_at=NULL,last_error=NULL,updated_at=? WHERE task_id=? AND state IN('queued','retry_wait')",&[json!(truth(&b)),t.clone(),t,a.clone()])?!=1{return Err(ApiError::new(409,"CLAIM_NOT_READY",format!("Claim queue item '{}' is not ready",text(&a))));}
                    self.claim_item(&a)
                }
                "bindNativeClaim" => self.bind_native_claim(&a, &b, &arg(args, 2), &arg(args, 3)),
                "requestClaimResume" => {
                    if self.run("UPDATE issue_claim_queue SET resume_requested=1,updated_at=? WHERE task_id=? AND state='running'",&[now(),a.clone()])?!=1{return Ok(Value::Null);}
                    self.claim_item(&a)
                }
                "createClaimAttempt" => {
                    let id = fallback(&a["id"], id());
                    self.run("INSERT INTO issue_claim_attempts(id,task_id,thread_id,run_id,status,error,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)",&[id.clone(),a["taskId"].clone(),a["threadId"].clone(),a["runId"].clone(),fallback(&a["status"],json!("running")),a["error"].clone(),fallback(&a["startedAt"],now()),a["finishedAt"].clone()])?;
                    Ok(attempt(&self.get(
                        "SELECT * FROM issue_claim_attempts WHERE id=?",
                        &[id],
                    )?))
                }
                "attachClaimAttemptRun" => {
                    self.run(
                        "UPDATE issue_claim_attempts SET run_id=? WHERE id=? AND status='running'",
                        &[b, a.clone()],
                    )?;
                    Ok(attempt(&self.get(
                        "SELECT * FROM issue_claim_attempts WHERE id=?",
                        &[a],
                    )?))
                }
                "finishClaimAttempt" => {
                    self.run("UPDATE issue_claim_attempts SET status=?,error=?,finished_at=? WHERE id=? AND status='running'",&[b,arg(args,2),now(),a.clone()])?;
                    Ok(attempt(&self.get(
                        "SELECT * FROM issue_claim_attempts WHERE id=?",
                        &[a],
                    )?))
                }
                "scheduleClaimRetry" => {
                    self.run("UPDATE issue_claim_queue SET state='retry_wait',source='resume',available_at=?,finished_at=NULL,last_error=?,updated_at=? WHERE task_id=?",&[arg(args,2),b,now(),a.clone()])?;
                    self.claim_item(&a)
                }
                "finishClaim" => {
                    if !matches!(text(&b), "blocked" | "failed" | "completed" | "canceled") {
                        return Err(ApiError::new(
                            400,
                            "INVALID_CLAIM_STATE",
                            format!("Cannot finish claim as '{}'", text(&b)),
                        ));
                    }
                    let t = now();
                    self.run("UPDATE issue_claim_queue SET state=?,finished_at=?,last_error=?,updated_at=? WHERE task_id=?",&[b,t.clone(),arg(args,2),t,a.clone()])?;
                    self.claim_item(&a)
                }
                "recoverInterruptedClaims" => {
                    let t = now();
                    let interrupted = self.all(sql::RECOVER_INTERRUPTED_CLAIMS[0], &[])?;
                    let ids: Vec<_> = interrupted.iter().map(|r| r["task_id"].clone()).collect();
                    if ids.is_empty() {
                        return Ok(json!([]));
                    }
                    let mut parameters = vec![t.clone()];
                    parameters.extend(ids.clone());
                    self.run(
                        &sql::RECOVER_INTERRUPTED_CLAIMS[1]
                            .replace("%PLACEHOLDERS%", &vec!["?"; ids.len()].join(",")),
                        &parameters,
                    )?;
                    for (legacy, index) in [(true, 2), (false, 3)] {
                        let chosen: Vec<_> = interrupted
                            .iter()
                            .filter(|r| truth(&r["legacy_ai_chat"]) == legacy)
                            .map(|r| r["task_id"].clone())
                            .collect();
                        if chosen.is_empty() {
                            continue;
                        }
                        let mut parameters = vec![t.clone(), t.clone()];
                        parameters.extend(chosen.clone());
                        self.run(
                            &sql::RECOVER_INTERRUPTED_CLAIMS[index]
                                .replace("%PLACEHOLDERS%", &vec!["?"; chosen.len()].join(",")),
                            &parameters,
                        )?;
                    }
                    Ok(json!(ids))
                }
                "suggestedExecutionThreadId" => Ok(self.claim_item(&a)?["threadId"].clone()),
                _ => unreachable!(),
            }
        })())
    }
}
