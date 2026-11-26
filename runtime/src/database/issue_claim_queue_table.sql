
  CREATE TABLE issue_claim_queue (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    thread_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual', 'resume', 'jira', 'scan')),
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'running', 'retry_wait', 'blocked', 'failed', 'completed', 'canceled'
    )),
    resume_requested INTEGER NOT NULL DEFAULT 0 CHECK (resume_requested IN (0, 1)),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
