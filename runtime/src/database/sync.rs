use super::*;
#[path = "sync_sql.rs"]
mod sql;
impl Database {
    fn duplicate_needs_decision(
        &self,
        id: &Value,
        duplicate: &Value,
        lifecycle: &Value,
    ) -> Result<bool, ApiError> {
        if !truth(duplicate) {
            return Ok(false);
        }
        let linked = !self
            .get(sql::JIRA_DUPLICATE_NEEDS_DECISION[0], &[id.clone()])?
            .is_null();
        Ok(linked
            && (lifecycle["pending"]["kind"] == "duplicate"
                || lifecycle["duplicateOf"]["externalKey"] != duplicate["externalKey"]))
    }
    fn sync_jira_duplicate(
        &self,
        task: &Value,
        duplicate: &Value,
        timestamp: &Value,
    ) -> Result<(), ApiError> {
        let lifecycle = self.jira_lifecycle(&task["id"])?;
        if !truth(duplicate) {
            if !lifecycle["duplicateOf"].is_null() {
                self.run(
                    sql::SYNC_JIRA_DUPLICATE[0],
                    &[timestamp.clone(), task["id"].clone()],
                )?;
            }
            return Ok(());
        }
        let canonical = if truth(&duplicate["accessible"]) && truth(&duplicate["externalKey"]) {
            self.get(
                sql::SYNC_JIRA_DUPLICATE[1],
                &[
                    task["external_origin"].clone(),
                    duplicate["externalKey"].clone(),
                ],
            )?
        } else {
            Value::Null
        };
        let kind = if self.duplicate_needs_decision(&task["id"], duplicate, &lifecycle)? {
            json!("duplicate")
        } else {
            lifecycle["pending"]["kind"].clone()
        };
        if lifecycle["duplicateOf"]["externalKey"] == duplicate["externalKey"]
            && lifecycle["duplicateOf"]["jiraTaskId"] == canonical["id"]
            && lifecycle["pending"]["kind"] == kind
        {
            return Ok(());
        }
        self.run(
            sql::SYNC_JIRA_DUPLICATE[2],
            &[
                task["id"].clone(),
                kind.clone(),
                if kind == "duplicate" {
                    timestamp.clone()
                } else {
                    Value::Null
                },
                duplicate["externalKey"].clone(),
                canonical["id"].clone(),
                timestamp.clone(),
            ],
        )?;
        Ok(())
    }
    pub(super) fn sync_jira_tasks(
        &self,
        issues: &Value,
        options: &Value,
    ) -> Result<Value, ApiError> {
        // 生命周期人工处理期间暂停同步，避免远端结果覆盖未完成的本地决策。
        if !self.jira_pause_resolutions.borrow().is_empty() {
            return Err(ApiError::new(
                409,
                "JIRA_PAUSE_IN_PROGRESS",
                "Jira sync is waiting for a lifecycle pause to finish",
            ));
        }
        if !self.jira_reopen_actions.borrow().is_empty() {
            return Err(ApiError::new(
                409,
                "JIRA_REOPEN_ACTION_IN_PROGRESS",
                "Jira sync is waiting for a reopened action to finish",
            ));
        }
        let timestamp = fallback(&options["syncedAt"], now());
        let archive_missing = options.get("archiveMissing").map(truth).unwrap_or(true);
        let mut seen = HashSet::new();
        let mut project_labels = Vec::new();
        for issue in array(issues) {
            for label in array(&issue["labels"]) {
                if !project_labels.contains(&label) {
                    project_labels.push(label);
                }
            }
        }
        self.transaction(|| {
            let existing = self.get(sql::SYNC_JIRA_TASKS[0], &[json!("jira-my-tasks")])?;
            let keys = self
                .all(
                    "SELECT issue_key FROM projects WHERE issue_key IS NOT NULL",
                    &[],
                )?
                .iter()
                .map(|r| text(&r["issue_key"]).to_owned())
                .collect();
            let key = fallback(
                &existing["issue_key"],
                json!(schema::issue_key(
                    &json!({"id":"jira-my-tasks","name":options["projectName"]}),
                    &keys
                )),
            );
            self.run(
                sql::SYNC_JIRA_TASKS[1],
                &[
                    json!("jira-my-tasks"),
                    options["projectName"].clone(),
                    key,
                    json!(json!(project_labels).to_string()),
                    timestamp.clone(),
                    timestamp.clone(),
                ],
            )?;
            let legacy = &options["legacyIdentity"];
            if truth(legacy) {
                for task in self.all(
                    sql::SYNC_JIRA_TASKS[4],
                    &[
                        json!("jira-my-tasks"),
                        json!(format!("{}:", text(&legacy["urlHash"]))),
                    ],
                )? {
                    let external = text(&task["external_id"])
                        .chars()
                        .skip(17)
                        .collect::<String>();
                    self.run(
                        sql::SYNC_JIRA_TASKS[3],
                        &[
                            json!(format!(
                                "JIRA:{}:{external}",
                                text(&legacy["originId"]).to_uppercase()
                            )),
                            legacy["originId"].clone(),
                            json!(external),
                            task["identifier"].clone(),
                            task["id"].clone(),
                        ],
                    )?;
                }
            }
            for issue in array(issues) {
                let existing = self.get(
                    sql::SYNC_JIRA_TASKS[2],
                    &[issue["externalOrigin"].clone(), issue["externalId"].clone()],
                )?;
                seen.insert(
                    text(if existing.is_null() {
                        &issue["id"]
                    } else {
                        &existing["id"]
                    })
                    .to_owned(),
                );
                let labels = json!(issue["labels"].to_string());
                let external_updated =
                    fallback(&issue["externalUpdatedAt"], issue["updatedAt"].clone());
                if existing.is_null() {
                    let mut values = vec![
                        issue["id"].clone(),
                        issue["identifier"].clone(),
                        json!("jira-my-tasks"),
                        issue["title"].clone(),
                        issue["description"].clone(),
                        issue["status"].clone(),
                        issue["priority"].clone(),
                        labels,
                        issue["sortOrder"].clone(),
                    ];
                    for actor in ["creator", "assignee"] {
                        values.extend([
                            issue[actor]["type"].clone(),
                            issue[actor]["id"].clone(),
                            issue[actor]["name"].clone(),
                            issue[actor]["avatarUrl"].clone(),
                        ]);
                    }
                    values.extend([
                        issue["dueDate"].clone(),
                        issue["externalOrigin"].clone(),
                        issue["externalId"].clone(),
                        issue["externalKey"].clone(),
                        issue["externalUrl"].clone(),
                        issue["externalStatus"].clone(),
                        external_updated,
                        timestamp.clone(),
                        if truth(&issue["archived"]) {
                            timestamp.clone()
                        } else {
                            Value::Null
                        },
                        issue["createdAt"].clone(),
                        issue["updatedAt"].clone(),
                    ]);
                    self.run(sql::SYNC_JIRA_TASKS[5], &values)?;
                    continue;
                }
                self.sync_jira_lifecycle(&existing, &issue["status"], &timestamp)?;
                let lifecycle = self.jira_lifecycle(&existing["id"])?;
                let archived = truth(&issue["archived"])
                    && lifecycle["pending"]["kind"] != "ended"
                    && !self.duplicate_needs_decision(
                        &existing["id"],
                        &issue["duplicateOf"],
                        &lifecycle,
                    )?;
                let mut field_values = vec![
                    ("identifier", issue["identifier"].clone()),
                    ("title", issue["title"].clone()),
                    ("description", issue["description"].clone()),
                    ("status", issue["status"].clone()),
                    ("priority", issue["priority"].clone()),
                    ("labels", labels),
                    ("sort_order", issue["sortOrder"].clone()),
                ];
                for (prefix, actor) in [("creator", "creator"), ("assignee", "assignee")] {
                    field_values.extend([
                        (
                            if prefix == "creator" {
                                "creator_type"
                            } else {
                                "assignee_type"
                            },
                            issue[actor]["type"].clone(),
                        ),
                        (
                            if prefix == "creator" {
                                "creator_id"
                            } else {
                                "assignee_id"
                            },
                            issue[actor]["id"].clone(),
                        ),
                        (
                            if prefix == "creator" {
                                "creator_name"
                            } else {
                                "assignee_name"
                            },
                            issue[actor]["name"].clone(),
                        ),
                        (
                            if prefix == "creator" {
                                "creator_avatar_url"
                            } else {
                                "assignee_avatar_url"
                            },
                            issue[actor]["avatarUrl"].clone(),
                        ),
                    ]);
                }
                for (column, key) in [
                    ("due_date", "dueDate"),
                    ("external_origin", "externalOrigin"),
                    ("external_id", "externalId"),
                    ("external_key", "externalKey"),
                    ("external_url", "externalUrl"),
                    ("external_status", "externalStatus"),
                ] {
                    field_values.push((column, issue[key].clone()));
                }
                field_values.push(("external_updated_at", external_updated));
                let changed = field_values
                    .iter()
                    .any(|(key, value)| !same(&existing[*key], value))
                    || !existing["external_sync_error"].is_null()
                    || truth(&existing["archived_at"]) != archived;
                if !changed {
                    self.run(
                        sql::SYNC_JIRA_TASKS[7],
                        &[timestamp.clone(), existing["id"].clone()],
                    )?;
                    continue;
                }
                let mut values: Vec<_> = field_values.into_iter().map(|(_, v)| v).collect();
                values.extend([
                    timestamp.clone(),
                    if archived {
                        timestamp.clone()
                    } else {
                        Value::Null
                    },
                    issue["updatedAt"].clone(),
                    existing["id"].clone(),
                ]);
                self.run(sql::SYNC_JIRA_TASKS[6], &values)?;
            }
            for issue in array(issues) {
                let task = self.get(
                    sql::SYNC_JIRA_TASKS[2],
                    &[issue["externalOrigin"].clone(), issue["externalId"].clone()],
                )?;
                if !task.is_null() {
                    self.sync_jira_duplicate(&task, &issue["duplicateOf"], &timestamp)?;
                }
            }
            let unknown = array(&options["unknownTasks"]);
            if archive_missing {
                let unknown_ids: HashSet<_> =
                    unknown.iter().map(|v| text(&v["id"]).to_owned()).collect();
                for task in self.all(
                    sql::SYNC_JIRA_TASKS[8],
                    &[
                        json!("jira-my-tasks"),
                        options["originId"].clone(),
                        options["originId"].clone(),
                    ],
                )? {
                    let key = text(&task["id"]);
                    if !seen.contains(key) && !unknown_ids.contains(key) {
                        self.run(
                            sql::SYNC_JIRA_TASKS[9],
                            &[timestamp.clone(), timestamp.clone(), task["id"].clone()],
                        )?;
                    }
                }
            }
            for task in unknown {
                self.run(
                    sql::SYNC_JIRA_TASKS[10],
                    &[task["message"].clone(), task["id"].clone()],
                )?;
            }
            self.archive_completed_jira_threads(&timestamp, &Value::Null, false)?;
            self.run(
                sql::SYNC_JIRA_TASKS[11],
                &[timestamp.clone(), json!("jira-my-tasks")],
            )?;
            Ok(Value::Null)
        })
    }
}
