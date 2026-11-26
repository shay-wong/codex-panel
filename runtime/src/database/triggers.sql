-- 从既有数据库迁移保留原始 SQLite 约束和索引。
INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
      SELECT jira_task_id, thread_id, created_at
      FROM jira_plans
      WHERE thread_id IS NOT NULL;

      UPDATE ai_chat_threads SET purpose = 'formal'
      WHERE purpose = 'temporary'
        AND id IN (SELECT thread_id FROM jira_plan_threads);

      -- 旧数据库的触发器限制所有关系，重建后才允许跨仓库阻塞。
      DROP TRIGGER IF EXISTS task_relations_require_same_project;
      CREATE TRIGGER task_relations_require_same_project
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION')
        WHERE EXISTS (
          SELECT 1
          FROM tasks AS source
          JOIN tasks AS target ON target.id = NEW.target_task_id
          WHERE source.id = NEW.source_task_id
            AND source.project_id != target.project_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS task_relations_prevent_parent_cycle
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'RELATION_CYCLE')
        WHERE EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT source_task_id
            FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = NEW.source_task_id
            UNION
            SELECT task_relations.source_task_id
            FROM task_relations
            JOIN ancestors ON task_relations.target_task_id = ancestors.id
            WHERE task_relations.relation_type = 'parent'
          )
          SELECT 1 FROM ancestors WHERE id = NEW.target_task_id
        );
      END;
