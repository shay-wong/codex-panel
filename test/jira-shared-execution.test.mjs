import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPanelServer } from '../server/index.mjs';

const actor = { type: 'agent', id: 'test', name: 'Test', avatarUrl: null };
function seed(db, workspace) {
  const at = new Date().toISOString();
  const jiras = [1, 2].map(id => ({ id: `jira-${id}`, identifier: `JIRA:TEST:${id}`, title: `Part ${id}`, description: '', status: 'todo', priority: 'medium', labels: [], sortOrder: id,
    creator: actor, assignee: actor, dueDate: null, externalOrigin: 'test', externalId: String(id), externalKey: `TEST-${id}`, externalUrl: `https://fixture.invalid/${id}`, externalStatus: 'todo', createdAt: at, updatedAt: at }));
  db.syncJiraTasks(jiras, { originId: 'test', projectName: 'Jira', syncedAt: at });
  db.createAiChatThread({ id: 'shared-plan', title: 'Plan both parts', purpose: 'formal', origin: { projectId: 'local', projectName: 'Local', workspacePath: workspace }, codexThreadId: 'shared-plan', model: 'test', reasoningEffort: 'medium', sandbox: 'workspace-write' });
  db.beginJiraPlanning('jira-1', db.getTask('jira-1').version, 'shared-plan');
}

test('execution stays separate until explicitly enabled, preserves Jira ownership and publication boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jira-shared-execution-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const app = createPanelServer({ dataDirectory: path.join(root, 'data'), codexExecutable: path.join(root, 'fake-codex'), codexStatePath: path.join(root, 'state.json'), codexProcessesPath: path.join(root, 'processes.json'), skillsDirectory: path.join(root, 'skills'), processEnv: { PATH: path.dirname(process.execPath) } });
  try {
    const db = app.database;
    seed(db, workspace);
    db.beginJiraPlanning('jira-2', db.getTask('jira-2').version, 'shared-plan');
    const issues = ['jira-1', 'jira-2'].map(jiraId => {
      const issue = db.createTask({ projectId: 'local', title: jiraId, description: '', status: 'todo', priority: 'none', labels: [], actor, assignee: actor, threadId: null, startDate: null, dueDate: null, recurrence: null });
      db.database.prepare('INSERT INTO jira_task_links (jira_task_id, task_id, created_at) VALUES (?, ?, ?)').run(jiraId, issue.id, new Date().toISOString());
      db.database.prepare("UPDATE jira_plans SET publication = 1, status = 'published' WHERE jira_task_id = ?").run(jiraId);
      db.database.prepare("INSERT INTO jira_plan_items (jira_task_id, publication, item_key, project_id, task_id, title, description, priority, labels, blocked_by, created_at) VALUES (?, 1, 'one', 'local', ?, 'Part', '', 'none', '[]', '[]', ?)").run(jiraId, issue.id, new Date().toISOString());
      return issue;
    });
    assert.deepEqual(db.jiraExecutionPeers(issues[0].id).map(task => task.id), [issues[0].id]);
    assert.deepEqual(db.getJiraContext('jira-1').sharedExecutionJira, []);
    const address = await app.listen({ port: 0 });
    const post = async (body = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/jira-1/jira-shared-execution`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-client': 'panelctl' }, body: JSON.stringify({ version: db.getTask('jira-1').version, threadId: 'shared-plan', ...body }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post({ threadId: 'stale-plan' })).status, 409);
    const shared = await post();
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.context.sharedExecutionJira.map(jira => jira.id), ['jira-1', 'jira-2']);
    assert.deepEqual(db.jiraExecutionPeers(issues[0].id).map(task => task.id).sort(), issues.map(task => task.id).sort());
    const version = db.getJiraPlan('jira-1').version;
    assert.equal((await post()).status, 200);
    assert.equal(db.getJiraPlan('jira-1').version, version);
    assert.equal(db.getTask(issues[0].id).status, 'todo');
    assert.equal(db.getClaimQueueItem(issues[0].id), null);
    db.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(issues[0].id);
    assert.equal(db.getTask(issues[1].id).status, 'todo');
    assert.equal(db.getTask('jira-2').status, 'todo');
    // 旧发布项不会在另一 Jira 的新批次里作为可复用 owner。
    db.database.prepare("UPDATE jira_plans SET publication = 2 WHERE jira_task_id = 'jira-2'").run();
    assert.deepEqual(db.jiraExecutionPeers(issues[0].id).map(task => task.id), [issues[0].id]);
    db.database.prepare("UPDATE tasks SET worktree_path = ?, worktree_branch = 'panel/shared' WHERE id IN (?, ?)").run(path.join(root, 'shared-worktree'), issues[0].id, issues[1].id);
    assert.deepEqual(db.executionContextPeers(issues[0].id).map(task => task.id).sort(), issues.map(task => task.id).sort());
    db.createAiChatThread({ id: 'new-plan', title: 'New plan', purpose: 'formal', origin: { projectId: 'local', projectName: 'Local', workspacePath: workspace }, codexThreadId: 'new-plan', model: 'test', reasoningEffort: 'medium', sandbox: 'workspace-write' });
    db.beginJiraPlanning('jira-2', db.getTask('jira-2').version, 'new-plan');
    assert.deepEqual(db.getJiraContext('jira-2').sharedExecutionJira, []);
    assert.equal(db.executionContextPeers(issues[0].id).length, 2);
    // 即使原规划已归档，实际仍共用的执行会话也不能提前归档。
    db.createAiChatThread({ id: 'solo-plan', title: 'Solo plan', purpose: 'formal', origin: { projectId: 'local', projectName: 'Local', workspacePath: workspace }, codexThreadId: 'solo-plan', model: 'test', reasoningEffort: 'medium', sandbox: 'workspace-write' });
    db.beginJiraPlanning('jira-1', db.getTask('jira-1').version, 'solo-plan');
    db.database.prepare("UPDATE ai_chat_threads SET archived_at = ? WHERE id = 'shared-plan'").run(new Date().toISOString());
    db.database.prepare("UPDATE tasks SET thread_id = 'shared-execution' WHERE id IN (?, ?)").run(issues[0].id, issues[1].id);
    db.database.prepare("UPDATE tasks SET status = 'done' WHERE id = 'jira-1'").run();
    assert.equal(db.getJiraConversationArchive('jira-1').reason, 'shared_planning_incomplete');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
