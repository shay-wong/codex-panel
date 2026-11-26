use super::*;

fn comparable(items: &Value) -> Value {
    json!(array(items)
        .iter()
        .map(|i| fields(
            i,
            "key projectId:projectId title description priority labels blockedBy:blockedBy"
        ))
        .collect::<Vec<_>>())
}

impl Database {
    fn begin_jira_publication(
        &self,
        id: &Value,
        expected: &Value,
        items: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        self.assert_jira_mutation_unlocked(&task, None, None)?;
        let plan = self.get(q::BEGIN_JIRA_PLAN_PUBLISH[0], &[id.clone()])?;
        if plan.is_null() {
            return Err(ApiError::new(
                404,
                "JIRA_PLAN_NOT_FOUND",
                "Start Jira planning before publishing tickets",
            ));
        }
        if plan["version"] != *expected {
            return Err(conflict(
                "VERSION_CONFLICT",
                "Jira plan changed since it was read",
            ));
        }
        if text(&plan["spec"]).trim().is_empty() {
            return Err(conflict(
                "JIRA_PLAN_SPEC_REQUIRED",
                "Save the Jira planning spec before publishing tickets",
            ));
        }
        if !["review", "publishing"].contains(&text(&plan["status"])) {
            return Err(conflict(
                "JIRA_PLAN_REVIEW_REQUIRED",
                "Save the reviewed Jira spec before publishing tickets",
            ));
        }
        if serde_json::from_str::<Value>(text(&plan["source_snapshot"]))?
            != self.jira_source_snapshot(&task)?
        {
            return Err(conflict(
                "JIRA_PLAN_REVIEW_REQUIRED",
                "Jira content or linked repositories changed; review the plan again",
            ));
        }
        let projects = self
            .all(q::BEGIN_JIRA_PLAN_PUBLISH[1], &[id.clone()])?
            .iter()
            .map(|p| p["project_id"].clone())
            .collect::<Vec<_>>();
        if projects.is_empty() {
            return Err(conflict(
                "JIRA_PLAN_PROJECT_REQUIRED",
                "Link at least one repository before publishing tickets",
            ));
        }
        let entries = items
            .as_array()
            .ok_or_else(|| ApiError::new(400, "INVALID_PLAN_ITEMS", "Tickets must be an array"))?;
        if let Some(item) = entries.iter().find(|i| !projects.contains(&i["projectId"])) {
            return Err(conflict(
                "JIRA_PLAN_PROJECT_INVALID",
                &format!(
                    "Ticket '{}' uses a repository that is not linked to Jira",
                    text(&item["key"])
                ),
            ));
        }
        let previous = self.jira_plan_items(id, &plan["publication"])?;
        if plan["status"] == "publishing" {
            if comparable(&previous) != comparable(items) {
                return Err(conflict(
                    "JIRA_PLAN_PUBLISH_CONFLICT",
                    "Retry the interrupted publication with the same ticket manifest",
                ));
            }
            return Ok(
                json!({"plan":self.jira_plan(id)?,"items":previous,"previousItems":self.jira_plan_items(id,&json!(plan["publication"].as_i64().unwrap_or(0)-1))?}),
            );
        }
        for item in array(&previous) {
            if !item["task"].is_null()
                && ["in_progress", "in_review", "blocked", "done"]
                    .contains(&text(&item["task"]["status"]))
                && !entries
                    .iter()
                    .any(|i| i["key"] == item["key"] && i["projectId"] == item["task"]["projectId"])
            {
                return Err(conflict(
                    "JIRA_PLAN_PRESERVED_TASK_REQUIRED",
                    &format!(
                        "Keep started issue '{}' in the revised plan",
                        text(&item["task"]["identifier"])
                    ),
                ));
            }
        }
        let publication = json!(plan["publication"].as_i64().unwrap_or(0) + 1);
        let timestamp = now();
        self.transaction(|| {
            for item in entries {
                let old = array(&previous)
                    .into_iter()
                    .find(|p| p["key"] == item["key"]);
                let previous_task = if let Some(old) = &old {
                    self.get(
                        "SELECT * FROM tasks WHERE id=? AND archived_at IS NULL",
                        &[old["taskId"].clone()],
                    )?
                } else {
                    Value::Null
                };
                let task_id = if previous_task["project_id"] == item["projectId"]
                    && !previous_task.is_null()
                {
                    old.as_ref().unwrap()["taskId"].clone()
                } else {
                    super::id()
                };
                self.run(
                    q::BEGIN_JIRA_PLAN_PUBLISH[2],
                    &[
                        id.clone(),
                        publication.clone(),
                        item["key"].clone(),
                        item["projectId"].clone(),
                        task_id,
                        item["title"].clone(),
                        item["description"].clone(),
                        item["priority"].clone(),
                        json_text(&item["labels"]),
                        json_text(&item["blockedBy"]),
                        timestamp.clone(),
                    ],
                )?;
            }
            self.run(
                q::BEGIN_JIRA_PLAN_PUBLISH[3],
                &[publication.clone(), timestamp, id.clone(), expected.clone()],
            )?;
            Ok(())
        })?;
        Ok(
            json!({"plan":self.jira_plan(id)?,"items":self.jira_plan_items(id,&publication)?,"previousItems":previous}),
        )
    }

