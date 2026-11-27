use super::*;

pub(super) fn labels() -> Value {
    json!([
        "缺陷",
        "特性",
        "for-claude",
        "hold",
        "no-auto-claim",
        "改进",
        "phase-1",
        "phase-2",
        "phase-3",
        "phase-4",
        "phase-5",
        "phase-6"
    ])
}
pub(super) fn issue_key(project: &Value, unavailable: &HashSet<String>) -> String {
    let valid = regex::Regex::new(r"^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$").unwrap();
    let old = text(&project["first_identifier"]);
    let prefix = old
        .rsplit_once('-')
        .filter(|(_, n)| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        .map(|(p, _)| p.to_uppercase());
    let clean = |value: &Value| {
        text(value)
            .to_uppercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
    };
    let base = if let Some(p) = prefix.filter(|p| p.len() <= 32 && valid.is_match(p)) {
        p
    } else {
        let mut key = clean(&project["id"]);
        key.truncate(32);
        if key.is_empty() {
            key = "TASK".into();
        }
        if key.len() <= 5 {
            key
        } else {
            let name = clean(&project["name"]);
            if name.is_empty() {
                key.chars().take(3).collect()
            } else {
                name.chars().take(3).collect()
            }
        }
    };
    if !unavailable.contains(&base) {
        return base;
    }
    for n in 2.. {
        let suffix = n.to_string();
        let candidate = format!(
            "{}{}",
            base.chars().take(32 - suffix.len()).collect::<String>(),
            suffix
        );
        if !unavailable.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

impl Database {
    fn columns(&self, table: &str) -> Result<HashSet<String>, ApiError> {
        Ok(self
            .all(&format!("PRAGMA table_info({table})"), &[])?
            .iter()
            .map(|r| text(&r["name"]).to_owned())
            .collect())
    }
    fn add_column(&self, table: &str, name: &str, definition: &str) -> Result<bool, ApiError> {
        if self.columns(table)?.contains(name) {
            return Ok(false);
        }
        self.batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {name} {definition}"
        ))?;
        Ok(true)
    }
    fn table_sql(&self, name: &str) -> Result<String, ApiError> {
        Ok(text(
            &self.get(
                "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
                &[json!(name)],
            )?["sql"],
        )
        .to_owned())
    }
    fn foreign_keys_off<T>(
        &self,
        operation: impl FnOnce() -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        // 表重建需要暂时关闭外键检查，结束后必须恢复并核对已迁移数据。
        self.batch("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE")?;
        let result = operation();
        match result {
            Ok(value) => {
                if let Err(error) = self.batch("COMMIT") {
                    let _ = self.batch("ROLLBACK; PRAGMA foreign_keys=ON");
                    return Err(error);
                }
                self.batch("PRAGMA foreign_keys=ON")?;
                let violation = self.get("PRAGMA foreign_key_check", &[])?;
                if !violation.is_null() {
                    return Err(ApiError::new(
                        500,
                        "DATABASE_MIGRATION_FAILED",
                        format!("Foreign key violation in {}", text(&violation["table"])),
                    ));
                }
                Ok(value)
            }
            Err(error) => {
                let _ = self.batch("ROLLBACK; PRAGMA foreign_keys=ON");
                Err(error)
            }
        }
    }
    pub(super) fn migrate(&self) -> Result<(), ApiError> {
        self.batch(include_str!("base.sql"))?;
        self.add_column("projects", "workspace_path", "TEXT")?;
        self.add_column("projects", "issue_key", "TEXT")?;
        let mut unavailable: HashSet<String> = self
            .all(
                "SELECT issue_key FROM projects WHERE issue_key IS NOT NULL",
                &[],
            )?
            .iter()
            .map(|r| text(&r["issue_key"]).to_owned())
            .collect();
        for project in self.all("SELECT projects.id,projects.name,(SELECT tasks.identifier FROM tasks WHERE tasks.project_id=projects.id ORDER BY tasks.created_at,tasks.id LIMIT 1) AS first_identifier FROM projects WHERE projects.issue_key IS NULL ORDER BY projects.created_at,projects.id",&[])? {
            let key=issue_key(&project,&unavailable);self.run("UPDATE projects SET issue_key=? WHERE id=? AND issue_key IS NULL",&[json!(key),project["id"].clone()])?;unavailable.insert(key);
        }
        self.batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS projects_issue_key_unique ON projects(issue_key)",
        )?;
        if self.add_column(
            "project_summaries",
            "failure_count",
            "INTEGER NOT NULL DEFAULT 0 CHECK (failure_count>=0)",
        )? {
            self.batch("UPDATE project_summaries SET failure_count=1 WHERE error IS NOT NULL")?;
        }
        self.add_column(
            "project_automation_policies",
            "parallelism_override",
            "INTEGER CHECK (parallelism_override BETWEEN 1 AND 8)",
        )?;
        self.add_column("ai_chat_threads", "archived_at", "TEXT")?;
        self.add_column(
            "ai_chat_threads",
            "purpose",
            "TEXT NOT NULL DEFAULT 'temporary' CHECK (purpose IN ('temporary','formal'))",
        )?;
        for column in [
            "origin_codex_project_id",
            "origin_codex_project_kind",
            "origin_codex_host_id",
        ] {
            self.add_column("ai_chat_threads", column, "TEXT")?;
        }
        let legacy =
            regex::Regex::new(r"(?i)REFERENCES\s+ai_chat_threads|thread_id\s+TEXT\s+UNIQUE")
                .unwrap();
        if legacy.is_match(&self.table_sql("issue_claim_queue")?) {
            self.transaction(||{self.batch("ALTER TABLE issue_claim_queue RENAME TO issue_claim_queue_legacy")?;self.batch(include_str!("issue_claim_queue_table.sql"))?;self.batch("INSERT INTO issue_claim_queue SELECT * FROM issue_claim_queue_legacy; DROP TABLE issue_claim_queue_legacy; CREATE INDEX issue_claim_queue_dispatch ON issue_claim_queue(state,available_at,enqueued_at)")})?;
        }
        if self
            .table_sql("issue_claim_attempts")?
            .to_lowercase()
            .contains("references ai_chat_threads")
        {
            self.transaction(||{self.batch("ALTER TABLE issue_claim_attempts RENAME TO issue_claim_attempts_legacy")?;self.batch(include_str!("issue_claim_attempts_table.sql"))?;self.batch("INSERT INTO issue_claim_attempts SELECT * FROM issue_claim_attempts_legacy; DROP TABLE issue_claim_attempts_legacy; CREATE INDEX issue_claim_attempts_task_started ON issue_claim_attempts(task_id,started_at,id)")})?;
        }
        self.add_column(
            "jira_settings",
            "auto_archive_enabled",
            "INTEGER NOT NULL DEFAULT 0 CHECK (auto_archive_enabled IN (0,1))",
        )?;
        let start_columns = self.all("PRAGMA table_info(jira_simple_start_items)", &[])?;
        if start_columns
            .iter()
            .any(|r| r["name"] == "thread_id" && r["notnull"] == 1)
        {
            self.transaction(||{self.batch("ALTER TABLE jira_simple_start_items RENAME TO jira_simple_start_items_legacy")?;self.batch(include_str!("jira_simple_start_items_table.sql"))?;self.batch("INSERT INTO jira_simple_start_items (operation_id,project_id,task_id,thread_id,created_at,updated_at) SELECT operation_id,project_id,task_id,thread_id,created_at,updated_at FROM jira_simple_start_items_legacy; DROP TABLE jira_simple_start_items_legacy")})?;
        }
        if !start_columns.is_empty() {
            self.add_column("jira_simple_start_items", "scope", "TEXT")?;
        }
        let old_columns = self.columns("tasks")?;
        if old_columns.contains("workflow_id") {
            self.batch("ALTER TABLE tasks DROP COLUMN workflow_id")?;
        }
        self.batch("DROP TABLE IF EXISTS workflow_workspaces; DROP TRIGGER IF EXISTS tasks_todo_execution_target_insert; DROP TRIGGER IF EXISTS tasks_todo_execution_target_update")?;
        for column in [
            "thread_id",
            "thread_codex_project_id",
            "thread_codex_project_kind",
            "thread_codex_host_id",
            "thread_workspace_path",
            "git_branch",
            "worktree_path",
            "worktree_branch",
            "due_date",
            "start_date",
            "recurrence_unit",
        ] {
            self.add_column("tasks", column, "TEXT")?;
        }
        self.add_column("tasks", "recurrence_interval", "INTEGER")?;
        if old_columns.contains("linked_thread_id") {
            self.batch("UPDATE tasks SET thread_id=COALESCE(thread_id,linked_thread_id); ALTER TABLE tasks DROP COLUMN linked_thread_id")?;
        }
        let task_sql = self.table_sql("tasks")?;
        if ["'in_review'", "'blocked'", "'canceled'"]
            .iter()
            .any(|s| !task_sql.contains(s))
        {
            self.foreign_keys_off(|| self.batch(include_str!("status-migration.sql")))?;
        }
        for column in [
            "agent_session",
            "creator_avatar_url",
            "external_source",
            "external_id",
            "external_origin",
            "external_key",
            "external_url",
            "external_status",
            "external_synced_at",
            "external_sync_error",
        ] {
            self.add_column("tasks", column, "TEXT")?;
        }
        for (column, definition) in [
            ("creator_type", "TEXT NOT NULL DEFAULT 'user'"),
            ("creator_id", "TEXT NOT NULL DEFAULT 'local-user'"),
            ("creator_name", "TEXT NOT NULL DEFAULT '本地用户'"),
        ] {
            self.add_column("tasks", column, definition)?;
        }
        if self.add_column("tasks", "external_updated_at", "TEXT")? {
            self.batch(
                "UPDATE tasks SET external_updated_at=updated_at WHERE external_source='jira'",
            )?;
        }
        self.batch("DROP INDEX IF EXISTS tasks_external_source_id; CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id ON tasks(external_source,external_origin,external_id) WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL; UPDATE tasks SET creator_type='agent',creator_id='codex-agent',creator_name='Codex Agent' WHERE thread_id IS NOT NULL AND version=1 AND creator_id='local-user'")?;
        self.transaction(|| {
            for (column, definition, source) in [
                (
                    "assignee_type",
                    "TEXT CHECK (assignee_type IN ('user','agent'))",
                    "creator_type",
                ),
                ("assignee_id", "TEXT", "creator_id"),
                ("assignee_name", "TEXT", "creator_name"),
                ("assignee_avatar_url", "TEXT", "creator_avatar_url"),
            ] {
                if self.add_column("tasks", column, definition)? {
                    self.batch(&format!("UPDATE tasks SET {column}={source}"))?;
                }
            }
            Ok(())
        })?;
        if self.add_column(
            "projects",
            "labels",
            &format!("TEXT NOT NULL DEFAULT '{}'", labels()),
        )? {
            self.transaction(|| {
                for project in self.all("SELECT id FROM projects", &[])? {
                    let mut values = array(&labels());
                    for task in self.all(
                        "SELECT labels FROM tasks WHERE project_id=? ORDER BY created_at,id",
                        &[project["id"].clone()],
                    )? {
                        for label in array(&parse_json(&task["labels"])?) {
                            if !values.contains(&label) {
                                values.push(label);
                            }
                        }
                    }
                    self.run(
                        "UPDATE projects SET labels=? WHERE id=?",
                        &[
                            json!(Value::Array(values).to_string()),
                            project["id"].clone(),
                        ],
                    )?;
                }
                Ok(())
            })?;
        }
        self.batch("CREATE INDEX IF NOT EXISTS tasks_project_status_sort ON tasks(project_id,archived_at,status,sort_order,created_at)")?;
        self.batch(include_str!("jira.sql"))?;
        for table in ["jira_plans", "jira_plan_threads"] {
            let sql = self.table_sql(table)?;
            let pattern =
                regex::Regex::new(r"(?i)(thread_id\s+TEXT(?:\s+NOT NULL)?)\s+UNIQUE").unwrap();
            if pattern.is_match(&sql) {
                self.foreign_keys_off(||{let replacement=format!("{table}_shared_migration");let create=regex::Regex::new(&format!(r#"(?i)CREATE TABLE(?: IF NOT EXISTS)? "?{table}"?"#)).unwrap().replace(&sql,format!("CREATE TABLE {replacement}"));self.batch(&pattern.replace_all(&create,"$1"))?;self.batch(&format!("INSERT INTO {replacement} SELECT * FROM {table}; DROP TABLE {table}; ALTER TABLE {replacement} RENAME TO {table}"))})?;
            }
        }
        self.add_column(
            "jira_plans",
            "shared_execution",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.batch(include_str!("triggers.sql"))?;
        self.add_column(
            "task_relations",
            "origin",
            "TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','mention'))",
        )?;
        for column in [
            "agent_session",
            "thread_id",
            "thread_codex_project_id",
            "thread_codex_project_kind",
            "thread_codex_host_id",
            "thread_workspace_path",
            "author_avatar_url",
        ] {
            self.add_column("comments", column, "TEXT")?;
        }
        self.add_column("comments", "author_type", "TEXT NOT NULL DEFAULT 'user'")?;
        self.add_column("comments", "change_revision", "INTEGER NOT NULL DEFAULT 0")?;
        self.batch("UPDATE comments SET author_type='agent',author_id='codex-agent',author_name='Codex Agent' WHERE thread_id IS NOT NULL AND author_id='local'; UPDATE comments SET author_id='local-user' WHERE author_id='local'")?;
        if !self.table_sql("task_threads")?.is_empty() {
            self.batch("UPDATE tasks SET thread_id=COALESCE(thread_id,(SELECT task_threads.thread_id FROM task_threads LEFT JOIN comments ON comments.task_id=task_threads.task_id AND comments.thread_id=task_threads.thread_id WHERE task_threads.task_id=tasks.id GROUP BY task_threads.task_id,task_threads.thread_id,task_threads.created_at ORDER BY CASE WHEN COUNT(comments.thread_id)>0 THEN 1 ELSE 0 END,task_threads.created_at DESC,task_threads.thread_id DESC LIMIT 1)) WHERE thread_id IS NULL; DROP TABLE task_threads")?;
        }
        self.add_column(
            "attachments",
            "comment_id",
            "TEXT REFERENCES comments(id) ON DELETE CASCADE",
        )?;
        if self.add_column(
            "attachments",
            "kind",
            "TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('inline','attachment'))",
        )? {
            self.batch("UPDATE attachments SET kind='inline' WHERE content_type LIKE 'image/%' AND ((comment_id IS NULL AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id=attachments.task_id AND instr(tasks.description,'api/attachments/'||attachments.id||'/content')>0)) OR (comment_id IS NOT NULL AND EXISTS (SELECT 1 FROM comments WHERE comments.id=attachments.comment_id AND instr(comments.body,'api/attachments/'||attachments.id||'/content')>0)))")?;
        }
        self.add_column(
            "attachments",
            "body_fallback",
            "INTEGER NOT NULL DEFAULT 1 CHECK (body_fallback IN (0,1))",
        )?;
        self.add_column(
            "attachments",
            "change_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.batch("CREATE INDEX IF NOT EXISTS comments_task_change_revision ON comments(task_id,change_revision); CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id,created_at,id); CREATE INDEX IF NOT EXISTS attachments_task_change_revision ON attachments(task_id,change_revision) WHERE comment_id IS NULL; CREATE INDEX IF NOT EXISTS attachments_comment_change_revision ON attachments(comment_id,change_revision) WHERE comment_id IS NOT NULL; INSERT INTO comment_attachment_revision(id,value) VALUES(1,(SELECT COALESCE(MAX(change_revision),0) FROM (SELECT change_revision FROM comments UNION ALL SELECT change_revision FROM attachments))) ON CONFLICT(id) DO UPDATE SET value=MAX(value,excluded.value)")?;
        let timestamp = now();
        self.run("INSERT INTO projects(id,name,issue_key,workspace_path,next_task_number,created_at,updated_at) VALUES('local','全局','LOCAL',NULL,1,?,?) ON CONFLICT(id) DO NOTHING",&[timestamp.clone(),timestamp.clone()])?;
        self.run("UPDATE projects SET name='全局',workspace_path=NULL,updated_at=? WHERE id='local' AND (name!='全局' OR workspace_path IS NOT NULL)",&[timestamp])?;
        Ok(())
    }
}
