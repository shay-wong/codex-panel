import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPanelServer } from '../server/index.mjs';
import { PanelDatabase } from '../server/database.mjs';
import { ClaimQueueService } from '../server/claim-queue.mjs';
import { main as panelctl } from '../cli/panelctl.mjs';
import { createCloudWorkerHarness } from './helpers/cloud-worker-harness.mjs';

async function exerciseRelations(request) {
  for (const id of ['backend', 'admin']) {
    const result = await request('/api/projects', { method: 'POST', json: { id, name: id } });
    assert.equal(result.response.status, 201);
  }
  const create = async (projectId, title) => (await request('/api/tasks', {
    method: 'POST', json: { projectId, title, status: 'backlog' },
  })).body.task;
  const backend = await create('backend', 'Backend contract');
  const admin = await create('admin', 'Admin integration');
  const sameRepo = await create('admin', 'Admin prerequisite');
  const get = async id => (await request(`/api/tasks/${id}`)).body.task;
  const relation = async (method, task, type, peer) => request(`/api/tasks/${task.id}/relations/${type}/${peer.id}`, {
    method, json: { version: (await get(task.id)).version },
  });
  for (const type of ['parent', 'related']) {
    const rejected = await relation('POST', admin, type, backend);
    assert.equal(rejected.body.error.code, 'CROSS_PROJECT_RELATION');
  }
  const added = await relation('POST', admin, 'blocked_by', backend);
  assert.equal(added.response.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.task.relations.blockedBy[0].projectId, 'backend');
  assert.equal((await get(backend.id)).relations.blocks[0].id, admin.id);
  assert.equal((await relation('DELETE', backend, 'blocks', admin)).response.status, 200);
  assert.deepEqual((await get(admin.id)).relations.blockedBy, []);
  assert.equal((await relation('POST', backend, 'blocks', admin)).response.status, 200);
  assert.equal((await relation('POST', admin, 'blocked_by', sameRepo)).response.status, 200);
  assert.equal((await get(admin.id)).relations.blockedBy.length, 2);
  await relation('DELETE', admin, 'blocked_by', sameRepo);
  return { backend, admin };
}

test('local API migrates old relation restriction and enforces cross-repository execution dependency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-cross-blocking-'));
  const data = path.join(root, 'data'); await mkdir(data);
  const filename = path.join(data, 'panel.sqlite');
  const old = new PanelDatabase(filename);
  old.database.exec(`DROP TRIGGER task_relations_require_same_project;
    CREATE TRIGGER task_relations_require_same_project BEFORE INSERT ON task_relations BEGIN
      SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION') WHERE
        (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) !=
        (SELECT project_id FROM tasks WHERE id = NEW.target_task_id);
    END;`);
  old.close();
  const app = createPanelServer({ dataDirectory: data, codexExecutable: path.join(root, 'missing-codex'),
    codexStatePath: path.join(root, 'state.json'), codexProcessesPath: path.join(root, 'processes.json'),
    skillsDirectory: path.join(root, 'skills'), processEnv: { PATH: path.dirname(process.execPath) } });
  try {
    const address = await app.listen({ port: 0 });
    const request = async (route, { json, ...options } = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        ...options, headers: { 'content-type': 'application/json', 'x-panel-client': 'panelctl' },
        body: json ? JSON.stringify(json) : undefined,
      });
      return { response, body: await response.json() };
    };
    const { backend, admin } = await exerciseRelations(request);
    for (const action of ['remove', 'add']) {
      let output = '', error = '';
      const exitCode = await panelctl(['issue', 'relation', action, admin.identifier, '--type', 'blocked_by', '--issue', backend.identifier, '--thread-id', 'fixture-blocking'], {
        cwd: root, env: { CODEX_PANEL_URL: `http://127.0.0.1:${address.port}` },
        stdout: { write: value => { output += value; } }, stderr: { write: value => { error += value; } },
      });
      assert.equal(exitCode, 0, error);
      assert.equal(JSON.parse(output).task.relations.blockedBy.length, action === 'add' ? 1 : 0);
    }
    const workspace = path.join(root, 'workspace'); await mkdir(workspace);
    app.database.database.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(workspace, 'admin');
    app.database.database.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(admin.id);
    const queue = new ClaimQueueService({ database: app.database, aiChat: {}, prepareExecution: async task => ({ task, workspacePath: workspace }) });
    await assert.rejects(queue.prepareManualExecution(admin.id), { code: 'CLAIM_DEPENDENCY_PENDING' });
    app.database.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(backend.id);
    const prepared = await queue.prepareManualExecution(admin.id);
    assert.ok(prepared);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('cloud local emulator supports the same cross-project blocking relation API', async () => {
  const cloud = await createCloudWorkerHarness();
  try {
    await exerciseRelations((route, options = {}) => cloud.request(route, { ...options, actorName: 'Fixture' }));
  } finally { await cloud.dispose(); }
});