    fn replace_jira_plan_blocks(
        &self,
        id: &Value,
        previous: &Value,
        publication: &Value,
        edges: &Value,
    ) -> Result<(), ApiError> {
        let rows = if previous.as_i64().unwrap_or(0) > 0 {
            self.all(
                q::REPLACE_JIRA_PLAN_BLOCKS[0],
                &[id.clone(), previous.clone()],
            )?
        } else {
            Vec::new()
        };
        let mut next = Vec::new();
        for edge in array(edges) {
            let pair = edge.as_array().filter(|p| p.len() == 2).ok_or_else(|| {
                ApiError::new(
                    400,
                    "INVALID_PLAN_EDGE",
                    "Plan dependency must have two endpoints",
                )
            })?;
            if !next.iter().any(|p: &Vec<Value>| p == pair) {
                next.push(pair.clone());
            }
        }
        let timestamp = now();
        self.transaction(|| {
            for row in &rows {
                let pair = vec![row["source_task_id"].clone(), row["target_task_id"].clone()];
                if next.contains(&pair) || row["created_relation"] != 1 {
                    continue;
                }
                let mut cancelable = true;
                for task in &pair {
                    let state = self.get("SELECT status FROM tasks WHERE id=?", &[task.clone()])?;
                    if !["backlog", "todo", "canceled"].contains(&text(&state["status"])) {
                        cancelable = false;
                    }
                }
                if cancelable {
                    self.run(q::REPLACE_JIRA_PLAN_BLOCKS[1], &pair)?;
                }
            }
            for pair in next {
                let inserted = self.run(
                    q::REPLACE_JIRA_PLAN_BLOCKS[2],
                    &[pair[0].clone(), pair[1].clone(), timestamp.clone()],
                )?;
                let existed = rows.iter().any(|r| {
                    r["source_task_id"] == pair[0]
                        && r["target_task_id"] == pair[1]
                        && r["created_relation"] == 1
                });
                self.run(
                    q::REPLACE_JIRA_PLAN_BLOCKS[3],
                    &[
                        id.clone(),
                        publication.clone(),
                        pair[0].clone(),
                        pair[1].clone(),
                        json!(i32::from(existed || inserted == 1)),
                    ],
                )?;
            }
            Ok(())
        })
    }

    fn jira_simple_items(&self, id: &Value) -> Result<Value, ApiError> {
        Ok(json!(self
            .all(q::LIST_JIRA_SIMPLE_START_ITEMS[0], &[id.clone()])?
            .iter()
            .map(|r| fields(r, "project_id task_id thread_id scope"))
            .collect::<Vec<_>>()))
    }

