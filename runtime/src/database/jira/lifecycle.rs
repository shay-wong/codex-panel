use super::*;

impl Database {
    fn jira_pause_targets(&self, id: &Value) -> Result<Vec<Value>, ApiError> {
        self.all(q::JIRA_PAUSE_TARGETS[0], &[id.clone()])
    }

    fn resolve_jira_lifecycle(
        &self,
        id: &Value,
        expected: &Value,
        action: &Value,
        pause: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        let id = &task["id"];
        self.assert_jira_mutation_unlocked(
            &task,
            None,
            if pause.is_null() { None } else { Some(pause) },
        )?;
        if task["source"] != "jira" {
            return Err(conflict(
                "JIRA_TASK_REQUIRED",
                "Only Jira issues have lifecycle decisions",
            ));
        }
        let lifecycle = self.jira_lifecycle(id)?;
        if !truth(&lifecycle["pending"]) {
            return Err(conflict(
                "JIRA_LIFECYCLE_NOT_PENDING",
                "This Jira issue has no pending lifecycle decision",
            ));
        }
        if lifecycle["version"] != *expected {
            return Err(conflict(
                "VERSION_CONFLICT",
                "Jira lifecycle changed since it was read",
            ));
        }
        let kind = text(&lifecycle["pending"]["kind"]);
        if kind == "reopened" {
            return Err(conflict(
                "JIRA_REOPENED_ACTION_REQUIRED",
                "Choose rework or planning for a reopened Jira issue",
            ));
        }
        if kind == "duplicate" && !["keep", "migrate"].contains(&text(action)) {
            return Err(conflict(
                "JIRA_DUPLICATE_ACTION_REQUIRED",
                "Choose whether to migrate duplicate Jira links",
            ));
        }
        if kind != "duplicate" && !["pause", "keep"].contains(&text(action)) {
            return Err(conflict(
                "JIRA_LIFECYCLE_ACTION_INVALID",
                "This action does not match the pending decision",
            ));
        }
        if self
            .jira_pause_resolutions
            .borrow()
            .get(text(id))
            .is_some_and(|v| action != "pause" || v != pause)
        {
            return Err(conflict(
                "JIRA_PAUSE_IN_PROGRESS",
                "This Jira lifecycle pause is already being applied",
            ));
        }
        let timestamp = now();
        let affected=self.transaction(||{
            let mut affected=Vec::new();
            if action=="migrate"{
                let canonical=&lifecycle["duplicateOf"]["jiraTaskId"];if !truth(canonical){return Err(conflict("JIRA_DUPLICATE_CANONICAL_UNAVAILABLE","The canonical Jira issue is not accessible; existing links were preserved"));}
                affected=self.all(q::RESOLVE_JIRA_LIFECYCLE[0],&[id.clone()])?.iter().map(|r|r["task_id"].clone()).collect();
                self.run(q::RESOLVE_JIRA_LIFECYCLE[1],&[canonical.clone(),timestamp.clone(),id.clone()])?;
                self.run(q::RESOLVE_JIRA_LIFECYCLE[2],&[canonical.clone(),id.clone()])?;
                self.run("DELETE FROM jira_task_projects WHERE jira_task_id=?",&[id.clone()])?;
                self.run(q::RESOLVE_JIRA_LIFECYCLE[3],&[timestamp.clone(),id.clone(),canonical.clone()])?;
            }else if action=="pause"{
                let linked=self.jira_pause_targets(id)?;
                let comparable=|v:&Value|json!({"id":v["id"],"status":v["status"]});
                if !pause.is_null()&&linked.iter().map(comparable).collect::<Vec<_>>()!=array(pause).iter().map(comparable).collect::<Vec<_>>(){return Err(conflict("JIRA_PAUSE_TARGETS_CHANGED","Linked issues changed while pause was being prepared; review and try again"));}
                for task in linked{let next=if task["status"]=="todo"{"backlog"}else{"blocked"};if self.run(q::RESOLVE_JIRA_LIFECYCLE[4],&[json!(next),timestamp.clone(),task["id"].clone(),task["status"].clone()])?==1{affected.push(task["id"].clone());}}
            }
            let paused=if action=="pause"{json!(affected)}else{lifecycle["pausedIssueIds"].clone()};
            if self.run(q::RESOLVE_JIRA_LIFECYCLE[5],&[json_text(&paused),timestamp.clone(),id.clone(),expected.clone()])?!=1{return Err(conflict("VERSION_CONFLICT","Jira lifecycle changed while the decision was applied"));}
            if kind=="ended"{self.run(q::RESOLVE_JIRA_LIFECYCLE[6],&[timestamp.clone(),timestamp.clone(),id.clone()])?;}
            Ok(affected)
        })?;
        Ok(json!({"context":self.jira_context(id)?,"affectedTaskIds":affected}))
    }

