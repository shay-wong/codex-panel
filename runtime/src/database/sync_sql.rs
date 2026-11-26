// 远端同步沿用原有身份键和更新条件。
pub(super) const SYNC_JIRA_TASKS: &[&str] = &[
    r###"SELECT issue_key FROM projects WHERE id = ?"###,
    r###"
        INSERT INTO projects (id, name, issue_key, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      "###,
    r###"
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      "###,
    r###"
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      "###,
    r###"
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        "###,
    r###"
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          external_status, external_updated_at, external_synced_at, external_sync_error,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          ?, ?, ?, NULL,
          ?, 1, ?, ?
        )
      "###,
    r###"
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          external_status = ?, external_updated_at = ?, external_synced_at = ?, external_sync_error = NULL,
          archived_at = ?,
          version = version + 1, updated_at = ?
        WHERE id = ?
      "###,
    r###"
            UPDATE tasks
            SET external_synced_at = ?, external_sync_error = NULL
            WHERE id = ?
          "###,
    r###"
          SELECT id FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND archived_at IS NULL
            AND (? IS NULL OR external_origin = ?)
        "###,
    r###"
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        "###,
    r###"
        UPDATE tasks
        SET external_sync_error = ?
        WHERE id = ? AND external_source = 'jira' AND archived_at IS NULL
      "###,
    r###"UPDATE projects SET updated_at = ? WHERE id = ?"###,
];
pub(super) const SYNC_JIRA_DUPLICATE: &[&str] = &[
    r###"
        UPDATE jira_lifecycles
        SET is_duplicate = 0,
            duplicate_of_key = NULL,
            duplicate_task_id = NULL,
            pending_kind = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_kind END,
            pending_from_status = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_from_status END,
            pending_to_status = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_to_status END,
            pending_created_at = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_created_at END,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ?
      "###,
    r###"
        SELECT id
        FROM tasks
        WHERE external_source = 'jira'
          AND external_origin = ?
          AND external_key = ?
          AND external_sync_error IS NULL
        LIMIT 1
      "###,
    r###"
      INSERT INTO jira_lifecycles (
        jira_task_id, pending_kind, pending_from_status, pending_to_status,
        pending_created_at, paused_task_ids, reopened, is_duplicate,
        duplicate_of_key, duplicate_task_id, version, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, '[]', 0, 1, ?, ?, 1, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        pending_kind = excluded.pending_kind,
        pending_from_status = CASE WHEN excluded.pending_kind = 'duplicate' THEN NULL ELSE jira_lifecycles.pending_from_status END,
        pending_to_status = CASE WHEN excluded.pending_kind = 'duplicate' THEN NULL ELSE jira_lifecycles.pending_to_status END,
        pending_created_at = CASE WHEN excluded.pending_kind = 'duplicate' THEN excluded.pending_created_at ELSE jira_lifecycles.pending_created_at END,
        is_duplicate = 1,
        duplicate_of_key = excluded.duplicate_of_key,
        duplicate_task_id = excluded.duplicate_task_id,
        version = jira_lifecycles.version + 1,
        updated_at = excluded.updated_at
    "###,
];
pub(super) const JIRA_DUPLICATE_NEEDS_DECISION: &[&str] = &[r###"
      SELECT 1 FROM jira_task_links WHERE jira_task_id = ? LIMIT 1
    "###];