    fn begin_jira_simple_start(
        &self,
        id: &Value,
        expected: &Value,
        scopes: &Value,
    ) -> Result<Value, ApiError> {
        let task = self.require_task(id)?;
        let id = &task["id"];
        self.assert_jira_mutation_unlocked(&task, None, None)?;
        let existing = self.jira_simple_operation(id)?;
        if !existing.is_null() {
            return Ok(
                json!({"jira":task,"operation":existing,"items":self.jira_simple_items(id)?}),
            );
        }
        if !self.jira_plan(id)?.is_null() {
            return Err(conflict(
                "JIRA_SIMPLE_START_PLANNING_CONFLICT",
                "This Jira issue already uses the AI planning flow",
            ));
        }
        version(&task, expected, "Task")?;
        if task["source"] != "jira" || !task["archivedAt"].is_null() {
            return Err(conflict(
                "JIRA_SIMPLE_START_UNAVAILABLE",
                "Only active Jira issues can be started",
            ));
        }
        let lifecycle = self.jira_lifecycle(id)?;
        if truth(&lifecycle["pending"]) {
            return Err(conflict(
                "JIRA_LIFECYCLE_PENDING",
                "Resolve the Jira lifecycle notice before starting this issue",
            ));
        }
        if truth(&lifecycle["duplicateOf"]) {
            return Err(conflict(
                "JIRA_DUPLICATE",
                "Use the canonical Jira issue instead of starting a duplicate",
            ));
        }
        if task["status"] != "todo" {
            return Err(conflict(
                "JIRA_SIMPLE_START_STATUS",
                "只有待认领的 Jira 可以创建并开始",
            ));
        }
        let context = self.jira_context(id)?;
        let projects = array(&context["projects"]);
        if projects.is_empty() {
            return Err(conflict(
                "JIRA_SIMPLE_START_PROJECT_REQUIRED",
                "请先为 Jira 关联至少一个仓库",
            ));
        }
        let mut items = Vec::new();
        for project in projects {
            let linked = array(&context["issues"])
                .into_iter()
                .filter(|i| i["projectId"] == project["id"])
                .collect::<Vec<_>>();
            if linked.len() > 1 {
                return Err(conflict(
                    "JIRA_SIMPLE_START_PROJECT_CONFLICT",
                    &format!(
                        "仓库 {} 已关联多个执行 Issue，请先保留一个",
                        text(&project["name"])
                    ),
                ));
            }
            items.push(json!({"projectId":project["id"],"taskId":linked.first().map(|i|i["id"].clone()).unwrap_or_else(super::id),"threadId":null,"scope":scopes.get(text(&project["id"])).cloned().unwrap_or(Value::Null)}));
        }
        let operation = super::id();
        let timestamp = now();
        self.transaction(|| {
            self.run(
                q::BEGIN_JIRA_SIMPLE_START[0],
                &[
                    operation.clone(),
                    id.clone(),
                    timestamp.clone(),
                    timestamp.clone(),
                ],
            )?;
            for item in &items {
                self.run(
                    q::BEGIN_JIRA_SIMPLE_START[1],
                    &[
                        operation.clone(),
                        item["projectId"].clone(),
                        item["taskId"].clone(),
                        item["threadId"].clone(),
                        timestamp.clone(),
                        timestamp.clone(),
                        item["scope"].clone(),
                    ],
                )?;
            }
            Ok(())
        })?;
        Ok(json!({"jira":task,"operation":self.jira_simple_operation(id)?,"items":items}))
    }

