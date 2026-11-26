use super::*;
mod lifecycle;
mod links;
mod planning;
mod queries;
use queries as q;

fn conflict(code: &str, message: &str) -> ApiError {
    ApiError::new(409, code, message)
}
fn record_id(value: &Value) -> Value {
    if value.is_object() {
        value["id"].clone()
    } else {
        value.clone()
    }
}

impl Database {
    pub(super) fn jira_lifecycle(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(q::GET_JIRA_LIFECYCLE[0], &[id.clone()])?;
        if row.is_null() {
            return Ok(
                json!({"pending":null,"pausedIssueIds":[],"reopened":false,"duplicateOf":null,"version":0}),
            );
        }
        let pending = if truth(&row["pending_kind"]) {
            json!({"kind":row["pending_kind"],"fromStatus":row["pending_from_status"],"toStatus":row["pending_to_status"],"suggestedAction":match text(&row["pending_kind"]){"reopened"=>"rework","duplicate"=>"migrate",_=>"pause"},"createdAt":row["pending_created_at"]})
        } else {
            Value::Null
        };
        Ok(
            json!({"pending":pending,"pausedIssueIds":parse_json(&row["paused_task_ids"])?,"reopened":truth(&row["reopened"]),"duplicateOf":if truth(&row["is_duplicate"]){json!({"externalKey":row["duplicate_of_key"],"jiraTaskId":row["duplicate_task_id"],"accessible":!row["duplicate_task_id"].is_null()})}else{Value::Null},"version":row["version"]}),
        )
    }

    fn jira_source_snapshot(&self, task: &Value) -> Result<Value, ApiError> {
        let mut labels = array(&task["labels"]);
        // 历史快照由 JavaScript 排序，按 UTF-16 顺序保持非 BMP 标签兼容。
        labels.sort_by(|a, b| text(a).encode_utf16().cmp(text(b).encode_utf16()));
        let projects = self
            .all(q::JIRA_PLAN_SOURCE_SNAPSHOT[0], &[task["id"].clone()])?
            .iter()
            .map(|r| r["project_id"].clone())
            .collect::<Vec<_>>();
        Ok(
            json!({"title":task["title"],"description":task["description"],"priority":task["priority"],"labels":labels,"projectIds":projects}),
        )
    }

    fn jira_plan_items(&self, id: &Value, publication: &Value) -> Result<Value, ApiError> {
        if !truth(publication) {
            return Ok(json!([]));
        }
        let mut items = Vec::new();
        for row in self.all(
            q::LIST_JIRA_PLAN_ITEMS[0],
            &[id.clone(), publication.clone()],
        )? {
            let mut item = fields(
                &row,
                "item_key:key publication project_id task_id title description priority",
            );
            item["labels"] = parse_json(&row["labels"])?;
            item["blockedBy"] = parse_json(&row["blocked_by"])?;
            let task = self.get("SELECT * FROM tasks WHERE id=?", &[row["task_id"].clone()])?;
            item["task"] = if task.is_null() {
                Value::Null
            } else {
                rows::summary(&task)
            };
            items.push(item);
        }
        Ok(json!(items))
    }

    pub(super) fn jira_plan(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(q::GET_JIRA_PLAN[0], &[id.clone()])?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        let task = self.require_task(id)?;
        let mut result=fields(&row,"thread_id status spec prompted_at publication version published_at created_at updated_at");
        let snapshot: Value = serde_json::from_str(text(&row["source_snapshot"]))?;
        result["needsReview"] = json!(
            snapshot != self.jira_source_snapshot(&task)?
                || (row["publication"].as_i64().unwrap_or(0) > 0 && row["status"] != "published")
        );
        result["items"] = self.jira_plan_items(id, &row["publication"])?;
        Ok(result)
    }

