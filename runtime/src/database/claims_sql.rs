// 保留原数据层查询的排序、状态及关联范围。
pub(super) const ENQUEUE_CLAIM: &[&str] = &[r###"
      INSERT INTO issue_claim_queue (
        task_id, project_id, thread_id, source, state, resume_requested, attempt_count,
        available_at, enqueued_at, started_at, finished_at, last_error, updated_at
      ) VALUES (?, ?, NULL, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_id = excluded.project_id,
        source = excluded.source,
        state = 'queued',
        resume_requested = 0,
        attempt_count = CASE
          WHEN issue_claim_queue.state IN ('failed', 'completed', 'canceled') THEN 0
          ELSE issue_claim_queue.attempt_count
        END,
        available_at = excluded.available_at,
        enqueued_at = excluded.enqueued_at,
        started_at = NULL,
        finished_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    "###];
pub(super) const ENQUEUE_AUTHORIZED_JIRA_CLAIMS: &[&str] = &[
    r###"
      SELECT DISTINCT links.jira_task_id
      FROM jira_task_links AS links
      JOIN tasks AS jira ON jira.id = links.jira_task_id
      JOIN tasks AS issue ON issue.id = links.task_id
      WHERE jira.status = 'in_progress' AND jira.archived_at IS NULL
    "###,
    r###"
      SELECT linked.task_id
      FROM jira_task_links AS linked
      JOIN tasks AS issues ON issues.id = linked.task_id
      JOIN tasks AS jira ON jira.id = linked.jira_task_id
      JOIN project_automation_policies AS policy ON policy.project_id = issues.project_id
      LEFT JOIN jira_lifecycles AS lifecycle ON lifecycle.jira_task_id = jira.id
      WHERE issues.archived_at IS NULL
        AND issues.status = 'todo'
        AND jira.status = 'in_progress'
        AND policy.enabled_by_user = 1
        AND lifecycle.pending_kind IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM issue_claim_queue AS queued
          WHERE queued.task_id = issues.id
            AND queued.state IN ('queued', 'running', 'retry_wait')
        )
      ORDER BY issues.project_id, issues.sort_order, issues.created_at, issues.id
    "###,
];
pub(super) const ENQUEUE_DUE_PROJECT_SCANS: &[&str] = &[
    r###"
      SELECT * FROM project_automation_policies
      WHERE enabled_by_user = 1
        AND paused = 0
        AND (next_scan_at IS NULL OR next_scan_at <= ?)
      ORDER BY COALESCE(next_scan_at, created_at), project_id
    "###,
    r###"
        SELECT tasks.id
        FROM tasks
        WHERE tasks.project_id = ?
          AND tasks.archived_at IS NULL
          AND tasks.status = 'todo'
          AND tasks.external_source IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM jira_task_links WHERE jira_task_links.task_id = tasks.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM issue_claim_queue AS queued
            WHERE queued.task_id = tasks.id
              AND queued.state IN ('queued', 'running', 'retry_wait')
          )
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      "###,
    r###"
        UPDATE project_automation_policies
        SET next_scan_at = ?, updated_at = ?
        WHERE project_id = ?
      "###,
];
pub(super) const RECONCILE_CLAIM_QUEUE: &[&str] = &[
    r###"
      UPDATE issue_claim_queue
      SET state = CASE WHEN tasks.status = 'in_progress' THEN 'running' ELSE 'completed' END,
          thread_id = tasks.thread_id, last_error = NULL, resume_requested = 0,
          finished_at = CASE WHEN tasks.status = 'in_progress' THEN NULL ELSE ? END,
          updated_at = ?
      FROM tasks
      WHERE tasks.id = issue_claim_queue.task_id
        AND issue_claim_queue.state IN ('blocked', 'retry_wait', 'queued', 'running')
        AND tasks.archived_at IS NULL
        AND tasks.status IN ('in_progress', 'in_review', 'done')
        AND tasks.thread_id IS NOT NULL
        AND tasks.thread_codex_project_id IS NOT NULL
        AND tasks.thread_codex_project_kind IS NOT NULL
        AND tasks.thread_codex_host_id IS NOT NULL
        AND tasks.thread_workspace_path IS NOT NULL
        AND (issue_claim_queue.state != 'running' OR issue_claim_queue.thread_id IS NULL)
      RETURNING task_id
    "###,
    r###"
      SELECT queue.task_id
      FROM issue_claim_queue AS queue
      JOIN tasks ON tasks.id = queue.task_id
      WHERE (
        queue.state IN ('queued', 'retry_wait')
        AND (tasks.archived_at IS NOT NULL OR tasks.status NOT IN ('todo', 'in_progress'))
      ) OR (
        queue.state = 'running'
        AND (
          tasks.archived_at IS NOT NULL
          OR (queue.thread_id IS NULL AND tasks.status != 'todo')
          OR (queue.thread_id IS NOT NULL AND tasks.status != 'in_progress')
        )
      )
    "###,
    r###"
      UPDATE issue_claim_attempts
      SET status = CASE
            WHEN tasks.status IN ('in_review', 'done') THEN 'completed'
            WHEN tasks.status = 'blocked' THEN 'blocked'
            ELSE 'interrupted'
          END,
          error = CASE
            WHEN tasks.status IN ('in_review', 'done', 'blocked') THEN error
            ELSE COALESCE(error, 'Issue execution was canceled')
          END,
          finished_at = COALESCE(issue_claim_attempts.finished_at, ?)
      FROM tasks
      JOIN issue_claim_queue AS queue ON queue.task_id = tasks.id
      WHERE issue_claim_attempts.task_id = tasks.id
        AND issue_claim_attempts.status = 'running'
        AND queue.state = 'running'
        AND (tasks.archived_at IS NOT NULL OR tasks.status != 'in_progress')
    "###,
    r###"
      UPDATE issue_claim_queue
      SET state = CASE
            WHEN tasks.status IN ('in_review', 'done') THEN 'completed'
            WHEN tasks.status = 'blocked' THEN 'blocked'
            ELSE 'canceled'
          END,
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?
      FROM tasks
      WHERE tasks.id = issue_claim_queue.task_id
        AND issue_claim_queue.state IN ('queued', 'retry_wait', 'running')
        AND (
          tasks.archived_at IS NOT NULL
          OR (
            issue_claim_queue.state IN ('queued', 'retry_wait')
            AND tasks.status NOT IN ('todo', 'in_progress')
          )
          OR (
            issue_claim_queue.state = 'running'
            AND issue_claim_queue.thread_id IS NULL
            AND tasks.status != 'todo'
          )
          OR (
            issue_claim_queue.state = 'running'
            AND issue_claim_queue.thread_id IS NOT NULL
            AND tasks.status != 'in_progress'
          )
        )
    "###,
];
pub(super) const EXECUTION_CONTEXT_PEERS: &[&str] = &[r###"
      SELECT id FROM tasks
      WHERE project_id = ? AND archived_at IS NULL AND status <> 'canceled'
        AND ((thread_id IS NOT NULL AND thread_id = ? AND thread_codex_host_id IS ?)
          OR (worktree_path IS NOT NULL AND worktree_path = ?))
    "###];
pub(super) const LIST_READY_CLAIMS: &[&str] = &[r###"
      SELECT queue.task_id
      FROM issue_claim_queue AS queue
      JOIN tasks ON tasks.id = queue.task_id
      LEFT JOIN project_automation_policies AS policy ON policy.project_id = queue.project_id
      WHERE queue.state IN ('queued', 'retry_wait')
        AND queue.available_at <= ?
        AND tasks.archived_at IS NULL
        AND tasks.status = 'todo'
        AND COALESCE(policy.paused, 0) = 0
      ORDER BY
        CASE queue.source
          WHEN 'manual' THEN 0 WHEN 'resume' THEN 1 WHEN 'jira' THEN 2 WHEN 'scan' THEN 2
          ELSE 3
        END,
        CASE tasks.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        tasks.sort_order,
        queue.enqueued_at,
        tasks.created_at,
        tasks.id
    "###];
pub(super) const BIND_NATIVE_CLAIM: &[&str] = &[
    r###"
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND status = 'in_progress' AND archived_at IS NULL AND id != ?
    "###,
    r###"
        UPDATE issue_claim_queue
        SET thread_id = ?,
            resume_requested = 0, started_at = ?, finished_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE task_id = ? AND state = 'running' AND (thread_id IS NULL OR thread_id = ?)
      "###,
    r###"
        UPDATE tasks
        SET status = 'in_progress', sort_order = ?,
            thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
            thread_codex_host_id = ?, thread_workspace_path = ?,
            git_branch = ?, worktree_path = ?, worktree_branch = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'todo' AND archived_at IS NULL
      "###,
    r###"
        INSERT INTO issue_claim_attempts (
          id, task_id, thread_id, run_id, status, error, started_at, finished_at
        ) VALUES (?, ?, ?, NULL, 'running', NULL, ?, NULL)
      "###,
    r###"
        UPDATE jira_simple_start_items SET thread_id = ?, updated_at = ? WHERE task_id = ?
      "###,
];
pub(super) const RECOVER_INTERRUPTED_CLAIMS: &[&str] = &[
    r###"
      SELECT queue.task_id,
             EXISTS (
               SELECT 1 FROM ai_chat_threads WHERE ai_chat_threads.id = queue.thread_id
             ) AS legacy_ai_chat
      FROM issue_claim_queue AS queue
      JOIN tasks ON tasks.id = queue.task_id
      WHERE queue.state = 'running'
        AND (
          tasks.thread_id IS NULL
          OR tasks.thread_codex_project_id IS NULL
          OR tasks.thread_codex_project_kind IS NULL
          OR tasks.thread_codex_host_id IS NULL
          OR tasks.thread_workspace_path IS NULL
        )
      ORDER BY started_at, task_id
    "###,
    r###"
      UPDATE issue_claim_attempts
      SET status = 'interrupted', error = COALESCE(error, 'Panel service restarted'),
          finished_at = COALESCE(finished_at, ?)
      WHERE status = 'running' AND task_id IN (%PLACEHOLDERS%)
    "###,
    r###"
        UPDATE issue_claim_queue
        SET state = 'queued', source = 'resume', available_at = ?,
            finished_at = NULL, last_error = 'Panel service restarted', updated_at = ?
        WHERE task_id IN (%PLACEHOLDERS%)
      "###,
    r###"
        UPDATE issue_claim_queue
        SET state = 'blocked', finished_at = ?,
            last_error = 'Panel service restarted', updated_at = ?
        WHERE task_id IN (%PLACEHOLDERS%)
      "###,
];
