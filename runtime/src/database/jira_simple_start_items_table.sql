
  CREATE TABLE jira_simple_start_items (
    operation_id TEXT NOT NULL REFERENCES jira_simple_start_operations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    scope TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operation_id, project_id),
    UNIQUE (operation_id, task_id),
    UNIQUE (operation_id, thread_id)
  );