    fn jira_planning_threads(&self) -> Result<Value, ApiError> {
        let mut threads = Vec::<Value>::new();
        for row in self.all(q::LIST_JIRA_PLANNING_THREADS[0], &[])? {
            let index = if let Some(i) = threads.iter().position(|v| v["id"] == row["id"]) {
                i
            } else {
                threads.push(json!({"id":row["id"],"title":row["title"],"projectId":row["origin_project_id"],"jiraTasks":[]}));
                threads.len() - 1
            };
            threads[index]["jiraTasks"].as_array_mut().unwrap().push(json!({"id":row["jira_id"],"identifier":row["identifier"],"title":row["jira_title"],"externalKey":row["external_key"]}));
        }
        Ok(json!(threads))
    }

    fn jira_simple_operation(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(q::GET_JIRA_SIMPLE_START_OPERATION[0], &[id.clone()])?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        let mut value=fields(&row,"id status transitioned_at project_count ready_count created_at updated_at completed_at");
        value["readyCount"] = fallback(&value["readyCount"], json!(0));
        Ok(value)
    }

    fn jira_auto_completion(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(
            "SELECT * FROM jira_auto_completions WHERE jira_task_id=?",
            &[id.clone()],
        )?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        let mut value=fields(&row,"state expected_updated_at remote_updated_at remote_status remote_task_status attempt_count available_at completed_at updated_at");
        value["error"] = if truth(&row["error_message"]) {
            json!({"code":fallback(&row["error_code"],json!("JIRA_AUTO_COMPLETE_FAILED")),"message":row["error_message"]})
        } else {
            Value::Null
        };
        Ok(value)
    }

    pub(super) fn jira_context(&self, id: &Value) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        let jira = if task["source"] == "jira" {
            task.clone()
        } else {
            let row = self.get(q::GET_JIRA_CONTEXT[0], &[task["id"].clone()])?;
            if row.is_null() {
                Value::Null
            } else {
                self.require_task(&row["id"])?
            }
        };
        if jira.is_null() {
            let available = self
                .all(q::GET_JIRA_CONTEXT[1], &[task["projectId"].clone()])?
                .iter()
                .map(rows::summary)
                .collect::<Vec<_>>();
            return Ok(
                json!({"jira":null,"projects":[],"issues":[],"availableIssues":[],"availableJira":available,"simpleStart":null,"plan":null,"lifecycle":null,"autoCompletion":null,"conversationArchive":null}),
            );
        }
        let projects = self
            .all(q::GET_JIRA_CONTEXT[2], &[jira["id"].clone()])?
            .iter()
            .map(rows::project)
            .collect::<Result<Vec<_>, _>>()?;
        let issues = self
            .all(q::GET_JIRA_CONTEXT[3], &[jira["id"].clone()])?
            .iter()
            .map(rows::summary)
            .collect::<Vec<_>>();
        let available = if task["source"] == "jira" {
            self.all(q::GET_JIRA_CONTEXT[4], &[jira["id"].clone()])?
                .iter()
                .map(rows::summary)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let plan = self.jira_plan(&jira["id"])?;
        let threads = self.jira_planning_threads()?;
        let shared = array(&threads)
            .into_iter()
            .find(|t| t["id"] == plan["threadId"])
            .map(|t| array(&t["jiraTasks"]))
            .unwrap_or_default();
        let mut execution = Vec::new();
        for member in &shared {
            if self.get(
                "SELECT shared_execution FROM jira_plans WHERE jira_task_id=?",
                &[member["id"].clone()],
            )?["shared_execution"]
                == 1
            {
                execution.push(member.clone());
            }
        }
        Ok(
            json!({"jira":jira,"projects":projects,"issues":issues,"availableIssues":available,"availableJira":[],"simpleStart":self.jira_simple_operation(&jira["id"])?,"plan":plan,"planningThreads":threads,"sharedPlanningJira":shared,"sharedExecutionJira":execution,"lifecycle":self.jira_lifecycle(&jira["id"])?,"autoCompletion":self.jira_auto_completion(&jira["id"])?,"conversationArchive":self.jira_conversation_archive(&jira["id"])?}),
        )
    }

