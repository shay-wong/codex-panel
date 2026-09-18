import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPanelServer, resolveServerOptions } from "../server/app.mjs";
import { main } from "../cli/panelctl.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

async function localHarness(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "panel-session-merge-"));
  const root = await realpath(temporary);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(root, "SKILL.md"), "Test skill\n");
  const options = {
    dataDirectory: path.join(root, "data"),
    staticDirectory: workspace,
    skillPath: path.join(root, "SKILL.md"),
    nativeSkillPath: path.join(root, "SKILL.md"),
    codexExecutable: path.join(root, "unused-codex"),
    processEnv: { HOME: root, CODEX_HOME: path.join(root, "codex") },
    jiraFetch: async () => { throw new Error("Unexpected Jira request"); },
    remoteFetch: async () => { throw new Error("Unexpected cloud request"); },
  };
  const production = resolveServerOptions();
  const resolved = resolveServerOptions(options);
  for (const key of ["dataDirectory", "databasePath", "attachmentsDirectory", "cloudConfigPath", "jiraConfigPath", "clientStoragePath", "codexStatePath", "codexProcessesPath", "skillsDirectory", "staticDirectory", "skillPath", "nativeSkillPath"]) {
    assert.ok(resolved[key].startsWith(`${root}/`), key);
    assert.ok(!resolved[key].startsWith(`${production[key]}/`) && !production[key].startsWith(`${resolved[key]}/`) && resolved[key] !== production[key], key);
  }
  const app = createPanelServer(options);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { port } = await app.listen({ host: "127.0.0.1", port: 0 });
  return async (pathname, { json, ...init } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...init,
      headers: json === undefined ? init.headers : { "content-type": "application/json", ...init.headers },
      body: json === undefined ? init.body : JSON.stringify(json),
    });
    return { response, body: response.status === 204 ? null : await response.json() };
  };
}

for (const mode of ["local", "cloud"]) {
  test(`${mode}: external sessions preserve native bindings and body edits consume attachment fallback`, async (t) => {
    let request;
    if (mode === "local") request = await localHarness(t);
    else {
      const cloud = await createCloudWorkerHarness();
      t.after(() => cloud.dispose());
      request = (pathname, init) => cloud.request(pathname, { actorName: "Merge test", ...init });
    }
    const binding = { threadId: "native-thread", codexProjectId: "local", codexProjectKind: "local", codexHostId: "local", workspacePath: "/isolated/session-workspace" };
    const session = { platform: "pi", sessionId: "/session path/session.jsonl" };
    const created = await request("/api/tasks", { method: "POST", json: { title: "Session merge", threadBinding: binding, agentSession: session } });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    let task = created.body.task;
    assert.deepEqual(task.agentSession, session);
    assert.deepEqual(task.threadBinding, binding);
    assert.ok(task.conversationRefs.some((ref) => ref.agentSession?.sessionId === session.sessionId));
    const taskPath = `/api/tasks/${task.id}`;
    const replaced = { platform: "claude", sessionId: "claude-session" };
    const updated = await request(taskPath, { method: "PATCH", json: { version: task.version, agentSession: replaced } });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    task = updated.body.task;
    assert.deepEqual(task.agentSession, replaced);
    assert.deepEqual(task.threadBinding, binding);
    const bad = await request(taskPath, { method: "PATCH", json: { version: task.version, threadId: "wrong", agentSession: replaced } });
    assert.equal(bad.response.status, 400);
    const comment = await request(`${taskPath}/comments`, { method: "POST", json: { body: "External notes", agentSession: session } });
    assert.equal(comment.response.status, 201, JSON.stringify(comment.body));
    assert.deepEqual(comment.body.comment.agentSession, session);
    const upload = await request(`${taskPath}/attachments`, { method: "POST", headers: { "content-type": "text/plain", "x-panel-filename": "notes.txt", "x-panel-attachment-kind": "attachment" }, body: "Attachment notes" });
    assert.equal(upload.response.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.attachment.bodyFallback, true);
    const bodyEdit = await request(taskPath, { method: "PATCH", json: { version: task.version, description: "Edited", agentSession: null } });
    assert.equal(bodyEdit.response.status, 200, JSON.stringify(bodyEdit.body));
    assert.equal(bodyEdit.body.task.agentSession, null);
    assert.deepEqual(bodyEdit.body.task.threadBinding, binding);
    const attachments = await request(`${taskPath}/attachments`);
    assert.equal(attachments.body.attachments[0].bodyFallback, false);
    const reread = await request(taskPath);
    assert.ok(reread.body.task.conversationRefs.some((ref) => ref.source === "comment" && ref.agentSession?.sessionId === session.sessionId));
  });
}

test("CLI external attribution ignores the native environment and preserves the original Pi path", async () => {
  let payload;
  let errorText = "";
  const code = await main(["issue", "update", "LOCAL-1", "--if-version", "1", "--agent-platform", "pi", "--session-id", " /path with spaces/session.jsonl "], {
    env: { CODEX_THREAD_ID: "native-thread" },
    fetch: async (_url, init) => { payload = JSON.parse(init.body); return new Response(JSON.stringify({ task: payload })); },
    stdout: { write() {} }, stderr: { write(value) { errorText += value; } },
  });
  assert.equal(code, 0, errorText);
  assert.deepEqual(payload.agentSession, { platform: "pi", sessionId: " /path with spaces/session.jsonl " });
  assert.equal(payload.threadId, undefined);
});
