use super::*;
impl Database {
    pub(super) fn next_revision(&self) -> Result<Value, ApiError> {
        Ok(self.get(
            "UPDATE comment_attachment_revision SET value=value+1 WHERE id=1 RETURNING value",
            &[],
        )?["value"]
            .clone())
    }
    pub(super) fn consume_attachment_fallback(
        &self,
        task: &Value,
        comment: &Value,
    ) -> Result<(), ApiError> {
        for row in self.all(
            "SELECT id FROM attachments WHERE task_id=? AND comment_id IS ? AND body_fallback=1",
            &[task.clone(), comment.clone()],
        )? {
            self.run(
                "UPDATE attachments SET body_fallback=0,change_revision=? WHERE id=?",
                &[self.next_revision()?, row["id"].clone()],
            )?;
        }
        Ok(())
    }
    pub(super) fn get_comment(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get("SELECT * FROM comments WHERE id=?", &[id.clone()])?;
        self.comment_with_attachments(&row)
    }
    fn comment_with_attachments(&self, row: &Value) -> Result<Value, ApiError> {
        let mut out = rows::comment(row, true)?;
        if !out.is_null() {
            out["attachments"] = self.comment_attachments(&row["id"], &Value::Null)?;
        }
        Ok(out)
    }
    fn require_comment(&self, id: &Value) -> Result<Value, ApiError> {
        let row = self.get_comment(id)?;
        if row.is_null() {
            Err(missing("Comment", id))
        } else {
            Ok(row)
        }
    }
    fn comment_attachments(&self, id: &Value, after: &Value) -> Result<Value, ApiError> {
        let mut sql = "SELECT * FROM attachments WHERE comment_id=?".to_owned();
        let mut values = vec![id.clone()];
        if truth(after) {
            sql.push_str(" AND change_revision>? ORDER BY change_revision");
            values.push(after["revision"].clone());
        } else {
            sql.push_str(" ORDER BY created_at,id");
        }
        Ok(Value::Array(
            self.all(&sql, &values)?
                .iter()
                .map(|r| rows::attachment(r, true))
                .collect(),
        ))
    }
    pub(super) fn call_comments(
        &self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, ApiError>> {
        if ![
            "listTaskActivities",
            "listComments",
            "listCommentsAfter",
            "createComment",
            "getComment",
            "updateComment",
            "deleteComment",
            "listAttachments",
            "createAttachment",
            "listCommentAttachments",
            "createCommentAttachment",
            "getAttachment",
            "deleteAttachment",
        ]
        .contains(&method)
        {
            return None;
        }
        Some((|| {
            let a = arg(args, 0);
            let b = arg(args, 1);
            match method {
                "listTaskActivities" => {
                    let task = self.require_task(&a)?;
                    Ok(Value::Array(self.all("SELECT * FROM task_activities WHERE task_id=? ORDER BY created_at,id",&[task["id"].clone()])?.iter().map(|r|{let mut out=fields(r,"id task_id actor_type actor_id actor_name actor_avatar_url created_at");out["changes"]=parse_json(&r["changes"])?;Ok(out)}).collect::<Result<_,ApiError>>()?))
                }
                "listComments" | "listCommentsAfter" => {
                    let task = self.require_task(&a)?;
                    let (sql, values) = if method == "listComments" {
                        (
                            "SELECT * FROM comments WHERE task_id=? ORDER BY created_at,id",
                            vec![task["id"].clone()],
                        )
                    } else {
                        ("SELECT * FROM comments WHERE task_id=? AND change_revision>? ORDER BY change_revision",vec![task["id"].clone(),b["revision"].clone()])
                    };
                    Ok(Value::Array(
                        self.all(sql, &values)?
                            .iter()
                            .map(|r| self.comment_with_attachments(r))
                            .collect::<Result<_, _>>()?,
                    ))
                }
                "getComment" => self.get_comment(&a),
                "createComment" => {
                    let comment = id();
                    let t = now();
                    self.transaction(||{let task=self.require_task(&a)?;let mut values=vec![comment.clone(),task["id"].clone(),b["body"].clone()];values.extend(rows::stored_binding(&Value::Null,b.get("threadBinding"),b.get("threadId")).unwrap_or(vec![Value::Null;5]));values.extend([b["actor"]["type"].clone(),b["actor"]["id"].clone(),b["actor"]["name"].clone(),b["actor"]["avatarUrl"].clone(),t.clone(),t.clone(),self.next_revision()?,json_text(&b["agentSession"])]);self.run("INSERT INTO comments(id,task_id,body,thread_id,thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path,author_type,author_id,author_name,author_avatar_url,version,created_at,updated_at,change_revision,agent_session) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)",&values)?;Ok(())})?;
                    self.get_comment(&comment)
                }
                "updateComment" => {
                    self.transaction(|| {
                        let current = self.require_comment(&a)?;
                        version(&current, &b, "Comment")?;
                        let mut columns = vec!["body=?".to_owned()];
                        let mut values = vec![arg(args, 2)];
                        append_binding(
                            &mut columns,
                            &mut values,
                            &Value::Null,
                            optional(args, 4),
                            optional(args, 3),
                            optional(args, 5),
                        );
                        columns.extend([
                            "version=version+1".into(),
                            "updated_at=?".into(),
                            "change_revision=?".into(),
                        ]);
                        values.extend([now(), self.next_revision()?, a.clone(), b.clone()]);
                        if self.run(
                            &format!(
                                "UPDATE comments SET {} WHERE id=? AND version=?",
                                columns.join(",")
                            ),
                            &values,
                        )? != 1
                        {
                            let r = self.require_comment(&a)?;
                            version(&r, &b, "Comment")?;
                        }
                        self.consume_attachment_fallback(&current["taskId"], &current["id"])?;
                        Ok(())
                    })?;
                    self.get_comment(&a)
                }
                "deleteComment" => {
                    let current = self.require_comment(&a)?;
                    version(&current, &b, "Comment")?;
                    if self.run(
                        "DELETE FROM comments WHERE id=? AND version=?",
                        &[a.clone(), b.clone()],
                    )? != 1
                    {
                        version(&self.require_comment(&a)?, &b, "Comment")?;
                    }
                    Ok(current)
                }
                "listAttachments" => {
                    let task = self.require_task(&a)?;
                    let mut sql =
                        "SELECT * FROM attachments WHERE task_id=? AND comment_id IS NULL"
                            .to_owned();
                    let mut values = vec![task["id"].clone()];
                    if truth(&b) {
                        sql.push_str(" AND change_revision>? ORDER BY change_revision");
                        values.push(b["revision"].clone());
                    } else {
                        sql.push_str(" ORDER BY created_at,id");
                    }
                    Ok(Value::Array(
                        self.all(&sql, &values)?
                            .iter()
                            .map(|r| rows::attachment(r, true))
                            .collect(),
                    ))
                }
                "listCommentAttachments" => {
                    self.require_comment(&a)?;
                    self.comment_attachments(&a, &b)
                }
                "createAttachment" | "createCommentAttachment" => {
                    self.transaction(||{let (task,comment)=if method=="createAttachment"{(self.require_task(&a)?["id"].clone(),Value::Null)}else{let c=self.require_comment(&a)?;(c["taskId"].clone(),c["id"].clone())};self.run("INSERT INTO attachments(id,task_id,comment_id,kind,filename,content_type,size,created_at,change_revision) VALUES(?,?,?,?,?,?,?,?,?)",&[b["id"].clone(),task,comment,b["kind"].clone(),b["filename"].clone(),b["contentType"].clone(),b["size"].clone(),now(),self.next_revision()?])?;Ok(())})?;
                    Ok(rows::attachment(
                        &self.get("SELECT * FROM attachments WHERE id=?", &[b["id"].clone()])?,
                        true,
                    ))
                }
                "getAttachment" => Ok(rows::attachment(
                    &self.get("SELECT * FROM attachments WHERE id=?", &[a])?,
                    true,
                )),
                "deleteAttachment" => {
                    let attachment = rows::attachment(
                        &self.get("SELECT * FROM attachments WHERE id=?", &[a.clone()])?,
                        true,
                    );
                    if attachment.is_null() {
                        return Err(missing("Attachment", &a));
                    }
                    self.run("DELETE FROM attachments WHERE id=?", &[a])?;
                    Ok(attachment)
                }
                _ => unreachable!(),
            }
        })())
    }
}
pub(super) fn append_binding(
    columns: &mut Vec<String>,
    values: &mut Vec<Value>,
    current: &Value,
    binding: Option<&Value>,
    thread: Option<&Value>,
    session: Option<&Value>,
) {
    if let Some(stored) = rows::stored_binding(current, binding, thread) {
        for column in [
            "thread_id",
            "thread_codex_project_id",
            "thread_codex_project_kind",
            "thread_codex_host_id",
            "thread_workspace_path",
        ] {
            columns.push(format!("{column}=?"));
        }
        values.extend(stored);
    }
    if let Some(session) = session {
        columns.push("agent_session=?".into());
        values.push(json_text(session));
    }
}