    pub(super) fn jira_conversation_archive(&self, id: &Value) -> Result<Value, ApiError> {
        let jira = self.require_task(id)?;
        if jira["source"] != "jira" {
            return Err(conflict(
                "JIRA_TASK_REQUIRED",
                "Conversation archive requires a Jira task",
            ));
        }
        let issues = self.get(q::GET_JIRA_CONVERSATION_ARCHIVE[0], &[id.clone()])?;
        let threads = self.get(q::GET_JIRA_CONVERSATION_ARCHIVE[1], &vec![id.clone(); 5])?;
        let reason = if jira["status"] != "done" {
            Some("jira_not_done")
        } else if issues["linked_issue_count"] == 0 {
            Some("no_linked_issues")
        } else if issues["blocked_issue_count"].as_i64().unwrap_or(0) > 0 {
            Some("linked_issues_incomplete")
        } else if threads["related_thread_count"] == 0 {
            Some("no_related_conversations")
        } else if threads["unarchived_thread_count"] == 0 {
            Some("already_archived")
        } else if !self
            .get(
                q::SHARED_JIRA_PLANNING_INCOMPLETE[0],
                &[id.clone(), id.clone()],
            )?
            .is_null()
        {
            Some("shared_planning_incomplete")
        } else {
            None
        };
        Ok(
            json!({"eligible":reason.is_none(),"reason":reason,"relatedThreadCount":threads["related_thread_count"],"unarchivedThreadCount":threads["unarchived_thread_count"]}),
        )
    }

    pub(super) fn assert_jira_mutation_unlocked(
        &self,
        task: &Value,
        reservation: Option<&Value>,
        pause: Option<&Value>,
    ) -> Result<(), ApiError> {
        let task = record_id(task);
        // 暂停及重新规划的跨调用阶段持有同一预留标识，其他写入不能穿透。
        for (id, active) in self.jira_pause_resolutions.borrow().iter() {
            if pause == Some(active) {
                continue;
            }
            if json!(id) == task
                || !self
                    .get(
                        q::ASSERT_JIRA_MUTATION_UNLOCKED[0],
                        &[json!(id), task.clone()],
                    )?
                    .is_null()
            {
                return Err(conflict(
                    "JIRA_PAUSE_IN_PROGRESS",
                    "This issue cannot change while its Jira lifecycle pause is being applied",
                ));
            }
        }
        for (id, active) in self.jira_reopen_actions.borrow().iter() {
            if reservation == Some(active) {
                continue;
            }
            if json!(id) == task
                || !self
                    .get(
                        q::ASSERT_JIRA_MUTATION_UNLOCKED[1],
                        &[json!(id), task.clone()],
                    )?
                    .is_null()
            {
                return Err(conflict(
                    "JIRA_REOPEN_ACTION_IN_PROGRESS",
                    "This issue cannot change while its reopened Jira action is being applied",
                ));
            }
        }
        Ok(())
    }

    fn assert_issue_execution_allowed(&self, id: &Value) -> Result<(), ApiError> {
        if !truth(id) {
            return Ok(());
        }
        let link = self.get(q::ASSERT_ISSUE_EXECUTION_ALLOWED[0], &[id.clone()])?;
        if link.is_null() {
            return Ok(());
        }
        let lifecycle = self.jira_lifecycle(&link["jira_task_id"])?;
        if lifecycle["pending"]["suggestedAction"] == "pause" {
            return Err(conflict(
                "JIRA_LIFECYCLE_PAUSE_PENDING",
                "Resolve the linked Jira lifecycle notice before starting or continuing this issue",
            ));
        }
        if array(&lifecycle["pausedIssueIds"]).contains(id) {
            return Err(conflict(
                "JIRA_ISSUE_PAUSED",
                "Return the linked Jira issue to in progress before continuing this issue",
            ));
        }
        Ok(())
    }

    pub(super) fn assert_jira_plan_allows_execution(
        &self,
        task: &Value,
        status: &Value,
    ) -> Result<(), ApiError> {
        if status != "in_progress" {
            return Ok(());
        }
        let id = record_id(task);
        self.assert_issue_execution_allowed(&id)?;
        let link = self.get(q::ASSERT_ISSUE_EXECUTION_ALLOWED[0], &[id])?;
        if !link.is_null() && truth(&self.jira_plan(&link["jira_task_id"])?["needsReview"]) {
            return Err(conflict(
                "JIRA_PLAN_REVIEW_REQUIRED",
                "Review the changed Jira plan before starting this issue",
            ));
        }
        Ok(())
    }

