use super::*;
#[path = "auto_completion_sql.rs"]
mod sql;
impl Database {
    fn auto_completion(&self, id: &Value) -> Result<Value, ApiError> {
        let r = self.get(
            "SELECT * FROM jira_auto_completions WHERE jira_task_id=?",
            &[id.clone()],
        )?;
        if r.is_null() {
            return Ok(Value::Null);
        }
        let mut out=fields(&r,"state expected_updated_at remote_updated_at remote_status remote_task_status attempt_count available_at completed_at updated_at");
        out["error"] = if truth(&r["error_message"]) {
            json!({"code":fallback(&r["error_code"],json!("JIRA_AUTO_COMPLETE_FAILED")),"message":r["error_message"]})
        } else {
            Value::Null
        };
        Ok(out)
    }
    fn touch_auto_completion(&self, id: &Value, timestamp: &Value) -> Result<(), ApiError> {
        self.run(
            "UPDATE tasks SET version=version+1,updated_at=? WHERE id=?",
            &[timestamp.clone(), id.clone()],
        )?;
        Ok(())
    }
    pub(super) fn dismiss_pending_jira_auto_completion(&self, id: &Value) -> Result<(), ApiError> {
        let t = now();
        if self.run(
            sql::DISMISS_PENDING_JIRA_AUTO_COMPLETION[0],
            &[t.clone(), id.clone()],
        )? == 1
        {
            self.touch_auto_completion(id, &t)?;
        }
        Ok(())
    }
    fn queue_jira_auto_completion(&self, jira: &Value) -> Result<(), ApiError> {
        let t = now();
        if self.run(
            sql::QUEUE_JIRA_AUTO_COMPLETION[0],
            &[
                jira["id"].clone(),
                jira["external_updated_at"].clone(),
                t.clone(),
                t.clone(),
            ],
        )? == 1
        {
            self.touch_auto_completion(&jira["id"], &t)?;
        }
        Ok(())
    }
    pub(super) fn reconcile_jira_auto_completion(&self, id: &Value) -> Result<Value, ApiError> {
        if !truth(&self.jira_settings()?["autoCompleteEnabled"]) {
            self.dismiss_pending_jira_auto_completion(id)?;
            return Ok(Value::Null);
        }
        let jira = self.get(sql::RECONCILE_JIRA_AUTO_COMPLETION[0], &[id.clone()])?;
        if jira.is_null() {
            self.dismiss_pending_jira_auto_completion(id)?;
            return Ok(Value::Null);
        }
        self.queue_jira_auto_completion(&jira)?;
        Ok(jira["id"].clone())
    }
    pub(super) fn call_auto_completion(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "queueEligibleJiraAutoCompletion",
            "reconcileJiraAutoCompletion",
            "queueEligibleJiraAutoCompletions",
            "dismissPendingJiraAutoCompletion",
            "queueJiraAutoCompletionRetry",
            "dismissJiraAutoCompletionConflict",
            "takeNextJiraAutoCompletion",
            "isJiraAutoCompletionEligible",
            "finishJiraAutoCompletion",
            "failJiraAutoCompletion",
            "recoverJiraAutoCompletions",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            match method {
                "queueEligibleJiraAutoCompletion" => {
                    if !truth(&self.jira_settings()?["autoCompleteEnabled"]) {
                        return Ok(Value::Null);
                    }
                    let linked = self.get(sql::QUEUE_ELIGIBLE_JIRA_AUTO_COMPLETION[0], &[a])?;
                    if linked.is_null() {
                        Ok(Value::Null)
                    } else {
                        self.reconcile_jira_auto_completion(&linked["id"])
                    }
                }
                "reconcileJiraAutoCompletion" => self.reconcile_jira_auto_completion(&a),
                "queueEligibleJiraAutoCompletions" => {
                    if !truth(&self.jira_settings()?["autoCompleteEnabled"]) {
                        return Ok(json!([]));
                    }
                    let candidates = self.all(sql::QUEUE_ELIGIBLE_JIRA_AUTO_COMPLETIONS[0], &[])?;
                    for jira in &candidates {
                        self.queue_jira_auto_completion(jira)?;
                    }
                    Ok(json!(candidates
                        .iter()
                        .map(|r| r["id"].clone())
                        .collect::<Vec<_>>()))
                }
                "dismissPendingJiraAutoCompletion" => {
                    self.dismiss_pending_jira_auto_completion(&a)?;
                    Ok(Value::Null)
                }
                "queueJiraAutoCompletionRetry" => {
                    if !truth(&self.jira_settings()?["autoCompleteEnabled"]) {
                        return Err(ApiError::new(
                            409,
                            "JIRA_AUTO_COMPLETE_DISABLED",
                            "Enable Jira automatic completion before retrying",
                        ));
                    }
                    let jira = self.require_task(&a)?;
                    if jira["source"] != "jira" {
                        return Err(ApiError::new(
                            409,
                            "JIRA_TASK_REQUIRED",
                            "Only Jira issues can retry automatic completion",
                        ));
                    }
                    let current = self.auto_completion(&a)?;
                    if current.is_null()
                        || !matches!(text(&current["state"]), "conflict" | "failed" | "dismissed")
                    {
                        return Err(ApiError::new(
                            409,
                            "JIRA_AUTO_COMPLETE_NOT_RETRYABLE",
                            "Jira automatic completion is not waiting for retry",
                        ));
                    }
                    if self
                        .get(
                            sql::QUEUE_JIRA_AUTO_COMPLETION_RETRY[0],
                            &[a.clone(), a.clone()],
                        )?
                        .is_null()
                    {
                        self.dismiss_pending_jira_auto_completion(&a)?;
                        return Err(ApiError::new(
                            409,
                            "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE",
                            "Every linked issue must still be done before retrying Jira completion",
                        ));
                    }
                    let t = now();
                    self.run(
                        sql::QUEUE_JIRA_AUTO_COMPLETION_RETRY[1],
                        &[
                            jira["externalUpdatedAt"].clone(),
                            t.clone(),
                            t.clone(),
                            a.clone(),
                        ],
                    )?;
                    self.touch_auto_completion(&a, &t)?;
                    self.auto_completion(&a)
                }
                "dismissJiraAutoCompletionConflict" => {
                    if self.auto_completion(&a)?["state"] != "conflict" {
                        return Err(ApiError::new(
                            409,
                            "JIRA_AUTO_COMPLETE_NOT_CONFLICTED",
                            "Jira automatic completion has no remote conflict to accept",
                        ));
                    }
                    let t = now();
                    self.run(
                        sql::DISMISS_JIRA_AUTO_COMPLETION_CONFLICT[0],
                        &[t.clone(), a.clone()],
                    )?;
                    self.touch_auto_completion(&a, &t)?;
                    self.jira_context(&a)
                }
                "takeNextJiraAutoCompletion" => {
                    let t = now();
                    let r = self.get(sql::TAKE_NEXT_JIRA_AUTO_COMPLETION[0], &[t.clone()])?;
                    if r.is_null() {
                        return Ok(Value::Null);
                    }
                    let id = &r["jira_task_id"];
                    if self.run(
                        sql::TAKE_NEXT_JIRA_AUTO_COMPLETION[1],
                        &[t.clone(), id.clone()],
                    )? != 1
                    {
                        return Ok(Value::Null);
                    }
                    self.touch_auto_completion(id, &t)?;
                    let jira = self.get_task(id)?;
                    if jira.is_null() {
                        Ok(Value::Null)
                    } else {
                        Ok(json!({"jira":jira,"completion":self.auto_completion(id)?}))
                    }
                }
                "isJiraAutoCompletionEligible" => {
                    if !truth(&self.jira_settings()?["autoCompleteEnabled"]) {
                        return Ok(json!(false));
                    }
                    Ok(json!(!self
                        .get(sql::IS_JIRA_AUTO_COMPLETION_ELIGIBLE[0], &[a])?
                        .is_null()))
                }
                "finishJiraAutoCompletion" => {
                    self.transaction(|| {
                        let t = now();
                        self.run(
                            sql::FINISH_JIRA_AUTO_COMPLETION[0],
                            &[
                                b["statusName"].clone(),
                                b["updatedAt"].clone(),
                                t.clone(),
                                t.clone(),
                                a.clone(),
                            ],
                        )?;
                        self.run(
                            sql::FINISH_JIRA_AUTO_COMPLETION[1],
                            &[
                                b["updatedAt"].clone(),
                                b["statusName"].clone(),
                                t.clone(),
                                t.clone(),
                                a.clone(),
                            ],
                        )?;
                        self.archive_completed_jira_threads(&t, &a, false)
                    })?;
                    self.jira_context(&a)
                }
                "failJiraAutoCompletion" => {
                    let options = arg(args, 2);
                    let t = now();
                    let state = match text(&b["code"]) {
                        "JIRA_AUTO_COMPLETE_CONFLICT" => "conflict",
                        "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE" => "dismissed",
                        _ => {
                            if truth(&options["retryAt"]) {
                                "retry_wait"
                            } else {
                                "failed"
                            }
                        }
                    };
                    let code = if state == "dismissed" {
                        Value::Null
                    } else {
                        json!(
                            text(&fallback(&b["code"], json!("JIRA_AUTO_COMPLETE_FAILED")))
                                .chars()
                                .take(120)
                                .collect::<String>()
                        )
                    };
                    let message = if state == "dismissed" {
                        Value::Null
                    } else {
                        json!(text(&fallback(&b["message"], b.clone()))
                            .chars()
                            .take(1000)
                            .collect::<String>())
                    };
                    self.run(
                        sql::FAIL_JIRA_AUTO_COMPLETION[0],
                        &[
                            json!(state),
                            options["retryAt"].clone(),
                            options["remote"]["updatedAt"].clone(),
                            options["remote"]["statusName"].clone(),
                            options["remote"]["taskStatus"].clone(),
                            code,
                            message,
                            t.clone(),
                            a.clone(),
                        ],
                    )?;
                    self.touch_auto_completion(&a, &t)?;
                    self.auto_completion(&a)
                }
                "recoverJiraAutoCompletions" => {
                    let t = now();
                    self.run(sql::RECOVER_JIRA_AUTO_COMPLETIONS[0], &[t.clone(), t])?;
                    Ok(Value::Null)
                }
                _ => unreachable!(),
            }
        })())
    }
}
