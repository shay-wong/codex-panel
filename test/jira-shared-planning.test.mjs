import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PanelDatabase } from '../server/database.mjs';
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

test('explicit shared planning keeps Jira plans separate and prevents premature shared archive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jira-shared-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const app = createPanelServer({ dataDirectory: path.join(root, 'data'), codexExecutable: path.join(root, 'fake-codex'), codexStatePath: path.join(root, 'state.json'), codexProcessesPath: path.join(root, 'processes.json'), skillsDirectory: path.join(root, 'skills'), processEnv: { PATH: path.dirname(process.execPath) } });
  try {
    seed(app.database, workspace);
    const address = await app.listen({ port: 0 });
    const post = async body => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/jira-2/jira-planning`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-client': 'panelctl' }, body: JSON.stringify({ version: app.database.getTask('jira-2').version, threadId: 'shared-plan', ...body }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post({})).body.error.code, 'JIRA_PLANNING_THREAD_CONFLICT');
    assert.equal((await post({ reuseThread: 'yes' })).status, 400);
    const joined = await post({ reuseThread: true });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.context.plan.threadId, 'shared-plan');
    assert.deepEqual(joined.body.context.sharedPlanningJira.map(jira => jira.id), ['jira-1', 'jira-2']);
    assert.match(joined.body.composerText, /jira-2/);
    assert.match(joined.body.composerText, /分别使用每个 Jira ID/);
    const db = app.database;
    db.saveJiraPlanSpec('jira-1', db.getJiraPlan('jira-1').version, 'Only part one');
    db.saveJiraPlanSpec('jira-2', db.getJiraPlan('jira-2').version, 'Only part two');
    assert.equal(db.getJiraPlan('jira-1').spec, 'Only part one');
    assert.equal(db.getJiraPlan('jira-2').spec, 'Only part two');
    for (const jiraId of ['jira-1', 'jira-2']) {
      const issue = db.createTask({ projectId: 'local', title: jiraId, description: '', status: 'done', priority: 'none', labels: [], actor, assignee: actor, threadId: null, startDate: null, dueDate: null, recurrence: null });
      db.database.prepare('INSERT INTO jira_task_links (jira_task_id, task_id, created_at) VALUES (?, ?, ?)').run(jiraId, issue.id, new Date().toISOString());
    }
    db.database.prepare("UPDATE tasks SET status = 'done' WHERE id = 'jira-1'").run();
    assert.equal(db.getJiraConversationArchive('jira-1').reason, 'shared_planning_incomplete');
    assert.throws(() => db.archiveJiraConversations('jira-1', db.getTask('jira-1').version), { code: 'JIRA_CONVERSATION_ARCHIVE_UNAVAILABLE' });
    assert.equal(db.getAiChatThread('shared-plan').archivedAt, null);
    db.database.prepare("UPDATE tasks SET status = 'done' WHERE id = 'jira-2'").run();
    db.archiveJiraConversations('jira-1', db.getTask('jira-1').version);
    assert.ok(db.getAiChatThread('shared-plan').archivedAt);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy unique planning tables migrate without losing published children or foreign keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jira-shared-migration-'));
  const filename = path.join(root, 'panel.sqlite');
  let db = new PanelDatabase(filename);
  try {
    seed(db, root);
    db.database.exec("UPDATE jira_plans SET publication = 1, spec = 'preserved plan', status = 'published' WHERE jira_task_id = 'jira-1'");
    db.database.prepare(`INSERT INTO jira_plan_items (jira_task_id, publication, item_key, project_id, task_id, title, description, priority, labels, blocked_by, created_at) VALUES ('jira-1', 1, 'item', 'local', 'ticket-id', 'Published', '', 'none', '[]', '[]', ?)`).run(new Date().toISOString());
    db.database.prepare(`INSERT INTO jira_plan_edges (jira_task_id, publication, source_task_id, target_task_id, created_relation) VALUES ('jira-1', 1, 'source', 'target', 0)`).run();
    db.database.exec('PRAGMA foreign_keys = OFF; BEGIN');
    for (const name of ['jira_plans', 'jira_plan_threads']) {
      const sql = db.database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name).sql;
      db.database.exec(sql.replace(name, `${name}_legacy_fixture`).replace(/(thread_id\s+TEXT(?:\s+NOT NULL)?)/, '$1 UNIQUE'));
      db.database.exec(`INSERT INTO ${name}_legacy_fixture SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_legacy_fixture RENAME TO ${name};`);
    }
    db.database.exec('COMMIT; PRAGMA foreign_keys = ON');
    db.close(); db = null; db = new PanelDatabase(filename);
    assert.equal(db.getJiraPlan('jira-1').spec, 'preserved plan');
    assert.equal(db.database.prepare('SELECT count(*) AS n FROM jira_plan_items').get().n, 1);
    assert.equal(db.database.prepare('SELECT count(*) AS n FROM jira_plan_edges').get().n, 1);
    db.beginJiraPlanning('jira-2', db.getTask('jira-2').version, 'shared-plan');
    assert.equal(db.getJiraPlan('jira-2').threadId, 'shared-plan');
    assert.equal(db.database.prepare('SELECT count(*) AS n FROM jira_plan_threads').get().n, 2);
    assert.deepEqual(db.database.prepare('PRAGMA foreign_key_check').all(), []);
    db.close(); db = null; db = new PanelDatabase(filename);
    assert.equal(db.getJiraContext('jira-2').sharedPlanningJira.length, 2);
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
