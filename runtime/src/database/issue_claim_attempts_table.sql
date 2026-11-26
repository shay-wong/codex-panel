
  CREATE TABLE issue_claim_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
      'running', 'completed', 'failed', 'interrupted', 'blocked'
    )),
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
