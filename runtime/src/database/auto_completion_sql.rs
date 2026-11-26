// 完成队列保留远端版本约束和本地终态判断。
pub(super) const QUEUE_ELIGIBLE_JIRA_AUTO_COMPLETION: &[&str] = &[r###"
      SELECT jira.id
      FROM jira_task_links AS link
      JOIN tasks AS jira ON jira.id = link.jira_task_id
      WHERE link.task_id = ?
      LIMIT 1
    "###];
pub(super) const RECONCILE_JIRA_AUTO_COMPLETION: &[&str] = &[r###"
      SELECT jira.id, jira.external_updated_at
      FROM tasks AS jira
      WHERE jira.id = ?
        AND jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
    "###];
pub(super) const QUEUE_ELIGIBLE_JIRA_AUTO_COMPLETIONS: &[&str] = &[r###"
      SELECT jira.id, jira.external_updated_at
      FROM tasks AS jira
      WHERE jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      ORDER BY jira.sort_order, jira.created_at, jira.id
    "###];
pub(super) const QUEUE_JIRA_AUTO_COMPLETION: &[&str] = &[r###"
      INSERT INTO jira_auto_completions (
        jira_task_id, state, expected_updated_at, attempt_count, available_at, updated_at
      ) VALUES (?, 'queued', ?, 0, ?, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        state = 'queued',
        expected_updated_at = excluded.expected_updated_at,
        remote_updated_at = NULL,
        remote_status = NULL,
        remote_task_status = NULL,
        attempt_count = 0,
        available_at = excluded.available_at,
        error_code = NULL,
        error_message = NULL,
        completed_at = NULL,
        updated_at = excluded.updated_at
      WHERE jira_auto_completions.state = 'dismissed'
    "###];
pub(super) const DISMISS_PENDING_JIRA_AUTO_COMPLETION: &[&str] = &[r###"
      UPDATE jira_auto_completions
      SET state = 'dismissed', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE jira_task_id = ? AND state IN ('queued', 'retry_wait')
    "###];
pub(super) const QUEUE_JIRA_AUTO_COMPLETION_RETRY: &[&str] = &[
    r###"
      SELECT 1
      FROM jira_task_links
      WHERE jira_task_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = ?
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      LIMIT 1
    "###,
    r###"
      UPDATE jira_auto_completions
      SET state = 'queued',
          expected_updated_at = COALESCE(remote_updated_at, ?),
          attempt_count = 0,
          available_at = ?,
          error_code = NULL,
          error_message = NULL,
          completed_at = NULL,
          updated_at = ?
      WHERE jira_task_id = ?
    "###,
];
pub(super) const DISMISS_JIRA_AUTO_COMPLETION_CONFLICT: &[&str] = &[r###"
      UPDATE jira_auto_completions
      SET state = 'dismissed', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE jira_task_id = ?
    "###];
pub(super) const TAKE_NEXT_JIRA_AUTO_COMPLETION: &[&str] = &[
    r###"
      SELECT completion.jira_task_id
      FROM jira_auto_completions AS completion
      JOIN tasks AS jira ON jira.id = completion.jira_task_id
      WHERE completion.state IN ('queued', 'retry_wait')
        AND completion.available_at <= ?
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      ORDER BY completion.available_at, completion.updated_at, completion.jira_task_id
      LIMIT 1
    "###,
    r###"
      UPDATE jira_auto_completions
      SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
      WHERE jira_task_id = ? AND state IN ('queued', 'retry_wait')
    "###,
];
pub(super) const IS_JIRA_AUTO_COMPLETION_ELIGIBLE: &[&str] = &[r###"
      SELECT 1
      FROM tasks AS jira
      WHERE jira.id = ?
        AND jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
    "###];
pub(super) const FINISH_JIRA_AUTO_COMPLETION: &[&str] = &[
    r###"
        UPDATE tasks
        SET status = 'done', external_status = ?, external_updated_at = ?, external_synced_at = ?,
            external_sync_error = NULL, archived_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      "###,
    r###"
        UPDATE jira_auto_completions
        SET state = 'completed', remote_updated_at = ?, remote_status = ?, remote_task_status = 'done',
            error_code = NULL, error_message = NULL, completed_at = ?, updated_at = ?
        WHERE jira_task_id = ?
      "###,
];
pub(super) const FAIL_JIRA_AUTO_COMPLETION: &[&str] = &[r###"
      UPDATE jira_auto_completions
      SET state = ?, available_at = COALESCE(?, available_at), remote_updated_at = ?,
          remote_status = ?, remote_task_status = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE jira_task_id = ?
    "###];
pub(super) const RECOVER_JIRA_AUTO_COMPLETIONS: &[&str] = &[r###"
      UPDATE jira_auto_completions
      SET state = 'queued', available_at = ?, updated_at = ?
      WHERE state = 'running'
    "###];
