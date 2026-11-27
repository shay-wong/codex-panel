-- 从既有数据库迁移保留原始 SQLite 约束和索引。
CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '["缺陷","特性","for-claude","hold","no-auto-claim","改进","phase-1","phase-2","phase-3","phase-4","phase-5","phase-6"]',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        external_status TEXT,
        external_updated_at TEXT,
        external_synced_at TEXT,
        external_sync_error TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
        body_fallback INTEGER NOT NULL DEFAULT 1 CHECK (body_fallback IN (0, 1)),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS comment_attachment_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      );

      CREATE TABLE IF NOT EXISTS project_readmes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_readme_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
      );

      CREATE TABLE IF NOT EXISTS jira_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        attempted_at TEXT,
        succeeded_at TEXT,
        issue_count INTEGER NOT NULL DEFAULT 0,
        unknown_issue_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS jira_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auto_complete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_complete_enabled IN (0, 1)),
        auto_archive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_archive_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        purpose TEXT NOT NULL DEFAULT 'temporary' CHECK (purpose IN ('temporary', 'formal')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_codex_project_id TEXT,
        origin_codex_project_kind TEXT,
        origin_codex_host_id TEXT,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_project_parallelism INTEGER NOT NULL DEFAULT 3
          CHECK (default_project_parallelism BETWEEN 1 AND 8),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_automation_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        enabled_by_user INTEGER NOT NULL DEFAULT 0 CHECK (enabled_by_user IN (0, 1)),
        paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
        interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (interval_minutes IN (5, 10, 15, 30, 60)),
        model TEXT NOT NULL DEFAULT 'gpt-5.5',
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        parallelism_override INTEGER CHECK (parallelism_override BETWEEN 1 AND 8),
        next_scan_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );


  CREATE TABLE IF NOT EXISTS issue_claim_queue (
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


      CREATE INDEX IF NOT EXISTS issue_claim_queue_dispatch
        ON issue_claim_queue(state, available_at, enqueued_at);


  CREATE TABLE IF NOT EXISTS issue_claim_attempts (
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


      CREATE INDEX IF NOT EXISTS issue_claim_attempts_task_started
        ON issue_claim_attempts(task_id, started_at, id);
