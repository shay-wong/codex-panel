-- 从既有数据库迁移保留原始 SQLite 约束和索引。
CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';

      CREATE TABLE IF NOT EXISTS jira_task_projects (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS jira_task_links (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, task_id),
        CHECK (jira_task_id <> task_id)
      );

      CREATE INDEX IF NOT EXISTS jira_task_links_jira
        ON jira_task_links(jira_task_id, created_at);

      CREATE TABLE IF NOT EXISTS jira_lifecycles (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        pending_kind TEXT CHECK (pending_kind IN ('waiting', 'ended', 'reopened', 'duplicate')),
        pending_from_status TEXT,
        pending_to_status TEXT,
        pending_created_at TEXT,
        paused_task_ids TEXT NOT NULL DEFAULT '[]',
        reopened INTEGER NOT NULL DEFAULT 0 CHECK (reopened IN (0, 1)),
        is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0, 1)),
        duplicate_of_key TEXT,
        duplicate_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_auto_completions (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'running', 'retry_wait', 'conflict', 'failed', 'completed', 'dismissed'
        )),
        expected_updated_at TEXT,
        remote_updated_at TEXT,
        remote_status TEXT,
        remote_task_status TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jira_auto_completions_dispatch
        ON jira_auto_completions(state, available_at, updated_at);

      CREATE TABLE IF NOT EXISTS jira_rework_items (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, cycle, project_id)
      );

      CREATE TABLE IF NOT EXISTS jira_simple_start_operations (
        id TEXT PRIMARY KEY,
        jira_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('creating', 'complete')),
        transitioned_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );


  CREATE TABLE IF NOT EXISTS jira_simple_start_items (
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


      CREATE TABLE IF NOT EXISTS task_plans (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        spec TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_plans (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES ai_chat_threads(id) ON DELETE SET NULL,
        shared_execution INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('planning', 'review', 'publishing', 'published')),
        spec TEXT NOT NULL DEFAULT '',
        source_snapshot TEXT NOT NULL,
        prompted_at TEXT,
        publication INTEGER NOT NULL DEFAULT 0 CHECK (publication >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_plan_threads (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS jira_plan_items (
        jira_task_id TEXT NOT NULL REFERENCES jira_plans(jira_task_id) ON DELETE CASCADE,
        publication INTEGER NOT NULL CHECK (publication > 0),
        item_key TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        blocked_by TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, publication, item_key),
        UNIQUE (jira_task_id, publication, task_id)
      );

      CREATE INDEX IF NOT EXISTS jira_plan_items_task
        ON jira_plan_items(task_id);

      CREATE TABLE IF NOT EXISTS jira_plan_edges (
        jira_task_id TEXT NOT NULL REFERENCES jira_plans(jira_task_id) ON DELETE CASCADE,
        publication INTEGER NOT NULL CHECK (publication > 0),
        source_task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        created_relation INTEGER NOT NULL CHECK (created_relation IN (0, 1)),
        PRIMARY KEY (jira_task_id, publication, source_task_id, target_task_id),
        CHECK (source_task_id <> target_task_id)
      );