    pub(super) fn call_jira_lifecycle(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "resolveJiraLifecycle",
            "beginJiraLifecyclePause",
            "finishJiraLifecyclePause",
            "beginJiraReopenAction",
            "finishJiraReopenAction",
            "beginJiraRework",
            "beginJiraReplan",
            "completeJiraReopen",
            "completeJiraReplan",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            let c = arg(args, 2);
            match method {
                "resolveJiraLifecycle" => self.resolve_jira_lifecycle(&a, &b, &c, &arg(args, 3)),
                "beginJiraLifecyclePause" => {
                    let task = self.require_task(&a)?;
                    let a = task["id"].clone();
                    self.assert_jira_mutation_unlocked(&task, None, None)?;
                    let lifecycle = self.jira_lifecycle(&a)?;
                    if task["source"] != "jira"
                        || lifecycle["pending"]["suggestedAction"] != "pause"
                    {
                        return Err(conflict(
                            "JIRA_PAUSE_UNAVAILABLE",
                            "This Jira issue is not waiting for pause confirmation",
                        ));
                    }
                    if lifecycle["version"] != b {
                        return Err(conflict(
                            "VERSION_CONFLICT",
                            "Jira lifecycle changed since it was read",
                        ));
                    }
                    if self.jira_pause_resolutions.borrow().contains_key(text(&a)) {
                        return Err(conflict(
                            "JIRA_PAUSE_IN_PROGRESS",
                            "This Jira lifecycle pause is already being applied",
                        ));
                    }
                    let targets = self
                        .jira_pause_targets(&a)?
                        .iter()
                        .map(|t| self.get_task(&t["id"]))
                        .collect::<Result<Vec<_>, _>>()?;
                    let targets = json!(targets);
                    self.jira_pause_resolutions
                        .borrow_mut()
                        .insert(text(&a).into(), targets.clone());
                    Ok(targets)
                }
                "finishJiraLifecyclePause" => {
                    let mut locks = self.jira_pause_resolutions.borrow_mut();
                    if locks.get(text(&a)) == Some(&b) {
                        locks.remove(text(&a));
                    }
                    Ok(Value::Null)
                }
                "beginJiraReopenAction" => {
                    let task = self.require_task(&a)?;
                    let a = task["id"].clone();
                    let lifecycle = self.jira_lifecycle(&a)?;
                    if task["source"] != "jira" || lifecycle["pending"]["kind"] != "reopened" {
                        return Err(conflict(
                            "JIRA_REOPEN_ACTION_UNAVAILABLE",
                            "This Jira issue is not waiting for a reopened action",
                        ));
                    }
                    if lifecycle["version"] != b {
                        return Err(conflict(
                            "VERSION_CONFLICT",
                            "Jira lifecycle changed since it was read",
                        ));
                    }
                    self.assert_jira_mutation_unlocked(&task, None, None)?;
                    let reservation = json!({"action":c});
                    self.jira_reopen_actions
                        .borrow_mut()
                        .insert(text(&a).into(), reservation.clone());
                    Ok(reservation)
                }
                "finishJiraReopenAction" => {
                    let mut locks = self.jira_reopen_actions.borrow_mut();
                    if locks.get(text(&a)) == Some(&b) {
                        locks.remove(text(&a));
                    }
                    Ok(Value::Null)
                }
                "beginJiraRework" | "beginJiraReplan" => {
                    let task = self.require_task(&a)?;
                    let a = task["id"].clone();
                    self.assert_jira_mutation_unlocked(&task, Some(&c), None)?;
                    let lifecycle = self.jira_lifecycle(&a)?;
                    if lifecycle["version"] != b {
                        return Err(conflict(
                            "VERSION_CONFLICT",
                            "Jira lifecycle changed since it was read",
                        ));
                    }
                    if lifecycle["pending"]["kind"] != "reopened" {
                        return Err(conflict(
                            if method == "beginJiraReplan" {
                                "JIRA_REPLAN_UNAVAILABLE"
                            } else {
                                "JIRA_REWORK_UNAVAILABLE"
                            },
                            if method == "beginJiraReplan" {
                                "Planning again requires a reopened planned Jira issue"
                            } else {
                                "Rework is only available for a reopened Jira issue"
                            },
                        ));
                    }
                    if method == "beginJiraReplan" {
                        if self.jira_plan(&a)?.is_null() {
                            return Err(conflict(
                                "JIRA_REPLAN_UNAVAILABLE",
                                "Planning again requires a reopened planned Jira issue",
                            ));
                        }
                        return self.jira_context(&a);
                    }
                    let projects = self.all(q::BEGIN_JIRA_REWORK[0], &[a.clone(), a.clone()])?;
                    if projects.is_empty() {
                        return Err(conflict(
                            "JIRA_REWORK_PROJECT_REQUIRED",
                            "Link a repository before creating rework",
                        ));
                    }
                    let timestamp = now();
                    self.transaction(|| {
                        for project in projects {
                            self.run(
                                q::BEGIN_JIRA_REWORK[1],
                                &[
                                    a.clone(),
                                    b.clone(),
                                    project["project_id"].clone(),
                                    id(),
                                    id(),
                                    timestamp.clone(),
                                ],
                            )?;
                        }
                        Ok(())
                    })?;
                    Ok(json!({"jira":task,"items":self.all(q::BEGIN_JIRA_REWORK[2],&[a,b])?}))
                }
                "completeJiraReopen" => {
                    self.assert_jira_mutation_unlocked(&a, Some(&c), None)?;
                    if self.run(q::COMPLETE_JIRA_REOPEN[0], &[now(), a.clone(), b])? != 1 {
                        return Err(conflict(
                            "VERSION_CONFLICT",
                            "Jira lifecycle changed since rework started",
                        ));
                    }
                    self.jira_context(&a)
                }
                "completeJiraReplan" => {
                    let task = self.require_task(&a)?;
                    let a = task["id"].clone();
                    self.assert_jira_mutation_unlocked(&task, Some(&arg(args, 5)), None)?;
                    version(&task, &b, "Task")?;
                    let timestamp = now();
                    let thread = arg(args, 4);
                    self.transaction(|| {
                        if self.run(
                            q::COMPLETE_JIRA_REPLAN[0],
                            &[
                                thread.clone(),
                                json_text(&self.jira_source_snapshot(&task)?),
                                timestamp.clone(),
                                timestamp.clone(),
                                a.clone(),
                                arg(args, 3),
                            ],
                        )? != 1
                        {
                            return Err(conflict(
                                "VERSION_CONFLICT",
                                "Jira plan changed since replanning started",
                            ));
                        }
                        self.run(
                            q::COMPLETE_JIRA_REPLAN[1],
                            &[a.clone(), thread, timestamp.clone()],
                        )?;
                        if self.run(q::COMPLETE_JIRA_REPLAN[2], &[timestamp, a.clone(), c])? != 1 {
                            return Err(conflict(
                                "VERSION_CONFLICT",
                                "Jira lifecycle changed since replanning started",
                            ));
                        }
                        Ok(())
                    })?;
                    self.jira_context(&a)
                }
                _ => unreachable!(),
            }
        })())
    }
}
