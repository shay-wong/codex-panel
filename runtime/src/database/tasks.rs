use super::comments::append_binding;
use super::*;

fn placeholders(length: usize) -> String {
    vec!["?"; length].join(",")
}
fn tree_node(row: &Value, parent: &Value, depth: u64, path: Value) -> Value {
    json!({"id":row["id"],"parentId":parent,"depth":depth,"path":path,"summary":fields(row,"identifier title status priority archived_at")})
}
fn actor(row: &Value, prefix: &str) -> Value {
    json!({"type":row[format!("{prefix}_type")],"id":row[format!("{prefix}_id")],"name":row[format!("{prefix}_name")],"avatarUrl":row[format!("{prefix}_avatar_url")]})
}

impl Database {
    pub(super) fn get_task(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(
            "SELECT * FROM tasks WHERE id=? OR identifier=?",
            &[id.clone(), id.clone()],
        )?;
        if row.is_null() {
            return Ok(Value::Null);
        }
        Ok(self.decorate_tasks(&[row])?.remove(0))
    }
    pub(super) fn require_task(&self, id: &Value) -> Result<Value, ApiError> {
        let task = self.get_task(id)?;
        if task.is_null() {
            Err(missing("Task", id))
        } else {
            Ok(task)
        }
    }
    pub(super) fn require_task_record(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get(
            "SELECT * FROM tasks WHERE id=? OR identifier=?",
            &[id.clone(), id.clone()],
        )?;
        if row.is_null() {
            return Err(missing("Task", id));
        }
        rows::task(&row)
    }
    fn decorate_tasks(&self, records: &[Value]) -> Result<Vec<Value>, ApiError> {
        let mut relations = HashMap::new();
        let mut comments: HashMap<String, Vec<Value>> = HashMap::new();
        let mut activities: HashMap<String, Vec<Value>> = HashMap::new();
        let mut previews = HashMap::new();
        let mut claims = HashMap::new();
        for chunk in records.chunks(400) {
            let ids: Vec<Value> = chunk.iter().map(|r| r["id"].clone()).collect();
            let marks = placeholders(ids.len());
            for id in &ids {
                relations.insert(
                    text(id).to_owned(),
                    json!({"parent":null,"subIssues":[],"blockedBy":[],"blocks":[],"related":[]}),
                );
            }
            for row in self.all(
                &include_str!("relations.sql").replace("%PLACEHOLDERS%", &marks),
                &ids,
            )? {
                let relation = relations.get_mut(text(&row["relation_task_id"])).unwrap();
                let field = text(&row["relation_field"]);
                let value = rows::summary(&row);
                if field == "parent" {
                    relation[field] = value;
                } else {
                    relation[field].as_array_mut().unwrap().push(value);
                }
            }
            for row in self.all(&format!("SELECT id,task_id,CASE WHEN thread_id IS NULL AND agent_session IS NULL THEN NULL ELSE substr(body,1,512) END AS body,thread_id,thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path,agent_session,author_type,author_id,author_name,author_avatar_url,version,updated_at FROM comments WHERE task_id IN({marks}) ORDER BY task_id,id"),&ids)?{comments.entry(text(&row["task_id"]).into()).or_default().push(row);}
            for row in self.all(&format!("SELECT id,task_id,actor_type,actor_id,actor_name,actor_avatar_url,created_at FROM task_activities WHERE task_id IN({marks}) ORDER BY task_id,id"),&ids)?{activities.entry(text(&row["task_id"]).into()).or_default().push(row);}
            for row in self.all(&format!("SELECT attachments.* FROM attachments JOIN tasks ON tasks.id=attachments.task_id WHERE attachments.task_id IN({marks}) AND attachments.comment_id IS NULL AND attachments.content_type LIKE 'image/%' AND instr(tasks.description,'api/attachments/'||attachments.id||'/content')>0 ORDER BY attachments.task_id,attachments.created_at,attachments.id"),&ids)?{previews.entry(text(&row["task_id"]).to_owned()).or_insert_with(||rows::attachment(&row,false));}
            for row in self.all(
                &format!("SELECT * FROM issue_claim_queue WHERE task_id IN({marks})"),
                &ids,
            )? {
                claims.insert(text(&row["task_id"]).to_owned(), rows::claim(&row));
            }
        }
        let mut output = Vec::new();
        for row in records {
            let key = text(&row["id"]);
            let mut task = rows::task(row)?;
            task["relations"] = relations.remove(key).unwrap();
            task["claim"] = claims.remove(key).unwrap_or(Value::Null);
            let comments = comments.remove(key).unwrap_or_default();
            let acts = activities.remove(key).unwrap_or_default();
            let mut participants = Vec::new();
            let mut seen = HashSet::new();
            for participant in std::iter::once(actor(row, "creator"))
                .chain(std::iter::once(task["assignee"].clone()))
                .chain(comments.iter().map(|r| actor(r, "author")))
                .chain(acts.iter().map(|r| actor(r, "actor")))
            {
                let id = format!(
                    "{}:{}",
                    text(&participant["type"]),
                    text(&participant["id"])
                );
                if seen.insert(id) {
                    participants.push(participant);
                }
            }
            let comment_refs = comments
                .iter()
                .map(|c| {
                    let title = text(&c["body"])
                        .lines()
                        .map(str::trim)
                        .find(|s| !s.is_empty())
                        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
                        .unwrap_or_else(|| "评论".into());
                    let title = if title.chars().count() > 80 {
                        format!("{}…", title.chars().take(77).collect::<String>())
                    } else {
                        title
                    };
                    Ok((
                        "comment",
                        c["id"].clone(),
                        json!(title),
                        c["updated_at"].clone(),
                        rows::binding(c),
                        rows::legacy_thread(c),
                        parse_json(&c["agent_session"])?,
                    ))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            let mut refs = Vec::new();
            for (source, source_id, title, updated, binding, legacy, session) in std::iter::once((
                "task",
                task["id"].clone(),
                task["title"].clone(),
                task["updatedAt"].clone(),
                task["threadBinding"].clone(),
                task["legacyLocalThreadId"].clone(),
                task["agentSession"].clone(),
            ))
            .chain(comment_refs)
            {
                if !session.is_null() {
                    refs.push(json!({"agentSession":session,"source":source,"sourceId":source_id,"title":title,"updatedAt":updated}));
                }
                let mut reference = if !binding.is_null() {
                    binding
                } else if truth(&legacy) {
                    json!({"threadId":legacy,"legacyLocal":true})
                } else {
                    continue;
                };
                reference["source"] = json!(source);
                reference["sourceId"] = source_id;
                reference["title"] = title;
                reference["updatedAt"] = updated;
                refs.push(reference);
            }
            task["conversationRefs"] = json!(refs);
            task["participants"] = json!(participants);
            task["previewImage"] = previews.remove(key).unwrap_or(Value::Null);
            let task_key = json!([task["id"], task["version"], task["updatedAt"]]);
            let comment_key: Vec<Value> = comments
                .iter()
                .map(|c| json!([c["id"], c["version"], c["updated_at"]]))
                .collect();
            let change_key: Vec<Value> = acts
                .iter()
                .map(|a| json!([a["id"], a["created_at"]]))
                .collect();
            task["activityKey"] = json!(format!(
                "{{\"version\":1,\"task\":{},\"comments\":{},\"changes\":{}}}",
                task_key,
                json!(comment_key),
                json!(change_key)
            ));
            let mut latest = task["updatedAt"].clone();
            for v in comments
                .iter()
                .map(|c| &c["updated_at"])
                .chain(acts.iter().map(|a| &a["created_at"]))
            {
                if text(v) > text(&latest) {
                    latest = v.clone();
                }
            }
            task["activityUpdatedAt"] = latest;
            output.push(task);
        }
        Ok(output)
    }
    pub(super) fn record_activity(
        &self,
        task: &Value,
        actor: &Value,
        changes: &[Value],
        timestamp: &Value,
    ) -> Result<(), ApiError> {
        if changes.is_empty() {
            return Ok(());
        }
        self.run("INSERT INTO task_activities(id,task_id,actor_type,actor_id,actor_name,actor_avatar_url,changes,created_at) VALUES(?,?,?,?,?,?,?,?)",&[id(),task.clone(),actor["type"].clone(),actor["id"].clone(),actor["name"].clone(),actor["avatarUrl"].clone(),json!(json!(changes).to_string()),timestamp.clone()])?;
        Ok(())
    }
    pub(super) fn touch_task(
        &self,
        current: &Value,
        expected: &Value,
        thread: Option<&Value>,
        binding: Option<&Value>,
        timestamp: &Value,
        session: Option<&Value>,
    ) -> Result<(), ApiError> {
        let mut columns = Vec::new();
        let mut values = Vec::new();
        append_binding(&mut columns, &mut values, current, binding, thread, session);
        columns.extend(["version=version+1".into(), "updated_at=?".into()]);
        values.extend([timestamp.clone(), current["id"].clone(), expected.clone()]);
        if self.run(
            &format!(
                "UPDATE tasks SET {} WHERE id=? AND version=?",
                columns.join(",")
            ),
            &values,
        )? != 1
        {
            version(&self.require_task_record(&current["id"])?, expected, "Task")?;
        }
        Ok(())
    }
    pub(super) fn create_task(&self, input: &Value) -> Result<Value, ApiError> {
        self.transaction(||{let project=self.require_project(&input["projectId"])?;let raw=self.get("SELECT next_task_number FROM projects WHERE id=?",&[project["id"].clone()])?;let prefix=text(&project["issueKey"]);let max=self.get("SELECT MAX(CAST(substr(identifier,?) AS INTEGER)) AS number FROM tasks WHERE identifier GLOB ?",&[json!(prefix.len()+2),json!(format!("{prefix}-[0-9]*"))])?;let number=raw["next_task_number"].as_i64().unwrap_or(1).max(max["number"].as_i64().unwrap_or(0)+1);let id=fallback(&input["id"],id());let t=now();let order=if input.get("sortOrder").is_some()&&!input["sortOrder"].is_null(){input["sortOrder"].clone()}else{self.new_sort_order(&project["id"],&input["status"],&Value::Null,true)?};let mut labels=array(&project["labels"]);for label in array(&input["labels"]){if !labels.contains(&label){labels.push(label);}}
        self.run("UPDATE projects SET next_task_number=?,labels=?,updated_at=? WHERE id=?",&[json!(number+1),json!(json!(labels).to_string()),t.clone(),project["id"].clone()])?;
        let mut values=vec![id.clone(),json!(format!("{prefix}-{number}")),project["id"].clone(),input["title"].clone(),input["description"].clone(),input["status"].clone(),input["priority"].clone(),json!(input["labels"].to_string()),order];values.extend(rows::stored_binding(&Value::Null,input.get("threadBinding"),input.get("threadId")).unwrap_or(vec![Value::Null;5]));values.extend([input["actor"]["type"].clone(),input["actor"]["id"].clone(),input["actor"]["name"].clone(),input["actor"]["avatarUrl"].clone(),input["assignee"]["type"].clone(),input["assignee"]["id"].clone(),input["assignee"]["name"].clone(),input["assignee"]["avatarUrl"].clone()]);let context=&input["developmentContext"];values.extend([if context["type"]=="branch"{context["branch"].clone()}else{Value::Null},if context["type"]=="worktree"{context["path"].clone()}else{Value::Null},if context["type"]=="worktree"{context["branch"].clone()}else{Value::Null},input["startDate"].clone(),input["dueDate"].clone(),input["recurrence"]["interval"].clone(),input["recurrence"]["unit"].clone(),t.clone(),t,json_text(&input["agentSession"])]);
        self.run("INSERT INTO tasks(id,identifier,project_id,title,description,status,priority,labels,sort_order,thread_id,thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path,creator_type,creator_id,creator_name,creator_avatar_url,assignee_type,assignee_id,assignee_name,assignee_avatar_url,git_branch,worktree_path,worktree_branch,start_date,due_date,recurrence_interval,recurrence_unit,archived_at,version,created_at,updated_at,agent_session) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)",&values)?;self.get_task(&id)})
    }
    fn new_sort_order(
        &self,
        project: &Value,
        status: &Value,
        exclude: &Value,
        prepend: bool,
    ) -> Result<Value, ApiError> {
        let query = if prepend {
            "SELECT MIN(sort_order) AS value FROM tasks WHERE project_id=? AND status=? AND archived_at IS NULL AND id IS NOT ?"
        } else {
            "SELECT COALESCE(MAX(sort_order),0) AS value FROM tasks WHERE project_id=? AND status=? AND archived_at IS NULL AND id IS NOT ?"
        };
        let row = self.get(query, &[project.clone(), status.clone(), exclude.clone()])?;
        Ok(if prepend {
            row["value"]
                .as_f64()
                .map(|v| json!(v - 1000.0))
                .unwrap_or(json!(1000))
        } else {
            json!(row["value"].as_f64().unwrap_or(0.0) + 1000.0)
        })
    }
    pub(super) fn update_task(&self, args: &[Value]) -> Result<Value, ApiError> {
        let id = arg(args, 0);
        let expected = arg(args, 1);
        let changes = arg(args, 2);
        let current = self.require_task_record(&id)?;
        version(&current, &expected, "Task")?;
        self.assert_jira_mutation_unlocked(&current["id"], None, None)?;
        let status_changed =
            changes.get("status").is_some() && changes["status"] != current["status"];
        if status_changed {
            self.assert_jira_plan_allows_execution(&current["id"], &changes["status"])?;
        }
        let target = if changes.get("projectId").is_some() {
            self.require_project(&changes["projectId"])?
        } else {
            Value::Null
        };
        let moved = !target.is_null() && target["id"] != current["projectId"];
        if moved {
            let link = self.get(
                "SELECT jira_task_id FROM jira_task_links WHERE task_id=?",
                &[current["id"].clone()],
            )?;
            if !link.is_null()
                && self
                    .get(
                        "SELECT 1 FROM jira_task_projects WHERE jira_task_id=? AND project_id=?",
                        &[link["jira_task_id"].clone(), target["id"].clone()],
                    )?
                    .is_null()
            {
                return Err(ApiError::new(
                    409,
                    "JIRA_PROJECT_MOVE_BLOCKED",
                    "This issue can only move to a project linked to its Jira issue",
                ));
            }
            if !current["developmentContext"].is_null() {
                return Err(ApiError::new(
                    409,
                    "DEVELOPMENT_CONTEXT_PROJECT_MOVE_BLOCKED",
                    "Clear the issue development context before moving it to another project",
                ));
            }
            if !self.get("SELECT 1 FROM task_relations WHERE source_task_id=? OR target_task_id=? LIMIT 1",&[current["id"].clone(),current["id"].clone()])?.is_null(){return Err(ApiError::new(409,"CROSS_PROJECT_RELATION","Remove issue relations before moving the issue to another project"));}
            if self.ai_project_conflict(&current["id"], &target["id"])? {
                return Err(ApiError::new(409,"AI_CHAT_PROJECT_MOVE_BLOCKED","Delete issue-linked AI conversations before moving the issue to another project"));
            }
        }
        let due = changes.get("dueDate").unwrap_or(&current["dueDate"]);
        let recurrence = changes.get("recurrence").unwrap_or(&current["recurrence"]);
        if truth(recurrence) && !truth(due) {
            return Err(ApiError::new(
                400,
                "INVALID_FIELD",
                "A recurring issue requires a due date",
            ));
        }
        let mut columns = Vec::new();
        let mut values = Vec::new();
        for (key, value) in changes
            .as_object()
            .ok_or_else(|| ApiError::new(400, "INVALID_FIELD", "Task changes must be an object"))?
        {
            match key.as_str() {
                "developmentContext" => {
                    columns.extend([
                        "git_branch=?".into(),
                        "worktree_path=?".into(),
                        "worktree_branch=?".into(),
                    ]);
                    values.extend([
                        if value["type"] == "branch" {
                            value["branch"].clone()
                        } else {
                            Value::Null
                        },
                        if value["type"] == "worktree" {
                            value["path"].clone()
                        } else {
                            Value::Null
                        },
                        if value["type"] == "worktree" {
                            value["branch"].clone()
                        } else {
                            Value::Null
                        },
                    ]);
                }
                "recurrence" => {
                    columns.extend(["recurrence_interval=?".into(), "recurrence_unit=?".into()]);
                    values.extend([value["interval"].clone(), value["unit"].clone()]);
                }
                "assignee" => {
                    for (k, col) in [
                        ("type", "assignee_type"),
                        ("id", "assignee_id"),
                        ("name", "assignee_name"),
                        ("avatarUrl", "assignee_avatar_url"),
                    ] {
                        columns.push(format!("{col}=?"));
                        values.push(value[k].clone());
                    }
                }
                _ => {
                    let col = match key.as_str() {
                        "projectId" => "project_id",
                        "title" => "title",
                        "description" => "description",
                        "status" => "status",
                        "priority" => "priority",
                        "labels" => "labels",
                        "startDate" => "start_date",
                        "dueDate" => "due_date",
                        _ => {
                            return Err(ApiError::new(
                                400,
                                "INVALID_FIELD",
                                format!("Unknown task field '{key}'"),
                            ))
                        }
                    };
                    columns.push(format!("{col}=?"));
                    values.push(if key == "labels" {
                        json!(value.to_string())
                    } else {
                        value.clone()
                    });
                }
            }
        }
        if status_changed {
            columns.push("sort_order=?".into());
            values.push(self.new_sort_order(
                if moved {
                    &target["id"]
                } else {
                    &current["projectId"]
                },
                &changes["status"],
                &current["id"],
                true,
            )?);
        }
        let stored = rows::stored_binding(&current, optional(args, 4), optional(args, 3));
        if changes.get("projectId").is_none() {
            append_binding(
                &mut columns,
                &mut values,
                &current,
                optional(args, 4),
                optional(args, 3),
                optional(args, 6),
            );
        } else if let Some(session) = optional(args, 6) {
            columns.push("agent_session=?".into());
            values.push(json_text(session));
        }
        let t = now();
        columns.extend(["version=version+1".into(), "updated_at=?".into()]);
        values.extend([t.clone(), current["id"].clone(), expected.clone()]);
        self.transaction(||{if current["source"]=="jira"&&status_changed{self.sync_jira_lifecycle(&current,&changes["status"],&t)?;}if truth(&arg(args,7))&&stored.as_ref().map(|s|truth(&s[0])&&s[0]!=current["threadId"]).unwrap_or(false)&&truth(&current["threadId"])&&changes.get("projectId").is_none(){let new_thread=&stored.as_ref().unwrap()[0];let actor=arg(args,5);self.run("INSERT INTO comments(id,task_id,body,thread_id,thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path,author_type,author_id,author_name,author_avatar_url,version,created_at,updated_at,change_revision) SELECT ?,id,?,thread_id,thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path,?,?,?,?,1,?,?,? FROM tasks WHERE id=?",&[super::id(),json!(format!("执行会话已从 {} 转交至 {}。保留原会话记录，沿用任务开发上下文。",text(&current["threadId"]),text(new_thread))),actor["type"].clone(),actor["id"].clone(),actor["name"].clone(),actor["avatarUrl"].clone(),t.clone(),t.clone(),self.next_revision()?,current["id"].clone()])?;}
            if self.run(&format!("UPDATE tasks SET {} WHERE id=? AND version=?",columns.join(",")),&values)?!=1{version(&self.require_task_record(&id)?,&expected,"Task")?;}if changes.get("description").is_some(){self.consume_attachment_fallback(&current["id"],&Value::Null)?;}if moved{self.run("UPDATE projects SET updated_at=? WHERE id IN(?,?)",&[t.clone(),current["projectId"].clone(),target["id"].clone()])?;}
            let destination=if moved{&target["id"]}else{&current["projectId"]};let p=self.require_project(destination)?;let mut labels=array(&p["labels"]);for value in array(changes.get("labels").unwrap_or(&current["labels"])){if !labels.contains(&value){labels.push(value);}}if labels!=array(&p["labels"]){self.run("UPDATE projects SET labels=?,updated_at=? WHERE id=?",&[json!(json!(labels).to_string()),t.clone(),destination.clone()])?;}
            self.record_activity(&current["id"],&arg(args,5),&rows::changes(&current,&changes),&t)?;if changes["status"]=="done"{self.archive_for_task(&current,&t)?;}Ok(())})?;
        self.get_task(&current["id"])
    }
    fn archive_for_task(&self, current: &Value, timestamp: &Value) -> Result<(), ApiError> {
        let jira = if current["source"] == "jira" {
            current["id"].clone()
        } else {
            self.get(
                "SELECT jira_task_id FROM jira_task_links WHERE task_id=?",
                &[current["id"].clone()],
            )?["jira_task_id"]
                .clone()
        };
        if !jira.is_null() {
            self.archive_completed_jira_threads(timestamp, &jira, false)?;
        }
        Ok(())
    }
    fn move_task(&self, args: &[Value]) -> Result<Value, ApiError> {
        let current = self.require_task(&arg(args, 0))?;
        let expected = arg(args, 1);
        let status = arg(args, 2);
        version(&current, &expected, "Task")?;
        self.assert_jira_mutation_unlocked(&current["id"], None, None)?;
        if !current["archivedAt"].is_null() {
            return Err(ApiError::new(
                409,
                "TASK_ARCHIVED",
                "Archived tasks cannot be moved",
            ));
        }
        let changed = status != current["status"];
        if changed {
            self.assert_jira_plan_allows_execution(&current["id"], &status)?;
        }
        let order = if arg(args, 3).is_null() {
            self.new_sort_order(&current["projectId"], &status, &current["id"], changed)?
        } else {
            arg(args, 3)
        };
        let t = now();
        self.transaction(|| {
            if current["source"] == "jira" && changed {
                self.sync_jira_lifecycle(&current, &status, &t)?;
            }
            let mut columns = vec!["status=?".to_owned(), "sort_order=?".to_owned()];
            let mut values = vec![status.clone(), order];
            append_binding(
                &mut columns,
                &mut values,
                &current,
                optional(args, 5),
                optional(args, 4),
                optional(args, 7),
            );
            columns.extend(["version=version+1".into(), "updated_at=?".into()]);
            values.extend([t.clone(), current["id"].clone(), expected.clone()]);
            if self.run(
                &format!(
                    "UPDATE tasks SET {} WHERE id=? AND version=?",
                    columns.join(",")
                ),
                &values,
            )? != 1
            {
                version(
                    &self.require_task_record(&current["id"])?,
                    &expected,
                    "Task",
                )?;
            }
            self.record_activity(
                &current["id"],
                &arg(args, 6),
                &rows::changes(&current, &json!({"status":status})),
                &t,
            )?;
            if status == "done" {
                self.archive_for_task(&current, &t)?;
            }
            Ok(())
        })?;
        self.get_task(&current["id"])
    }
    fn archive_task(&self, method: &str, args: &[Value]) -> Result<Value, ApiError> {
        self.transaction(|| {
            let current = self.require_task(&arg(args, 0))?;
            let expected = arg(args, 1);
            version(&current, &expected, "Task")?;
            self.assert_jira_mutation_unlocked(&current["id"], None, None)?;
            if method != "archiveTask" && current["archivedAt"].is_null() {
                return Err(ApiError::new(
                    409,
                    "TASK_NOT_ARCHIVED",
                    if method == "restoreTask" {
                        "Only archived tasks can be restored"
                    } else {
                        "Only archived tasks can be deleted"
                    },
                ));
            }
            if method == "deleteArchivedTask" {
                if !self
                    .get(
                        "SELECT jira_task_id FROM jira_task_links WHERE task_id=?",
                        &[current["id"].clone()],
                    )?
                    .is_null()
                {
                    return Err(ApiError::new(
                        409,
                        "JIRA_LINK_DELETE_BLOCKED",
                        "Unlink the Jira issue before permanently deleting this issue",
                    ));
                }
                let attachments: Vec<_> = self
                    .all(
                        "SELECT id FROM attachments WHERE task_id=? ORDER BY created_at,id",
                        &[current["id"].clone()],
                    )?
                    .iter()
                    .map(|r| r["id"].clone())
                    .collect();
                if self.run(
                    "DELETE FROM tasks WHERE id=? AND version=? AND archived_at IS NOT NULL",
                    &[current["id"].clone(), expected.clone()],
                )? != 1
                {
                    version(
                        &self.require_task_record(&current["id"])?,
                        &expected,
                        "Task",
                    )?;
                }
                return Ok(json!({"task":current,"attachmentIds":attachments}));
            }
            let t = now();
            let archived = if method == "archiveTask" {
                t.clone()
            } else {
                Value::Null
            };
            let mut columns = vec!["archived_at=?".to_owned()];
            let mut values = vec![archived.clone()];
            append_binding(
                &mut columns,
                &mut values,
                &current,
                optional(args, 3),
                optional(args, 2),
                optional(args, 5),
            );
            columns.extend(["version=version+1".into(), "updated_at=?".into()]);
            values.extend([t.clone(), current["id"].clone(), expected.clone()]);
            if self.run(
                &format!(
                    "UPDATE tasks SET {} WHERE id=? AND version=?",
                    columns.join(",")
                ),
                &values,
            )? != 1
            {
                version(
                    &self.require_task_record(&current["id"])?,
                    &expected,
                    "Task",
                )?;
            }
            self.record_activity(
                &current["id"],
                &arg(args, 4),
                &[json!({"field":"archivedAt","before":current["archivedAt"],"after":archived})],
                &t,
            )?;
            if method == "restoreTask" {
                let link = self.get(
                    "SELECT jira_task_id FROM jira_task_links WHERE task_id=?",
                    &[current["id"].clone()],
                )?;
                if !link.is_null() {
                    self.archive_completed_jira_threads(&t, &link["jira_task_id"], false)?;
                }
            }
            self.get_task(&current["id"])
        })
    }
    fn relation(&self, method: &str, args: &[Value]) -> Result<Value, ApiError> {
        self.transaction(||{let task=self.require_task(&arg(args,0))?;let related=self.require_task(&arg(args,3))?;let expected=arg(args,1);version(&task,&expected,"Task")?;let kind=arg(args,2);let kind=text(&kind);if task["id"]==related["id"]{return Err(ApiError::new(400,"SELF_RELATION","An issue cannot be related to itself"));}if task["projectId"]!=related["projectId"]&&!matches!(kind,"blocks"|"blocked_by"){return Err(ApiError::new(400,"CROSS_PROJECT_RELATION","Issue relations must stay within one project"));}
        let(rel_type,source,target)=match kind{"parent"=>("parent",related["id"].clone(),task["id"].clone()),"blocks"=>("blocks",task["id"].clone(),related["id"].clone()),"blocked_by"=>("blocks",related["id"].clone(),task["id"].clone()),_=>("related",if text(&task["id"])<text(&related["id"]){task["id"].clone()}else{related["id"].clone()},if text(&task["id"])<text(&related["id"]){related["id"].clone()}else{task["id"].clone()})};
        let existing=self.get("SELECT origin FROM task_relations WHERE relation_type=? AND source_task_id=? AND target_task_id=?",&[json!(rel_type),source.clone(),target.clone()])?;let t=now();let origin=arg(args,7);
        let changes=if method=="addTaskRelation"{
            if !existing.is_null(){return Err(ApiError::new(409,"RELATION_EXISTS",if rel_type=="parent"{"This parent relation already exists"}else{"This issue relation already exists"}));}
            if rel_type=="parent"{let cycle=self.get("WITH RECURSIVE ancestors(id) AS(SELECT source_task_id FROM task_relations WHERE relation_type='parent' AND target_task_id=? UNION SELECT task_relations.source_task_id FROM task_relations JOIN ancestors ON task_relations.target_task_id=ancestors.id WHERE task_relations.relation_type='parent') SELECT 1 FROM ancestors WHERE id=?",&[related["id"].clone(),task["id"].clone()])?;if !cycle.is_null(){return Err(ApiError::new(409,"RELATION_CYCLE","This parent would create a cycle"));}self.run("DELETE FROM task_relations WHERE relation_type='parent' AND target_task_id=?",&[task["id"].clone()])?;}
            self.run("INSERT INTO task_relations(relation_type,source_task_id,target_task_id,origin,created_at) VALUES(?,?,?,?,?)",&[json!(rel_type),source.clone(),target.clone(),fallback(&origin,json!("manual")),t.clone()])?;vec![json!({"field":"relation","before":if kind=="parent"&&!task["relations"]["parent"].is_null(){rows::relation_value(kind,&task["relations"]["parent"])}else{Value::Null},"after":rows::relation_value(kind,&related)})]
        }else{
            if existing.is_null(){return Err(ApiError::new(404,"RELATION_NOT_FOUND","This issue relation does not exist"));}
            if truth(&origin)&&origin!=existing["origin"]{return Ok(json!({"task":task,"relatedTask":related}));}
            let deleted=if origin=="mention"&&rel_type=="related"{let reference=|id:&Value|format!("](?{})",url::form_urlencoded::Serializer::new(String::new()).append_pair("project",text(&task["projectId"])).append_pair("issue",text(id)).finish());let a=reference(&related["identifier"]);let b=reference(&task["identifier"]);self.run("DELETE FROM task_relations WHERE relation_type=? AND source_task_id=? AND target_task_id=? AND origin='mention' AND NOT EXISTS(SELECT 1 FROM tasks WHERE(id=? AND instr(description,?)>0)OR(id=? AND instr(description,?)>0)) AND NOT EXISTS(SELECT 1 FROM comments WHERE(task_id=? AND instr(body,?)>0)OR(task_id=? AND instr(body,?)>0))",&[json!(rel_type),source,target,task["id"].clone(),json!(a),related["id"].clone(),json!(b),task["id"].clone(),json!(a),related["id"].clone(),json!(b)])?}else{self.run("DELETE FROM task_relations WHERE relation_type=? AND source_task_id=? AND target_task_id=?",&[json!(rel_type),source,target])?};
            if deleted==0&&origin=="mention"&&rel_type=="related"{return Ok(json!({"task":task,"relatedTask":related}));}vec![json!({"field":"relation","before":rows::relation_value(kind,&related),"after":null})]
        };
        self.touch_task(&task,&expected,optional(args,4),optional(args,5),&t,optional(args,8))?;self.record_activity(&task["id"],&arg(args,6),&changes,&t)?;Ok(json!({"task":self.get_task(&task["id"])?,"relatedTask":self.get_task(&related["id"]) ?}))
    })
    }
    pub(super) fn call_tasks(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "listTasks",
            "getTask",
            "getTaskSource",
            "resolveTaskReference",
            "getTaskTree",
            "createTask",
            "updateTask",
            "moveTask",
            "archiveTask",
            "restoreTask",
            "deleteArchivedTask",
            "addTaskRelation",
            "removeTaskRelation",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            match method {
                "getTask" => self.get_task(&a),
                "createTask" => self.create_task(&a),
                "updateTask" => self.update_task(args),
                "moveTask" => self.move_task(args),
                "archiveTask" | "restoreTask" | "deleteArchivedTask" => {
                    self.archive_task(method, args)
                }
                "addTaskRelation" | "removeTaskRelation" => self.relation(method, args),
                "getTaskSource" => {
                    let row = self.get(
                        "SELECT external_source FROM tasks WHERE id=? OR identifier=?",
                        &[a.clone(), a],
                    )?;
                    Ok(if row.is_null() {
                        Value::Null
                    } else {
                        json!(if row["external_source"] == "jira" {
                            "jira"
                        } else {
                            "local"
                        })
                    })
                }
                "resolveTaskReference" => {
                    let exact = self.get_task(&a)?;
                    if !exact.is_null() {
                        return Ok(exact);
                    }
                    let matches = self.all(
                        "SELECT id FROM tasks WHERE external_key=? ORDER BY created_at,id LIMIT 2",
                        &[a.clone()],
                    )?;
                    if matches.len() > 1 {
                        return Err(ApiError::new(
                            409,
                            "TASK_REFERENCE_AMBIGUOUS",
                            format!(
                                "Task reference '{}' matches more than one external issue",
                                text(&a)
                            ),
                        ));
                    }
                    if let Some(row) = matches.first() {
                        self.get_task(&row["id"])
                    } else {
                        Ok(Value::Null)
                    }
                }
                "listTasks" => {
                    let mut filters = Vec::new();
                    let mut values = Vec::new();
                    for (key, column) in [("projectId", "project_id"), ("status", "status")] {
                        if truth(&a[key]) {
                            filters.push(format!("{column}=?"));
                            values.push(a[key].clone());
                        }
                    }
                    if a["archived"] == "false" {
                        filters.push("archived_at IS NULL".into());
                    } else if a["archived"] == "true" {
                        filters.push("archived_at IS NOT NULL".into());
                    }
                    let where_clause = if filters.is_empty() {
                        String::new()
                    } else {
                        format!("WHERE {}", filters.join(" AND "))
                    };
                    let records=self.all(&format!("SELECT * FROM tasks {where_clause} ORDER BY CASE status WHEN 'backlog' THEN 1 WHEN 'todo' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'in_review' THEN 4 WHEN 'blocked' THEN 5 WHEN 'done' THEN 6 WHEN 'canceled' THEN 7 END,sort_order,created_at,id"),&values)?;
                    Ok(json!(self.decorate_tasks(&records)?))
                }
                "getTaskTree" => {
                    let row = self.get(
                        "SELECT * FROM tasks WHERE id=? OR identifier=?",
                        &[a.clone(), a.clone()],
                    )?;
                    if row.is_null() {
                        return Err(missing("Task", &a));
                    }
                    let direction = arg(args, 1);
                    let depth = arg(args, 2).as_u64().unwrap_or_default();
                    let root = tree_node(&row, &Value::Null, 0, json!([row["id"]]));
                    let mut nodes = vec![root.clone()];
                    let mut frontier = vec![root];
                    let mut seen = HashSet::from([text(&row["id"]).to_owned()]);
                    let (next, parent) = if direction == "descendants" {
                        ("target_task_id", "source_task_id")
                    } else {
                        ("source_task_id", "target_task_id")
                    };
                    for level in 1..=depth {
                        if frontier.is_empty() {
                            break;
                        }
                        let ids: Vec<_> = frontier.iter().map(|n| n["id"].clone()).collect();
                        let rows=self.all(&format!("SELECT tasks.*,task_relations.{parent} AS tree_parent_id FROM task_relations JOIN tasks ON tasks.id=task_relations.{next} WHERE task_relations.relation_type='parent' AND task_relations.{parent} IN({}) ORDER BY tasks.sort_order,tasks.created_at,tasks.id",placeholders(ids.len())),&ids)?;
                        let mut next_frontier = Vec::new();
                        for p in &frontier {
                            for r in rows.iter().filter(|r| r["tree_parent_id"] == p["id"]) {
                                if !seen.insert(text(&r["id"]).into()) {
                                    continue;
                                }
                                if nodes.len() >= 1000 {
                                    return Err(ApiError::new(
                                        413,
                                        "TREE_TOO_LARGE",
                                        "Task tree cannot exceed 1000 nodes",
                                    ));
                                }
                                let mut path = array(&p["path"]);
                                path.push(r["id"].clone());
                                let node = tree_node(r, &p["id"], level, json!(path));
                                nodes.push(node.clone());
                                next_frontier.push(node);
                            }
                        }
                        frontier = next_frontier;
                    }
                    Ok(
                        json!({"rootId":row["id"],"direction":direction,"depth":depth,"nodeCount":nodes.len(),"nodes":nodes}),
                    )
                }
                _ => unreachable!(),
            }
        })())
    }
}
