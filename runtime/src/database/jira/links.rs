use super::*;

impl Database {
    pub(super) fn call_jira_links(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if !["setJiraProjects", "addJiraTaskLink", "removeJiraTaskLink"].contains(&method) {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let expected = arg(args, 1);
            let values = arg(args, 2);
            let actor = arg(args, 3);
            let jira = self.require_task(&a)?;
            let a = jira["id"].clone();
            version(&jira, &expected, "Task")?;
            if jira["source"] != "jira" {
                return Err(conflict(
                    "JIRA_TASK_REQUIRED",
                    "Only Jira issues can link repositories",
                ));
            }
            if method == "setJiraProjects" {
                self.assert_jira_mutation_unlocked(&jira, None, None)?;
                let mut projects = array(&values);
                projects.sort_by(|a, b| text(a).cmp(text(b)));
                projects.dedup();
                let workspace_ids = array(&arg(args, 4));
                if !projects.is_empty() {
                    let marks = vec!["?"; projects.len()].join(",");
                    let mut arguments = projects.clone();
                    arguments.push(json!("jira-my-tasks"));
                    let rows=self.all(&format!("SELECT id,workspace_path FROM projects WHERE id IN ({marks}) AND id!=?"),&arguments)?;
                    if rows.len() != projects.len()
                        || rows.iter().any(|p| {
                            p["workspace_path"].is_null() && !workspace_ids.contains(&p["id"])
                        })
                    {
                        return Err(ApiError::new(
                            400,
                            "JIRA_PROJECT_INVALID",
                            "Jira can only link projects with a local workspace",
                        ));
                    }
                }
                let current=self.all("SELECT project_id FROM jira_task_projects WHERE jira_task_id=? ORDER BY project_id",&[a.clone()])?.iter().map(|r|r["project_id"].clone()).collect::<Vec<_>>();
                if current == projects {
                    return self.jira_context(&a);
                }
                let timestamp = now();
                self.transaction(||{
                    let marks=if projects.is_empty(){"NULL".into()}else{vec!["?";projects.len()].join(",")};let mut parameters=vec![a.clone()];parameters.extend(projects.clone());
                    let invalid=self.get(&format!("SELECT tasks.identifier FROM jira_task_links JOIN tasks ON tasks.id=jira_task_links.task_id WHERE jira_task_links.jira_task_id=? AND tasks.project_id NOT IN ({marks}) ORDER BY tasks.identifier LIMIT 1"),&parameters)?;
                    if !invalid.is_null(){return Err(conflict("JIRA_PROJECT_HAS_LINKED_ISSUES",&format!("Unlink or move '{}' before removing its project",text(&invalid["identifier"]))));}
                    self.run("DELETE FROM jira_task_projects WHERE jira_task_id=?",&[a.clone()])?;
                    for project in &projects{self.run("INSERT INTO jira_task_projects(jira_task_id,project_id,created_at) VALUES(?,?,?)",&[a.clone(),project.clone(),timestamp.clone()])?;}
                    self.record_activity(&jira["id"],&actor,&[json!({"field":"jiraProjects","before":current,"after":projects})],&timestamp)?;
                    self.touch_task(&jira,&expected,Some(&Value::Null),Some(&Value::Null),&timestamp,None)?;
                    self.archive_completed_jira_threads(&timestamp,&a,false)
                })?;
                return self.jira_context(&a);
            }
            let task = self.require_task(&values)?;
            if task["source"] == "jira" {
                return Err(conflict(
                    "JIRA_LINK_INVALID",
                    "Link one Jira issue to one Panel issue",
                ));
            }
            let reservation = arg(args, 4);
            self.assert_jira_mutation_unlocked(
                &jira,
                if reservation.is_null() {
                    None
                } else {
                    Some(&reservation)
                },
                None,
            )?;
            if method == "addJiraTaskLink" {
                if !task["archivedAt"].is_null() {
                    return Err(conflict(
                        "TASK_ARCHIVED",
                        "Archived issues cannot be linked to Jira",
                    ));
                }
                if self.jira_lifecycle(&a)?["pending"]["suggestedAction"] == "pause" {
                    return Err(conflict(
                        "JIRA_LIFECYCLE_PAUSE_PENDING",
                        "Resolve the Jira lifecycle notice before linking another issue",
                    ));
                }
                if self
                    .get(
                        "SELECT 1 FROM jira_task_projects WHERE jira_task_id=? AND project_id=?",
                        &[a.clone(), task["projectId"].clone()],
                    )?
                    .is_null()
                {
                    return Err(conflict(
                        "JIRA_PROJECT_LINK_REQUIRED",
                        "Link the issue project to Jira before linking the issue",
                    ));
                }
                let existing = self.get(
                    "SELECT jira_task_id FROM jira_task_links WHERE task_id=?",
                    &[task["id"].clone()],
                )?;
                if existing["jira_task_id"] == a {
                    return Err(conflict(
                        "JIRA_LINK_EXISTS",
                        "This Jira link already exists",
                    ));
                }
                if !existing.is_null() {
                    return Err(conflict(
                        "JIRA_LINK_CONFLICT",
                        "This Panel issue is already linked to another Jira issue",
                    ));
                }
            }
            let timestamp = now();
            self.transaction(||{
                if method=="addJiraTaskLink"{self.run("INSERT INTO jira_task_links(jira_task_id,task_id,created_at) VALUES(?,?,?)",&[a.clone(),task["id"].clone(),timestamp.clone()])?;}
                else if self.run("DELETE FROM jira_task_links WHERE jira_task_id=? AND task_id=?",&[a.clone(),task["id"].clone()])?!=1{return Err(ApiError::new(404,"JIRA_LINK_NOT_FOUND","This Jira link does not exist"));}
                let relation=json!({"type":"jira","identifier":task["identifier"],"externalKey":task["externalKey"],"title":task["title"]});
                self.record_activity(&jira["id"],&actor,&[json!({"field":"jiraIssue","before":if method=="addJiraTaskLink"{Value::Null}else{relation.clone()},"after":if method=="addJiraTaskLink"{relation}else{Value::Null}})],&timestamp)?;
                self.touch_task(&jira,&expected,Some(&Value::Null),Some(&Value::Null),&timestamp,None)?;self.archive_completed_jira_threads(&timestamp,&a,false)
            })?;
            self.jira_context(&a)
        })())
    }
}