    fn set_jira_pending(
        &self,
        id: &Value,
        kind: &str,
        from: &Value,
        to: &Value,
        timestamp: &Value,
        reopened: bool,
    ) -> Result<(), ApiError> {
        self.run(
            q::SET_JIRA_LIFECYCLE_PENDING[0],
            &[
                id.clone(),
                json!(kind),
                from.clone(),
                to.clone(),
                timestamp.clone(),
                json!(i32::from(reopened)),
                timestamp.clone(),
            ],
        )?;
        Ok(())
    }

    pub(super) fn release_jira_frontier(
        &self,
        id: &Value,
        paused: &Value,
        timestamp: &Value,
    ) -> Result<Value, ApiError> {
        let mut paused = array(paused);
        for task in self.all(q::RELEASE_JIRA_FRONTIER[0], &[id.clone()])? {
            if task["status"] == "blocked" && !paused.contains(&task["id"]) {
                continue;
            }
            if !self
                .get(q::RELEASE_JIRA_FRONTIER[1], &[task["id"].clone()])?
                .is_null()
            {
                let current = self.get_task(&task["id"])?;
                let peers = self.jira_execution_peers(&task["id"])?;
                if array(&current["relations"]["blockedBy"])
                    .iter()
                    .any(|dependency| {
                        !["done", "canceled"].contains(&text(&dependency["status"]))
                            && !(dependency["status"] == "in_review"
                                && array(&peers).iter().any(|peer| {
                                    peer["id"] == dependency["id"]
                                        && truth(&peer["threadBinding"])
                                        && truth(&peer["developmentContext"])
                                }))
                    })
                {
                    continue;
                }
            }
            self.run(
                q::RELEASE_JIRA_FRONTIER[2],
                &[
                    timestamp.clone(),
                    task["id"].clone(),
                    task["status"].clone(),
                ],
            )?;
            paused.retain(|p| *p != task["id"]);
        }
        let mut retained = Vec::new();
        for task in paused {
            if self.get("SELECT status FROM tasks WHERE id=?", &[task.clone()])?["status"]
                == "blocked"
            {
                retained.push(task);
            }
        }
        Ok(json!(retained))
    }

    pub(super) fn sync_jira_lifecycle(
        &self,
        current: &Value,
        status: &Value,
        timestamp: &Value,
    ) -> Result<(), ApiError> {
        let id = &current["id"];
        let lifecycle = self.jira_lifecycle(id)?;
        let terminal = |v: &Value| v == "done" || v == "canceled";
        if current["status"] != *status && terminal(&current["status"]) && !terminal(status) {
            return self.set_jira_pending(
                id,
                "reopened",
                &current["status"],
                status,
                timestamp,
                true,
            );
        }
        if status == "in_progress" {
            if truth(&lifecycle["reopened"]) {
                return Ok(());
            }
            let remaining = if truth(&self.jira_plan(id)?["needsReview"]) {
                lifecycle["pausedIssueIds"].clone()
            } else {
                self.release_jira_frontier(id, &lifecycle["pausedIssueIds"], timestamp)?
            };
            if lifecycle["version"].as_i64().unwrap_or(0) > 0
                && (truth(&lifecycle["pending"]) || remaining != lifecycle["pausedIssueIds"])
            {
                self.run(
                    q::SYNC_JIRA_LIFECYCLE[1],
                    &[json_text(&remaining), timestamp.clone(), id.clone()],
                )?;
            }
            return Ok(());
        }
        if current["status"] == *status
            || self
                .get(q::SYNC_JIRA_LIFECYCLE[0], &[id.clone()])?
                .is_null()
        {
            return Ok(());
        }
        if terminal(status) {
            return self.set_jira_pending(
                id,
                "ended",
                &current["status"],
                status,
                timestamp,
                false,
            );
        }
        if ["todo", "backlog"].contains(&text(status))
            && !["todo", "backlog"].contains(&text(&current["status"]))
        {
            self.set_jira_pending(id, "waiting", &current["status"], status, timestamp, false)?;
        }
        Ok(())
    }