    pub(super) fn call_jira_planning(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "beginJiraPlanPublish",
            "replaceJiraPlanBlocks",
            "finishJiraPlanPublish",
            "listJiraSimpleStartItems",
            "beginJiraSimpleStart",
            "markJiraSimpleStartTransitioned",
            "completeJiraSimpleStart",
            "enableSharedJiraExecution",
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
                "beginJiraPlanPublish" => self.begin_jira_publication(&a, &b, &c),
                "replaceJiraPlanBlocks" => {
                    self.replace_jira_plan_blocks(&a, &b, &c, &arg(args, 3))?;
                    Ok(Value::Null)
                }
                "finishJiraPlanPublish" => {
                    self.assert_jira_mutation_unlocked(&a, None, None)?;
                    let timestamp = now();
                    if self.run(
                        q::FINISH_JIRA_PLAN_PUBLISH[0],
                        &[timestamp.clone(), timestamp, a.clone(), b],
                    )? != 1
                    {
                        return Err(conflict(
                            "JIRA_PLAN_PUBLISH_INACTIVE",
                            "The Jira plan is not publishing",
                        ));
                    }
                    self.jira_plan(&a)
                }
                "listJiraSimpleStartItems" => self.jira_simple_items(&a),
                "beginJiraSimpleStart" => self.begin_jira_simple_start(&a, &b, &c),
                "markJiraSimpleStartTransitioned" => {
                    let timestamp = now();
                    if self.run(
                        q::MARK_JIRA_SIMPLE_START_TRANSITIONED[0],
                        &[timestamp.clone(), timestamp, a],
                    )? != 1
                    {
                        return Err(conflict(
                            "JIRA_SIMPLE_START_INACTIVE",
                            "Jira 创建操作已经结束",
                        ));
                    }
                    Ok(Value::Null)
                }
                "completeJiraSimpleStart" => {
                    if self
                        .get(q::COMPLETE_JIRA_SIMPLE_START[0], &[a.clone()])?
                        .is_null()
                    {
                        return Ok(Value::Null);
                    }
                    if !self
                        .get(q::COMPLETE_JIRA_SIMPLE_START[1], &[a.clone()])?
                        .is_null()
                    {
                        return Err(conflict(
                            "JIRA_SIMPLE_START_INCOMPLETE",
                            "仍有仓库未完成 Issue 或对话创建",
                        ));
                    }
                    let timestamp = now();
                    self.run(
                        q::COMPLETE_JIRA_SIMPLE_START[2],
                        &[timestamp.clone(), timestamp, a],
                    )?;
                    Ok(Value::Null)
                }
                "enableSharedJiraExecution" => {
                    let task = self.require_task(&a)?;
                    version(&task, &b, "Task")?;
                    let plan = self.jira_plan(&a)?;
                    let shared = array(&self.jira_planning_threads()?)
                        .into_iter()
                        .find(|t| t["id"] == c);
                    if task["source"] != "jira"
                        || !task["archivedAt"].is_null()
                        || plan["threadId"] != c
                        || shared
                            .as_ref()
                            .is_none_or(|s| array(&s["jiraTasks"]).len() < 2)
                    {
                        return Err(conflict("JIRA_SHARED_EXECUTION_UNAVAILABLE","Shared execution requires an active planning conversation shared by multiple Jira issues"));
                    }
                    self.transaction(||{let timestamp=now();for member in array(&shared.unwrap()["jiraTasks"]){self.assert_jira_mutation_unlocked(&member["id"],None,None)?;let lifecycle=self.jira_lifecycle(&member["id"])?;if truth(&lifecycle["pending"])||truth(&lifecycle["duplicateOf"])||!array(&lifecycle["pausedIssueIds"]).is_empty(){return Err(conflict("JIRA_SHARED_EXECUTION_UNAVAILABLE","Resolve Jira lifecycle notices before sharing execution"));}self.run("UPDATE jira_plans SET shared_execution=1,version=version+1,updated_at=? WHERE jira_task_id=? AND shared_execution=0",&[timestamp.clone(),member["id"].clone()])?;}Ok(())})?;
                    self.jira_context(&a)
                }
                _ => unreachable!(),
            }
        })())
    }
}
