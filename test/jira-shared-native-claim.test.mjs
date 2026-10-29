import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PanelDatabase } from "../server/database.mjs";
import { ClaimQueueService } from "../server/claim-queue.mjs";

const actor = { type: "user", id: "fixture", name: "Fixture", avatarUrl: null };

test("explicit cross-Jira execution reuses native context serially and keeps task states independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-jira-native-"));
  const db = new PanelDatabase(path.join(root, "panel.sqlite"));
  const queue = new ClaimQueueService({ database: db, aiChat: {},
    managePanelSkillPath: path.join(root, "skills/manage-panel/SKILL.md"),
    prepareExecution: async task => ({ task, workspacePath: root }),
  });
  try {
    db.createProject({ id: "repo", name: "Fixture repository", workspacePath: root });
    const at = new Date().toISOString();
    db.syncJiraTasks([1, 2].map(id => ({ id: `jira-${id}`, identifier: `JIRA:TEST:${id}`,
      title: `Requirement ${id}`, description: "", status: "in_progress", priority: "medium", labels: [],
      sortOrder: id, creator: actor, assignee: actor, dueDate: null, externalOrigin: "fixture",
      externalId: String(id), externalKey: `TEST-${id}`, externalUrl: `https://fixture.invalid/${id}`,
      externalStatus: "In Progress", createdAt: at, updatedAt: at,
    })), { originId: "fixture", projectName: "Jira", syncedAt: at });
    db.createAiChatThread({ id: "planning", title: "Shared planning", purpose: "formal",
      origin: { projectId: "repo", projectName: "Fixture repository", workspacePath: root },
      codexThreadId: "planning", model: "fixture", reasoningEffort: "medium", sandbox: "workspace-write" });
    const tasks = [1, 2].map(id => {
      const task = db.createTask({ projectId: "repo", title: `Ticket ${id}`, description: "", status: "todo",
        priority: "none", labels: [], actor, assignee: actor, threadId: null,
        startDate: null, dueDate: null, recurrence: null });
      const jiraId = `jira-${id}`;
      db.setJiraProjects(jiraId, db.getTask(jiraId).version, ["repo"], actor);
      db.addJiraTaskLink(jiraId, db.getTask(jiraId).version, task.id, actor);
      db.beginJiraPlanning(jiraId, db.getTask(jiraId).version, "planning");
      db.database.prepare("UPDATE jira_plans SET publication = 1, status = 'published' WHERE jira_task_id = ?").run(jiraId);
      db.database.prepare("INSERT INTO jira_plan_items (jira_task_id, publication, item_key, project_id, task_id, title, description, priority, labels, blocked_by, created_at) VALUES (?, 1, 'ticket', 'repo', ?, 'Ticket', '', 'none', '[]', '[]', ?)").run(jiraId, task.id, at);
      return task;
    });
    assert.deepEqual(db.jiraExecutionPeers(tasks[0].id).map(task => task.id), [tasks[0].id]);
    db.enableSharedJiraExecution("jira-1", db.getTask("jira-1").version, "planning");
    assert.equal(db.getTask(tasks[0].id).status, "todo");
    assert.equal(db.getTask(tasks[1].id).threadBinding, null);
    queue.enqueue(tasks[0].id);
    const first = await queue.reserveNextNativeClaim();
    const binding = { threadId: "shared-execution", codexProjectId: "repo", codexProjectKind: "local",
      codexHostId: "local", workspacePath: root };
    const development = { type: "worktree", path: root, branch: "shay-TEST-1" };
    queue.bindNativeClaim(first.reservationId, tasks[0].id, binding, development);
    await assert.rejects(() => queue.prepareManualExecution(tasks[1].id), { code: "CLAIM_THREAD_BUSY" });
    assert.equal(db.getTask(tasks[1].id).status, "todo");
    db.moveTask(tasks[0].id, db.getTask(tasks[0].id).version, "in_review", undefined, undefined, undefined, actor);
    await queue.runOnce();
    const manual = await queue.prepareManualExecution(tasks[1].id, true);
    assert.deepEqual(manual.threadBinding, binding);
    assert.deepEqual(manual.developmentContext, development);
    assert.equal(manual.useWorktree, false);
    assert.equal(manual.autoSubmit, false);
    queue.enqueue(tasks[1].id);
    const second = await queue.reserveNextNativeClaim();
    assert.deepEqual(second.threadBinding, binding);
    assert.deepEqual(second.developmentContext, development);
    assert.equal(second.useWorktree, false);
    assert.match(second.instruction, /同仓库共享执行组/);
    queue.bindNativeClaim(second.reservationId, tasks[1].id, binding);
    assert.equal(db.getTask(tasks[0].id).status, "in_review");
    assert.equal(db.getTask(tasks[1].id).status, "in_progress");
    assert.deepEqual(db.getTask(tasks[1].id).developmentContext, development);
  } finally {
    queue.close(); db.close(); await rm(root, { recursive: true, force: true });
  }
});