    fn begin_jira_planning(
        &self,
        id: &Value,
        expected: &Value,
        thread: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        let id = &task["id"];
        self.assert_jira_mutation_unlocked(&task, None, None)?;
        version(&task, expected, "Task")?;
        if task["source"] != "jira" || !task["archivedAt"].is_null() {
            return Err(conflict(
                "JIRA_PLANNING_UNAVAILABLE",
                "Only active Jira issues can be planned",
            ));
        }
        let lifecycle = self.jira_lifecycle(id)?;
        if lifecycle["pending"]["kind"] == "reopened" {
            return Err(conflict(
                "JIRA_REPLAN_REQUIRED",
                "Choose how to handle the reopened Jira issue first",
            ));
        }
        if truth(&lifecycle["duplicateOf"]) {
            return Err(conflict(
                "JIRA_DUPLICATE",
                "Use the canonical Jira issue instead of planning a duplicate",
            ));
        }
        let row = self.get(q::BEGIN_JIRA_PLANNING[0], &[id.clone()])?;
        let snapshot = self.jira_source_snapshot(&task)?;
        let timestamp = now();
        if row.is_null() {
            if !truth(thread) {
                return Err(conflict(
                    "JIRA_PLANNING_THREAD_REQUIRED",
                    "Planning requires an AI conversation",
                ));
            }
            self.transaction(|| {
                self.run(
                    q::BEGIN_JIRA_PLANNING[1],
                    &[
                        id.clone(),
                        thread.clone(),
                        json_text(&snapshot),
                        timestamp.clone(),
                        timestamp.clone(),
                    ],
                )?;
                self.run(
                    q::BEGIN_JIRA_PLANNING[2],
                    &[id.clone(), thread.clone(), timestamp.clone()],
                )?;
                Ok(())
            })?;
            return Ok(json!({"plan":self.jira_plan(id)?,"shouldPrompt":true}));
        }
        let thread = fallback(thread, row["thread_id"].clone());
        if !truth(&thread) {
            return Err(conflict(
                "JIRA_PLANNING_THREAD_REQUIRED",
                "Planning requires an AI conversation",
            ));
        }
        let existing: Value = serde_json::from_str(text(&row["source_snapshot"]))?;
        let refresh = existing != snapshot || row["thread_id"] != thread;
        if refresh {
            self.transaction(|| {
                self.run(
                    q::BEGIN_JIRA_PLANNING[3],
                    &[
                        thread.clone(),
                        thread.clone(),
                        json_text(&snapshot),
                        timestamp.clone(),
                        id.clone(),
                    ],
                )?;
                self.run(
                    q::BEGIN_JIRA_PLANNING[4],
                    &[id.clone(), thread.clone(), timestamp.clone()],
                )?;
                Ok(())
            })?;
        }
        let plan = self.jira_plan(id)?;
        Ok(json!({"shouldPrompt":refresh||plan["promptedAt"].is_null(),"plan":plan}))
    }

