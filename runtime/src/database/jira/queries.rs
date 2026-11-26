// 从既有数据库实现迁移的 SQL；保留条件、排序及连接语义。
pub const GET_JIRA_CONTEXT: &[&str] = &[
    r###"SELECT jira.*
          FROM jira_task_links
          JOIN tasks AS jira ON jira.id = jira_task_links.jira_task_id
          WHERE jira_task_links.task_id = ?"###,
    r###"SELECT jira.*
        FROM jira_task_projects
        JOIN tasks AS jira ON jira.id = jira_task_projects.jira_task_id
        WHERE jira_task_projects.project_id = ?
          AND jira.archived_at IS NULL
        ORDER BY jira.sort_order, jira.created_at, jira.id"###,
    r###"SELECT projects.*
      FROM jira_task_projects
      JOIN projects ON projects.id = jira_task_projects.project_id
      WHERE jira_task_projects.jira_task_id = ?
      ORDER BY projects.name, projects.id"###,
    r###"SELECT tasks.*
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id"###,
    r###"SELECT tasks.*
        FROM tasks
        JOIN jira_task_projects ON jira_task_projects.project_id = tasks.project_id
        LEFT JOIN jira_task_links ON jira_task_links.task_id = tasks.id
        WHERE jira_task_projects.jira_task_id = ?
          AND tasks.external_source IS NOT 'jira'
          AND tasks.archived_at IS NULL
          AND jira_task_links.task_id IS NULL
        ORDER BY tasks.project_id, tasks.status, tasks.sort_order, tasks.created_at, tasks.id"###,
];
pub const LIST_JIRA_PLANNING_THREADS: &[&str] = &[
    r###"SELECT threads.id, threads.title, threads.origin_project_id,
        jira.id AS jira_id, jira.identifier, jira.title AS jira_title, jira.external_key
      FROM jira_plans AS plans
      JOIN ai_chat_threads AS threads ON threads.id = plans.thread_id
      JOIN tasks AS jira ON jira.id = plans.jira_task_id
      WHERE threads.archived_at IS NULL AND threads.purpose = 'formal'
        AND threads.codex_thread_id = threads.id AND jira.archived_at IS NULL
      ORDER BY threads.updated_at DESC, threads.id, jira.id"###,
];
pub const SHARED_JIRA_PLANNING_INCOMPLETE: &[&str] = &[r###"WITH shared_jira(id) AS (
        SELECT shared.jira_task_id FROM jira_plan_threads AS own
        JOIN ai_chat_threads AS threads ON threads.id = own.thread_id AND threads.archived_at IS NULL
        JOIN jira_plan_threads AS shared ON shared.thread_id = own.thread_id AND shared.jira_task_id <> own.jira_task_id
        WHERE own.jira_task_id = ?
        UNION
        SELECT other_links.jira_task_id FROM jira_task_links AS own_links
        JOIN tasks AS own ON own.id = own_links.task_id
        JOIN tasks AS peer ON peer.thread_id = own.thread_id
          AND peer.thread_codex_host_id IS own.thread_codex_host_id
        JOIN jira_task_links AS other_links ON other_links.task_id = peer.id
        WHERE own_links.jira_task_id = ? AND other_links.jira_task_id <> own_links.jira_task_id
          AND peer.archived_at IS NULL AND peer.status <> 'canceled'
      )
      SELECT 1 FROM shared_jira JOIN tasks AS jira ON jira.id = shared_jira.id
      WHERE (
        jira.status <> 'done'
        OR NOT EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        OR EXISTS (
          SELECT 1 FROM jira_task_links AS links JOIN tasks AS issue ON issue.id = links.task_id
          WHERE links.jira_task_id = jira.id AND (issue.status <> 'done' OR issue.archived_at IS NOT NULL)
        )
      ) LIMIT 1"###];
