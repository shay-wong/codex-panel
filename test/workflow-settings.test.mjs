import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPanelServer } from "../server/app.mjs";
import { ClaimQueueService } from "../server/claim-queue.mjs";
import { PanelDatabase } from "../server/database.mjs";
import { main as panelctl } from "../cli/panelctl.mjs";
import { continueTaskConversation } from "../scripts/codex-injector-runtime.mjs";

test("global workflow settings drive default, custom and unavailable-Skill actions", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-workflow-")));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const options = {
    dataDirectory: path.join(directory, "data"),
    codexExecutable: path.join(directory, "unused-codex"),
    codexStatePath: path.join(directory, "state.json"),
    codexProcessesPath: path.join(directory, "processes.json"),
    skillsDirectory: path.join(directory, "skills"),
    skillPath: path.join(directory, "skills/manage-panel/SKILL.md"),
    nativeSkillPath: path.join(directory, "skills/manage-panel/SKILL.md"),
    processEnv: {},
  };
  const app = createPanelServer(options);
  let queue;
  try {
    for (const key of ["dataDirectory", "databasePath", "cloudConfigPath", "jiraConfigPath", "clientStoragePath", "codexStatePath", "codexProcessesPath", "skillsDirectory", "nativeSkillPath"]) {
      assert.ok(app.options[key].startsWith(directory + path.sep), key);
    }
    const address = await app.listen({ port: 0 });
    app.claimQueue.close();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (route, body, status = 200) => {
      const response = await fetch(baseUrl + route, {
        method: body === undefined ? "GET" : "PUT",
        headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    const defaults = { planning: [], execution: [], review: [], handoff: [] };
    assert.deepEqual((await request("/api/local/workflow-settings")).settings, defaults);
    assert.equal((await request("/api/local/workflow?stage=handoff")).mode, "default");
    app.database.createProject({ id: "demo", name: "Demo", workspacePath: workspace });
    const actor = { type: "user", id: "demo", name: "Demo", avatarUrl: null };
    const stamp = new Date().toISOString();
    app.database.syncJiraTasks([{
      id: "jira-demo", identifier: "JIRA:DEMO:1", title: "Plan feature", description: "Demo requirement",
      status: "todo", priority: "medium", labels: [], sortOrder: 1000, creator: actor, assignee: actor,
      dueDate: null, externalOrigin: "demo", externalId: "1", externalKey: "DEMO-1",
      externalUrl: "https://jira.invalid/browse/DEMO-1", externalStatus: "todo", createdAt: stamp, updatedAt: stamp,
    }], { originId: "demo", projectName: "Jira", syncedAt: stamp });
    const planning = async () => {
      const task = app.database.getTask("jira-demo");
      const response = await fetch(baseUrl + "/api/tasks/jira-demo/jira-planning", {
        method: "POST", headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        body: JSON.stringify({ version: task.version }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    app.aiChat.getCatalog = async () => { throw new Error("Default workflow must not need a Skill catalog"); };
    assert.equal((await planning()).collaborationMode, "plan");
    const makeTask = (title) => app.database.createTask({
      projectId: "demo", title, description: "", status: "todo", priority: "none", labels: [],
      actor, assignee: actor, threadId: null, workflowId: null, developmentContext: null,
      startDate: null, dueDate: null, recurrence: null,
    });
    queue = new ClaimQueueService({ database: app.database, aiChat: app.aiChat,
      managePanelSkillPath: options.skillPath, prepareExecution: async () => ({ workspacePath: workspace }) });
    queue.enqueue(makeTask("Default execution").id);
    const defaultClaim = await queue.reserveNextNativeClaim();
    assert.deepEqual(defaultClaim.skillReferences.map((skill) => skill.name), ["manage-panel"]);
    assert.match(defaultClaim.instruction, /codex review --uncommitted/);
    const custom = { planning: ["my:clarify", "my:spec"], execution: ["my:implement"], review: ["my:review"], handoff: ["my:handoff"] };
    app.aiChat.getCatalog = async () => ({ skills: Object.values(custom).flat().map((id) => ({ id, label: id, path: path.join(directory, id, "SKILL.md") })) });
    await request("/api/local/workflow-settings", custom);
    const planned = await planning();
    assert.equal(planned.collaborationMode, "default");
    assert.deepEqual(planned.skills.map((skill) => skill.id), custom.planning);
    assert.match(planned.composerText, /my:clarify → my:spec/);
    queue.enqueue(makeTask("Custom execution").id);
    const customClaim = await queue.reserveNextNativeClaim();
    assert.deepEqual(customClaim.skillReferences.map((skill) => skill.name), ["manage-panel", "my:implement", "my:review"]);
    assert.doesNotMatch(customClaim.instruction, /codex review --uncommitted/);
    let output = "";
    assert.equal(await panelctl(["workflow", "get", "handoff", "--project", "demo", "--json"], {
      env: { CODEX_PANEL_COMPANION_URL: baseUrl }, cwd: workspace,
      stdout: { write: (chunk) => { output += chunk; } }, stderr: { write: (chunk) => assert.fail(chunk) },
    }), 0);
    assert.equal(JSON.parse(output).skills[0].id, "my:handoff");
    app.aiChat.getCatalog = async () => ({ skills: [] });
    assert.equal((await planning()).collaborationMode, "plan");
    assert.match((await planning()).composerText, /本次使用默认流程/);
    await request("/api/local/workflow-settings", { ...defaults, planning: ["/tmp/not-an-id"] }, 400);
    const persisted = new PanelDatabase(app.options.databasePath);
    assert.deepEqual(persisted.getWorkflowSettings(), custom);
    persisted.close();
    // The remote handoff uses the same ordered Skills and records the returned summary.
    const handoffTask = makeTask("Handoff target");
    const handoffSkills = ["my:outline", "my:handoff"];
    app.database.saveWorkflowSettings({ ...custom, handoff: handoffSkills });
    app.aiChat.getCatalog = async () => ({
      models: [{ slug: "gpt-test", defaultReasoningEffort: "high", supportedReasoningEfforts: ["high"] }],
      skills: handoffSkills.map((id) => ({ id, label: id, path: path.join(directory, id, "SKILL.md") })),
    });
    app.aiChat.resolveContext = async () => ({
      project: app.database.getProject("demo"), issue: handoffTask, workspacePath: workspace, addDirectories: [],
      codexProjectId: "demo", codexProjectKind: "remote", codexHostId: "fake-host",
    });
    let notify;
    let remoteInput;
    app.aiChat.remoteAppServerFactory = () => ({
      subscribe(callback) { notify = callback; return () => {}; },
      async startThread() { return { thread: { id: "remote-thread" } }; },
      async startTurn(params) { remoteInput = params.input; return { turn: { id: "remote-turn" } }; },
      async close() {},
    });
    const remoteThread = await app.aiChat.createThread({ projectId: "demo", issueId: handoffTask.id, codexProjectKind: "remote" });
    const run = await app.aiChat.startTurn(remoteThread.id, { message: "/handoff" });
    assert.deepEqual(remoteInput.filter((item) => item.type === "skill").map((item) => item.name), handoffSkills);
    assert.match(remoteInput.filter((item) => item.type === "text").map((item) => item.text).join(""), /Create a durable handoff/);
    notify({ method: "item/completed", params: { threadId: "remote-thread", turnId: "remote-turn", item: { type: "agentMessage", id: "summary", text: "Confirmed handoff" } } });
    notify({ method: "turn/completed", params: { threadId: "remote-thread", turn: { id: "remote-turn", status: "completed" } } });
    await app.aiChat.waitForRun(run.id);
    assert.equal(app.aiChat.getRun(run.id).status, "completed");
    assert.match(app.database.listComments(handoffTask.id)[0].body, /Confirmed handoff/);
    const calls = [];
    await continueTaskConversation({ threadId: "same-thread", targetRoot: workspace, instruction: "Execute", skills: [], collaborationMode: "default" }, async (method, params) => {
      calls.push({ method, params });
      return method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "same-thread", cwd: workspace, turns: [] }, model: "gpt-test", reasoningEffort: "high" };
    });
    assert.deepEqual(calls.at(-1).params.collaborationMode, { mode: "default", settings: { model: "gpt-test", reasoning_effort: "high", developer_instructions: null } });
  } finally {
    queue?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