    pub(super) fn call_jira(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if let Some(result) = self.call_jira_lifecycle(method, args) {
            return Some(result);
        }
        if let Some(result) = self.call_jira_planning(method, args) {
            return Some(result);
        }
        if let Some(result) = self.call_jira_links(method, args) {
            return Some(result);
        }
        if ![
            "getJiraContext",
            "listJiraPlanningThreads",
            "getJiraConversationArchive",
            "archiveJiraConversations",
            "getJiraLifecycle",
            "getJiraPlan",
            "listJiraPlanItems",
            "beginJiraPlanning",
            "markJiraPlanPrompted",
            "saveJiraPlanSpec",
            "getTaskPlan",
            "saveTaskPlanSpec",
            "getJiraAutoCompletion",
            "getJiraSimpleStartOperation",
            "assertIssueExecutionAllowed",
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
                "getJiraContext" => self.jira_context(&a),
                "listJiraPlanningThreads" => self.jira_planning_threads(),
                "getJiraConversationArchive" => self.jira_conversation_archive(&a),
                "getJiraLifecycle" => self.jira_lifecycle(&a),
                "getJiraPlan" => self.jira_plan(&a),
                "listJiraPlanItems" => self.jira_plan_items(&a, &b),
                "getJiraAutoCompletion" => self.jira_auto_completion(&a),
                "getJiraSimpleStartOperation" => self.jira_simple_operation(&a),
                "assertIssueExecutionAllowed" => {
                    self.assert_issue_execution_allowed(&a)?;
                    Ok(Value::Null)
                }
                "archiveJiraConversations" => {
                    version(&self.require_task(&a)?, &b, "Task")?;
                    self.transaction(|| {
                        let state = self.jira_conversation_archive(&a)?;
                        if !truth(&state["eligible"]) {
                            return Err(conflict(
                                "JIRA_CONVERSATION_ARCHIVE_UNAVAILABLE",
                                &format!(
                                    "Jira conversations cannot be archived: {}",
                                    text(&state["reason"])
                                ),
                            )
                            .with_details(json!({"reason":state["reason"]})));
                        }
                        self.archive_completed_jira_threads(&now(), &a, true)
                    })?;
                    self.jira_context(&a)
                }
                "beginJiraPlanning" => self.begin_jira_planning(&a, &b, &c),
                "markJiraPlanPrompted" => {
                    self.assert_jira_mutation_unlocked(&a, None, None)?;
                    let t = now();
                    self.run(q::MARK_JIRA_PLAN_PROMPTED[0], &[t.clone(), t, a.clone()])?;
                    self.jira_plan(&a)
                }
                "saveJiraPlanSpec" => {
                    self.assert_jira_mutation_unlocked(&a, None, None)?;
                    let plan = self.get(q::SAVE_JIRA_PLAN_SPEC[0], &[a.clone()])?;
                    if plan.is_null() {
                        return Err(ApiError::new(
                            404,
                            "JIRA_PLAN_NOT_FOUND",
                            "Start Jira planning before saving a spec",
                        ));
                    }
                    if plan["version"] != b {
                        return Err(conflict(
                            "VERSION_CONFLICT",
                            "Jira plan changed since it was read",
                        ));
                    }
                    if plan["status"] == "publishing" {
                        return Err(conflict(
                            "JIRA_PLAN_PUBLISHING",
                            "Finish the current publication before editing the spec",
                        ));
                    }
                    self.run(q::SAVE_JIRA_PLAN_SPEC[1], &[c, now(), a.clone(), b])?;
                    self.jira_plan(&a)
                }
                "getTaskPlan" | "saveTaskPlanSpec" => {
                    let task = self.require_task(&a)?;
                    if task["source"] == "jira" {
                        let mut canonical_args = args.to_vec();
                        canonical_args[0] = task["id"].clone();
                        return self
                            .call_jira(
                                if method == "getTaskPlan" {
                                    "getJiraPlan"
                                } else {
                                    "saveJiraPlanSpec"
                                },
                                &canonical_args,
                            )
                            .unwrap();
                    }
                    if method == "saveTaskPlanSpec" {
                        let t = now();
                        let next = json!(b.as_i64().unwrap_or(0) + 1);
                        if self.run(
                            q::SAVE_TASK_PLAN_SPEC[0],
                            &[
                                task["id"].clone(),
                                c,
                                next,
                                t.clone(),
                                t,
                                b.clone(),
                                task["id"].clone(),
                                b.clone(),
                                b,
                            ],
                        )? == 0
                        {
                            return Err(conflict(
                                "VERSION_CONFLICT",
                                "Task plan changed since it was read",
                            ));
                        }
                    }
                    let row = self.get(
                        "SELECT * FROM task_plans WHERE task_id=?",
                        &[task["id"].clone()],
                    )?;
                    Ok(
                        json!({"spec":fallback(&row["spec"],json!("")),"version":fallback(&row["version"],json!(1)),"createdAt":row["created_at"],"updatedAt":row["updated_at"]}),
                    )
                }
                _ => unreachable!(),
            }
        })())
    }
}