pub const GET_JIRA_CONVERSATION_ARCHIVE: &[&str] = &[
    r###"SELECT
        COUNT(*) AS linked_issue_count,
        COALESCE(SUM(CASE WHEN issues.archived_at IS NOT NULL OR issues.status != 'done' THEN 1 ELSE 0 END), 0)
          AS blocked_issue_count
      FROM jira_task_links AS links
      JOIN tasks AS issues ON issues.id = links.task_id
      WHERE links.jira_task_id = ?"###,
    r###"WITH related_threads(id) AS (
        SELECT thread_id FROM jira_plan_threads WHERE jira_task_id = ?
        UNION
        SELECT items.thread_id
        FROM jira_simple_start_operations AS operations
        JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
        WHERE operations.jira_task_id = ?
        UNION
        SELECT queue.thread_id
        FROM jira_task_links AS links
        JOIN issue_claim_queue AS queue ON queue.task_id = links.task_id
        WHERE links.jira_task_id = ? AND queue.thread_id IS NOT NULL
        UNION
        SELECT attempts.thread_id
        FROM jira_task_links AS links
        JOIN issue_claim_attempts AS attempts ON attempts.task_id = links.task_id
        WHERE links.jira_task_id = ?
        UNION
        SELECT thread_id FROM jira_rework_items WHERE jira_task_id = ?
      )
      SELECT
        COUNT(*) AS related_thread_count,
        COALESCE(SUM(CASE WHEN threads.archived_at IS NULL THEN 1 ELSE 0 END), 0)
          AS unarchived_thread_count
      FROM related_threads
      JOIN ai_chat_threads AS threads ON threads.id = related_threads.id"###,
];
pub const GET_JIRA_PLAN: &[&str] = &[r###"SELECT * FROM jira_plans WHERE jira_task_id = ?"###];
pub const LIST_JIRA_PLAN_ITEMS: &[&str] = &[r###"SELECT *
      FROM jira_plan_items
      WHERE jira_task_id = ? AND publication = ?
      ORDER BY rowid"###];
pub const JIRA_PLAN_SOURCE_SNAPSHOT: &[&str] = &[r###"SELECT project_id
      FROM jira_task_projects
      WHERE jira_task_id = ?
      ORDER BY project_id"###];
pub const ASSERT_ISSUE_EXECUTION_ALLOWED: &[&str] =
    &[r###"SELECT jira_task_id FROM jira_task_links WHERE task_id = ?"###];
pub const ASSERT_JIRA_MUTATION_UNLOCKED: &[&str] = &[
    r###"SELECT 1 FROM jira_task_links WHERE jira_task_id = ? AND task_id = ?"###,
    r###"SELECT 1 FROM jira_task_links WHERE jira_task_id = ? AND task_id = ?"###,
];
pub const JIRA_PAUSE_TARGETS: &[&str] = &[r###"SELECT tasks.id, tasks.status, tasks.version
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status IN ('todo', 'in_progress')
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id"###];
pub const SYNC_JIRA_LIFECYCLE: &[&str] = &[
    r###"SELECT 1
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status NOT IN ('done', 'canceled')
      LIMIT 1"###,
    r###"UPDATE jira_lifecycles
          SET pending_kind = NULL,
              pending_from_status = NULL,
              pending_to_status = NULL,
              pending_created_at = NULL,
              paused_task_ids = ?,
              version = version + 1,
              updated_at = ?
          WHERE jira_task_id = ?"###,
];
pub const SET_JIRA_LIFECYCLE_PENDING: &[&str] = &[r###"INSERT INTO jira_lifecycles (
        jira_task_id, pending_kind, pending_from_status, pending_to_status,
        pending_created_at, paused_task_ids, reopened, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, 1, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        pending_kind = excluded.pending_kind,
        pending_from_status = excluded.pending_from_status,
        pending_to_status = excluded.pending_to_status,
        pending_created_at = excluded.pending_created_at,
        reopened = MAX(jira_lifecycles.reopened, excluded.reopened),
        version = jira_lifecycles.version + 1,
        updated_at = excluded.updated_at"###];
pub const RELEASE_JIRA_FRONTIER: &[&str] = &[
    r###"SELECT tasks.id, tasks.status
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status IN ('backlog', 'blocked')
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id"###,
    r###"SELECT 1
      FROM task_relations
      JOIN tasks AS prerequisite ON prerequisite.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
        AND prerequisite.status NOT IN ('done', 'canceled')
      LIMIT 1"###,
    r###"UPDATE tasks
      SET status = 'todo', version = version + 1, updated_at = ?
      WHERE id = ? AND status = ?"###,
];
pub const GET_JIRA_LIFECYCLE: &[&str] =
    &[r###"SELECT * FROM jira_lifecycles WHERE jira_task_id = ?"###];
pub const BEGIN_JIRA_PLANNING: &[&str] = &[
    r###"SELECT * FROM jira_plans WHERE jira_task_id = ?"###,
    r###"INSERT INTO jira_plans (
          jira_task_id, thread_id, status, spec, source_snapshot, prompted_at,
          publication, version, published_at, created_at, updated_at
        ) VALUES (?, ?, 'planning', '', ?, NULL, 0, 1, NULL, ?, ?)"###,
    r###"INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)"###,
    r###"UPDATE jira_plans
        SET shared_execution = CASE WHEN thread_id = ? THEN shared_execution ELSE 0 END,
            thread_id = ?, status = 'planning', source_snapshot = ?, prompted_at = NULL,
            version = version + 1, updated_at = ?
        WHERE jira_task_id = ?"###,
    r###"INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)"###,
];
pub const MARK_JIRA_PLAN_PROMPTED: &[&str] = &[r###"UPDATE jira_plans
      SET prompted_at = ?, version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND prompted_at IS NULL"###];
pub const SAVE_JIRA_PLAN_SPEC: &[&str] = &[
    r###"SELECT * FROM jira_plans WHERE jira_task_id = ?"###,
    r###"UPDATE jira_plans
      SET spec = ?, status = 'review', version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND version = ?"###,
];
pub const SAVE_TASK_PLAN_SPEC: &[&str] = &[
    r###"INSERT INTO task_plans (task_id, spec, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?
      WHERE ? = 1 OR EXISTS (SELECT 1 FROM task_plans WHERE task_id = ? AND version = ?)
      ON CONFLICT(task_id) DO UPDATE
      SET spec = excluded.spec, version = excluded.version, updated_at = excluded.updated_at
      WHERE task_plans.version = ?"###,
];
pub const RESOLVE_JIRA_LIFECYCLE: &[&str] = &[
    r###"SELECT task_id FROM jira_task_links WHERE jira_task_id = ?"###,
    r###"INSERT OR IGNORE INTO jira_task_projects (jira_task_id, project_id, created_at)
          SELECT ?, project_id, ? FROM jira_task_projects WHERE jira_task_id = ?"###,
    r###"UPDATE jira_task_links SET jira_task_id = ? WHERE jira_task_id = ?"###,
    r###"UPDATE tasks SET version = version + 1, updated_at = ? WHERE id IN (?, ?)"###,
    r###"UPDATE tasks
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ?"###,
    r###"UPDATE jira_lifecycles
        SET pending_kind = NULL,
            pending_from_status = NULL,
            pending_to_status = NULL,
            pending_created_at = NULL,
            paused_task_ids = ?,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ? AND version = ?"###,
    r###"UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND archived_at IS NULL"###,
];
pub const BEGIN_JIRA_REWORK: &[&str] = &[
    r###"SELECT project_id
      FROM jira_task_projects
      WHERE jira_task_id = ?
      UNION
      SELECT tasks.project_id
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
      ORDER BY project_id"###,
    r###"INSERT OR IGNORE INTO jira_rework_items (
        jira_task_id, cycle, project_id, task_id, thread_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)"###,
    r###"SELECT project_id AS projectId, task_id AS taskId, thread_id AS threadId
        FROM jira_rework_items
        WHERE jira_task_id = ? AND cycle = ?
        ORDER BY project_id"###,
];
pub const COMPLETE_JIRA_REOPEN: &[&str] = &[r###"UPDATE jira_lifecycles
      SET pending_kind = NULL,
          pending_from_status = NULL,
          pending_to_status = NULL,
          pending_created_at = NULL,
          reopened = 0,
          version = version + 1,
          updated_at = ?
      WHERE jira_task_id = ? AND version = ? AND pending_kind = 'reopened'"###];
pub const COMPLETE_JIRA_REPLAN: &[&str] = &[
    r###"UPDATE jira_plans
        SET thread_id = ?, status = 'planning', source_snapshot = ?, prompted_at = ?, shared_execution = 0,
            version = version + 1, updated_at = ?
        WHERE jira_task_id = ? AND version = ?"###,
    r###"INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)"###,
    r###"UPDATE jira_lifecycles
        SET pending_kind = NULL,
            pending_from_status = NULL,
            pending_to_status = NULL,
            pending_created_at = NULL,
            reopened = 0,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ? AND version = ? AND pending_kind = 'reopened'"###,
];
pub const BEGIN_JIRA_PLAN_PUBLISH: &[&str] = &[
    r###"SELECT * FROM jira_plans WHERE jira_task_id = ?"###,
    r###"SELECT project_id FROM jira_task_projects WHERE jira_task_id = ?"###,
    r###"INSERT INTO jira_plan_items (
          jira_task_id, publication, item_key, project_id, task_id,
          title, description, priority, labels, blocked_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"###,
    r###"UPDATE jira_plans
        SET status = 'publishing', publication = ?, version = version + 1, updated_at = ?
        WHERE jira_task_id = ? AND version = ?"###,
];
pub const REPLACE_JIRA_PLAN_BLOCKS: &[&str] = &[
    r###"SELECT source_task_id, target_task_id, created_relation
      FROM jira_plan_edges
      WHERE jira_task_id = ? AND publication = ?"###,
    r###"DELETE FROM task_relations
      WHERE relation_type = 'blocks' AND source_task_id = ? AND target_task_id = ?"###,
    r###"INSERT OR IGNORE INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('blocks', ?, ?, ?)"###,
    r###"INSERT INTO jira_plan_edges (
        jira_task_id, publication, source_task_id, target_task_id, created_relation
      ) VALUES (?, ?, ?, ?, ?)"###,
];
pub const FINISH_JIRA_PLAN_PUBLISH: &[&str] = &[r###"UPDATE jira_plans
      SET status = 'published', published_at = ?, version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND publication = ? AND status = 'publishing'"###];
pub const BEGIN_JIRA_SIMPLE_START: &[&str] = &[
    r###"INSERT INTO jira_simple_start_operations (
          id, jira_task_id, status, transitioned_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'creating', NULL, NULL, ?, ?)"###,
    r###"INSERT INTO jira_simple_start_items (
          operation_id, project_id, task_id, thread_id, created_at, updated_at, scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?)"###,
];
pub const GET_JIRA_SIMPLE_START_OPERATION: &[&str] = &[r###"SELECT
        operations.*,
        COUNT(items.project_id) AS project_count,
        SUM(CASE WHEN tasks.id IS NOT NULL THEN 1 ELSE 0 END) AS ready_count
      FROM jira_simple_start_operations AS operations
      LEFT JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
      LEFT JOIN tasks ON tasks.id = items.task_id
      WHERE operations.jira_task_id = ?
      GROUP BY operations.id"###];
pub const LIST_JIRA_SIMPLE_START_ITEMS: &[&str] = &[
    r###"SELECT items.project_id, items.task_id, items.thread_id, items.scope
      FROM jira_simple_start_operations AS operations
      JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
      WHERE operations.jira_task_id = ?
      ORDER BY items.project_id"###,
];
pub const MARK_JIRA_SIMPLE_START_TRANSITIONED: &[&str] =
    &[r###"UPDATE jira_simple_start_operations
      SET transitioned_at = COALESCE(transitioned_at, ?), updated_at = ?
      WHERE id = ? AND status = 'creating'"###];
pub const COMPLETE_JIRA_SIMPLE_START: &[&str] = &[
    r###"SELECT id FROM jira_simple_start_operations WHERE id = ? AND status = 'creating'"###,
    r###"SELECT 1
      FROM jira_simple_start_items AS items
      LEFT JOIN tasks ON tasks.id = items.task_id
      LEFT JOIN issue_claim_queue AS claims ON claims.task_id = items.task_id
      WHERE items.operation_id = ?
        AND (
          tasks.id IS NULL
          OR claims.task_id IS NULL
          OR claims.state NOT IN ('queued', 'running', 'retry_wait', 'completed')
        )
      LIMIT 1"###,
    r###"UPDATE jira_simple_start_operations
      SET status = 'complete', completed_at = ?, updated_at = ?
      WHERE id = ?"###,
];
