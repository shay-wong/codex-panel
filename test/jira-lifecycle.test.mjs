import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPanelServer } from "../server/index.mjs";

const ORIGIN = createHash("sha256").update("jira-lifecycle-test").digest("hex");
const ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

async function api(baseUrl, pathname, method = "GET", body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

test("Jira lifecycle authorizes, pauses, and resumes dependency-frontier issues", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-lifecycle-"));
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-test","display_name":"GPT Test","description":"","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"medium"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer = "";
  process.stdin.on("data", chunk => { buffer += chunk; let index;
    while ((index = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue; const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[]}]}}\\n');
    }
  });
}
`);
  await chmod(codexExecutable, 0o755);
  let jiraStatus = { name: "To Do", statusCategory: { key: "new" } };
  let duplicateOf = null;
  let canonicalAvailable = true;
  let onNativeInterrupt = null;
  let failingNativeThreadId = null;
  const interruptedNativeThreads = [];
  const jiraConfig = {
    version: 3,
    baseUrl: "https://jira.example.test",
    username: "shay",
    password: "token",
    originId: ORIGIN,
    accountId: "account-a",
    displayName: "Shay",
    projects: [],
  };
  const app = createPanelServer({
    dataDirectory: directory,
    codexExecutable,
    jiraConfigStore: {
      read: async () => jiraConfig,
      save: async (config) => config,
    },
    jiraFetch: async (url, init = {}) => {
      const parsed = new URL(url);
      const lifecycleIssue = () => ({
        id: "1",
        key: "LIFE-1",
        fields: {
          summary: "Lifecycle requirement",
          description: "Control execution from Jira",
          status: jiraStatus,
          assignee: { accountId: "account-a", displayName: "Shay" },
          reporter: { accountId: "account-a", displayName: "Shay" },
          labels: [],
          resolution: duplicateOf ? { name: "Duplicate" } : null,
          issuelinks: duplicateOf ? [{
            type: { outward: "duplicates", inward: "is duplicated by" },
            outwardIssue: { id: "2", key: duplicateOf },
          }] : [],
        },
      });
      if (parsed.pathname === "/rest/applinks/1.0/manifest") {
        return Response.json({ id: "jira-lifecycle-test" });
      }
      if (parsed.pathname === "/rest/api/2/myself") {
        return Response.json({ accountId: "account-a", displayName: "Shay" });
      }
      if (parsed.pathname === "/rest/api/2/search") {
        const issues = jiraStatus.statusCategory.key === "done" ? [] : [lifecycleIssue()];
        return Response.json({
          total: issues.length,
          issues,
        });
      }
      if (parsed.pathname === "/rest/api/2/issue/LIFE-1" && init.method !== "PUT") {
        return Response.json(lifecycleIssue());
      }
      if (parsed.pathname === "/rest/api/2/issue/LIFE-1/transitions") {
        if (init.method === "POST") {
          const transitionId = JSON.parse(init.body).transition.id;
          jiraStatus = transitionId === "start"
            ? { name: "In Progress", statusCategory: { key: "indeterminate" } }
            : { name: "To Do", statusCategory: { key: "new" } };
          return new Response(null, { status: 204 });
        }
        return Response.json({
          transitions: [
            { id: "start", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "wait", name: "Wait", to: { name: "To Do", statusCategory: { key: "new" } } },
          ],
        });
      }
      if (parsed.pathname === "/rest/api/2/issue/LIFE-2") {
        if (!canonicalAvailable) return Response.json({}, { status: 404 });
        return Response.json({
          id: "2",
          key: "LIFE-2",
          fields: {
            summary: "Canonical requirement",
            description: "Canonical Jira",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            assignee: { accountId: "account-b", displayName: "Other" },
            reporter: { accountId: "account-b", displayName: "Other" },
            project: { key: "OTHER" },
            labels: [],
            resolution: null,
            issuelinks: [],
          },
        });
      }
      throw new Error(`Unexpected Jira request: ${parsed.pathname}`);
    },
    interruptNativeThread: async (binding) => {
      interruptedNativeThreads.push(binding);
      await onNativeInterrupt?.();
      if (binding.threadId === failingNativeThreadId) throw new Error("native interrupt unavailable");
      return { interrupted: true };
    },
  });

  try {
    const address = await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    const jira = (await api(baseUrl, "/api/tasks?projectId=jira-my-tasks")).tasks[0];

    app.database.createProject({ id: "repo", name: "Repository", workspacePath: directory });
    await api(baseUrl, `/api/tasks/${jira.id}/jira-context`, "PUT", {
      version: jira.version,
      projectIds: ["repo"],
    });
    const first = app.database.createTask({
      projectId: "repo",
      title: "First",
      description: "",
      status: "backlog",
      priority: "medium",
      labels: [],
      actor: ACTOR,
      assignee: ACTOR,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const second = app.database.createTask({
      projectId: "repo",
      title: "Second",
      description: "",
      status: "backlog",
      priority: "medium",
      labels: [],
      actor: ACTOR,
      assignee: ACTOR,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const independent = app.database.createTask({
      projectId: "repo",
      title: "Independent",
      description: "",
      status: "backlog",
      priority: "medium",
      labels: [],
      actor: ACTOR,
      assignee: ACTOR,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const failing = app.database.createTask({
      projectId: "repo",
      title: "Failing interrupt",
      description: "",
      status: "backlog",
      priority: "medium",
      labels: [],
      actor: ACTOR,
      assignee: ACTOR,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const archived = app.database.createTask({
      projectId: "repo",
      title: "Archived linked issue",
      description: "",
      status: "backlog",
      priority: "medium",
      labels: [],
      actor: ACTOR,
      assignee: ACTOR,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    app.database.addTaskRelation(
      second.id,
      second.version,
      "blocked_by",
      first.id,
      undefined,
      undefined,
      ACTOR,
    );
    for (const task of [first, second, independent, failing, archived]) {
      const context = app.database.getJiraContext(jira.id);
      app.database.addJiraTaskLink(jira.id, context.jira.version, task.id, ACTOR);
    }
    app.database.archiveTask(archived.id, archived.version, undefined, undefined, ACTOR);

    let currentJira = app.database.getTask(jira.id);
    await api(baseUrl, `/api/tasks/${jira.id}/move`, "POST", {
      version: currentJira.version,
      status: "in_progress",
    });
    let tasks = (await api(baseUrl, "/api/tasks?projectId=repo")).tasks;
    assert.equal(tasks.find((task) => task.id === first.id).status, "todo");
    assert.equal(tasks.find((task) => task.id === second.id).status, "backlog");
    const backlogBound = (await api(baseUrl, `/api/tasks/${second.id}/move`, "POST", {
      version: tasks.find((task) => task.id === second.id).version,
      status: "backlog",
      threadBinding: {
        threadId: "native-backlog-thread",
        codexProjectId: "repo",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: directory,
      },
    })).task;
    let running = tasks.find((task) => task.id === independent.id);
    running = (await api(baseUrl, `/api/tasks/${running.id}/move`, "POST", {
      version: running.version,
      status: "in_progress",
      threadBinding: {
        threadId: "native-running-thread",
        codexProjectId: "repo",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: directory,
      },
    })).task;
    let failingInterrupt = tasks.find((task) => task.id === failing.id);
    failingInterrupt = (await api(baseUrl, `/api/tasks/${failingInterrupt.id}/move`, "POST", {
      version: failingInterrupt.version,
      status: "in_progress",
      threadBinding: {
        threadId: "native-failing-thread",
        codexProjectId: "repo",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: directory,
      },
    })).task;
    const runningThread = app.database.createAiChatThread({
      id: "running-thread",
      title: running.identifier,
      origin: {
        projectId: "repo",
        projectName: "Repository",
        workspacePath: directory,
        issueId: running.id,
        issueIdentifier: running.identifier,
      },
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const runningRun = app.database.createAiChatRun({
      id: "running-run",
      threadId: runningThread.id,
      status: "running",
    });
    const backlogThread = app.database.createAiChatThread({
      id: "backlog-running-thread",
      title: second.identifier,
      origin: {
        projectId: "repo",
        projectName: "Repository",
        workspacePath: directory,
        issueId: second.id,
        issueIdentifier: second.identifier,
      },
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const backlogRun = app.database.createAiChatRun({
      id: "backlog-running-run",
      threadId: backlogThread.id,
      status: "running",
    });

    currentJira = app.database.getTask(jira.id);
    await api(baseUrl, `/api/tasks/${jira.id}`, "PATCH", {
      version: currentJira.version,
      status: "todo",
    });
    let context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending.kind, "waiting");
    assert.equal(context.lifecycle.pending.suggestedAction, "pause");

    let response = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-simple-start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: app.database.getTask(jira.id).version }),
    });
    let payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "JIRA_LIFECYCLE_PENDING");

    onNativeInterrupt = async () => {
      onNativeInterrupt = null;
      const blockedMove = await fetch(`${baseUrl}/api/tasks/${second.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        body: JSON.stringify({ version: app.database.getTask(second.id).version, status: "todo" }),
      });
      const blockedMovePayload = await blockedMove.json();
      assert.equal(blockedMove.status, 409);
      assert.equal(blockedMovePayload.error.code, "JIRA_PAUSE_IN_PROGRESS");
      const blockedRestore = await fetch(`${baseUrl}/api/tasks/${archived.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        body: JSON.stringify({ version: app.database.getTask(archived.id).version }),
      });
      const blockedRestorePayload = await blockedRestore.json();
      assert.equal(blockedRestore.status, 409);
      assert.equal(blockedRestorePayload.error.code, "JIRA_PAUSE_IN_PROGRESS");
    };
    failingNativeThreadId = failingInterrupt.threadBinding.threadId;

    response = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: context.lifecycle.version, action: "pause" }),
    });
    payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "CODEX_INTERRUPT_PARTIAL_FAILURE");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending, null);
    tasks = (await api(baseUrl, "/api/tasks?projectId=repo")).tasks;
    assert.equal(tasks.find((task) => task.id === first.id).status, "backlog");
    assert.equal(tasks.find((task) => task.id === independent.id).status, "blocked");
    assert.equal(tasks.find((task) => task.id === failing.id).status, "blocked");
    assert.equal(tasks.find((task) => task.id === second.id).status, "backlog");
    assert.equal(app.database.getTask(archived.id).archivedAt !== null, true);
    assert.equal(app.database.getAiChatRun(runningRun.id).status, "interrupted");
    assert.equal(app.database.getAiChatRun(backlogRun.id).status, "interrupted");
    assert.equal(app.database.getAiChatThread(runningThread.id).currentRun, null);
    assert.equal(app.database.getAiChatThread(backlogThread.id).currentRun, null);
    assert.deepEqual(
      new Set(interruptedNativeThreads.map((binding) => binding.threadId)),
      new Set([
        running.threadBinding.threadId,
        failingInterrupt.threadBinding.threadId,
        backlogBound.threadBinding.threadId,
      ]),
    );
    context = app.database.removeJiraTaskLink(
      jira.id,
      context.jira.version,
      archived.id,
      ACTOR,
    );

    jiraStatus = { name: "In Progress", statusCategory: { key: "indeterminate" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    tasks = (await api(baseUrl, "/api/tasks?projectId=repo")).tasks;
    assert.equal(tasks.find((task) => task.id === first.id).status, "todo");
    assert.equal(tasks.find((task) => task.id === independent.id).status, "todo");
    assert.equal(tasks.find((task) => task.id === second.id).status, "backlog");

    const currentFirst = tasks.find((task) => task.id === first.id);
    const completedExecutionThread = app.database.createAiChatThread({
      id: "completed-execution-thread",
      title: currentFirst.identifier,
      origin: {
        projectId: currentFirst.projectId,
        projectName: "Repository",
        workspacePath: directory,
        issueId: currentFirst.id,
        issueIdentifier: currentFirst.identifier,
      },
      codexThreadId: "codex-completed-execution-thread",
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    app.database.enqueueClaim(currentFirst.id, "manual");
    app.database.setClaimThread(currentFirst.id, completedExecutionThread.id);
    await api(baseUrl, `/api/tasks/${currentFirst.id}/move`, "POST", {
      version: currentFirst.version,
      status: "done",
    });
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    tasks = (await api(baseUrl, "/api/tasks?projectId=repo")).tasks;
    assert.equal(tasks.find((task) => task.id === second.id).status, "todo");

    for (const task of tasks) {
      if (task.status === "done") continue;
      await api(baseUrl, `/api/tasks/${task.id}/move`, "POST", {
        version: task.version,
        status: "done",
      });
    }
    jiraStatus = { name: "Done", statusCategory: { key: "done" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    assert.ok(app.database.getAiChatThread(completedExecutionThread.id).archivedAt);
    assert.equal(
      app.database.listAiChatThreads().some((thread) => thread.id === completedExecutionThread.id),
      false,
    );
    jiraStatus = { name: "In Progress", statusCategory: { key: "indeterminate" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending.kind, "reopened");
    const historicalIds = new Set(context.issues.map((issue) => issue.id));

    const threadCount = app.database.listAiChatThreads().length;
    response = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-planning`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: context.jira.version }),
    });
    payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "JIRA_REPLAN_REQUIRED");
    assert.equal(app.database.listAiChatThreads().length, threadCount);

    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-lifecycle`, "POST", {
      version: context.lifecycle.version,
      action: "rework",
    })).context;
    const rework = context.issues.find((issue) => !historicalIds.has(issue.id));
    assert.ok(rework);
    assert.equal(rework.status, "todo");
    assert.ok(context.issues.filter((issue) => historicalIds.has(issue.id)).every((issue) => issue.status === "done"));

    jiraStatus = { name: "Done", statusCategory: { key: "done" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending.kind, "ended");
    assert.deepEqual(
      (await api(baseUrl, "/api/tasks?projectId=jira-my-tasks")).tasks.map((task) => task.externalKey),
      ["LIFE-1"],
    );
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-lifecycle`, "POST", {
      version: context.lifecycle.version,
      action: "keep",
    })).context;
    assert.equal(context.lifecycle.pending, null);
    assert.equal(context.jira.archivedAt !== null, true);
    assert.deepEqual(
      (await api(baseUrl, "/api/tasks?projectId=jira-my-tasks")).tasks,
      [],
    );

    jiraStatus = { name: "In Progress", statusCategory: { key: "indeterminate" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    duplicateOf = "LIFE-2";
    jiraStatus = { name: "Duplicate", statusCategory: { key: "done" } };
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending.kind, "duplicate");
    assert.equal(context.lifecycle.duplicateOf.externalKey, "LIFE-2");
    assert.equal(context.lifecycle.duplicateOf.accessible, true);
    assert.deepEqual(
      (await api(baseUrl, "/api/tasks?projectId=jira-my-tasks")).tasks.map((task) => task.externalKey),
      ["LIFE-1"],
    );
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.pending.kind, "duplicate");
    assert.deepEqual(
      (await api(baseUrl, "/api/tasks?projectId=jira-my-tasks")).tasks.map((task) => task.externalKey),
      ["LIFE-1"],
    );

    canonicalAvailable = false;
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.duplicateOf.accessible, false);

    canonicalAvailable = true;
    await api(baseUrl, "/api/local/jira-connection/sync", "POST");
    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-context`)).context;
    assert.equal(context.lifecycle.duplicateOf.accessible, true);

    context = (await api(baseUrl, `/api/tasks/${jira.id}/jira-lifecycle`, "POST", {
      version: context.lifecycle.version,
      action: "migrate",
    })).context;
    const migrated = (await api(baseUrl, `/api/tasks/${rework.id}/jira-context`)).context;
    assert.equal(migrated.jira.externalKey, "LIFE-2");
    assert.equal(context.issues.length, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
