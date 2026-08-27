import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main as panelctl } from "../cli/panelctl.mjs";
import { createPanelServer } from "../server/index.mjs";

const AGENT = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

async function api(baseUrl, pathname, method, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function cli(baseUrl, directory, args) {
  let stdout = "";
  let stderr = "";
  const exitCode = await panelctl(args, {
    cwd: directory,
    env: { CODEX_PANEL_URL: baseUrl },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

test("Jira planning publishes repository tickets and preserves started work during replanning", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-planning-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
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
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"grill-me","enabled":true,"scope":"user","path":"/skills/grill-me/SKILL.md"},{"name":"to-spec","enabled":true,"scope":"user","path":"/skills/to-spec/SKILL.md"},{"name":"to-tickets","enabled":true,"scope":"user","path":"/skills/to-tickets/SKILL.md"}]}]}}\\n');
    }
  });
} else {
  process.stdin.setEncoding("utf8"); let prompt = "";
  process.stdin.on("data", chunk => { prompt += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"codex-jira-plan"}\\n');
    if (prompt.includes("WAIT_REPLAN")) {
      process.stdout.write('{"type":"turn.started"}\\n');
      process.on("SIGTERM", () => setTimeout(() => process.exit(143), 75));
      setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Planning started"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      api: { rootPaths: [workspace] },
      web: { rootPaths: [workspace] },
    },
  }));
  const app = createPanelServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    skillPath: "/skills/manage-panel/SKILL.md",
  });
  try {
    const address = await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const timestamp = new Date().toISOString();
    const jiraIssue = (status, updatedAt = timestamp) => ({
      id: "jira-plan-1",
      identifier: "JIRA:TEST:1",
      title: "Checkout",
      description: "Build checkout",
      status,
      priority: "medium",
      labels: ["特性"],
      sortOrder: 1000,
      creator: AGENT,
      assignee: AGENT,
      dueDate: null,
      externalOrigin: "test",
      externalId: "1",
      externalKey: "TEST-1",
      externalUrl: "https://jira.test/browse/TEST-1",
      externalStatus: status,
      createdAt: timestamp,
      updatedAt,
    });
    app.database.createProject({ id: "api", name: "API", workspacePath: null });
    app.database.createProject({ id: "web", name: "Web", workspacePath: null });
    app.database.syncJiraTasks([jiraIssue("todo")], {
      originId: "test",
      projectName: "Jira",
      syncedAt: timestamp,
    });

    const projectList = await api(baseUrl, "/api/projects", "GET");
    assert.equal(projectList.projects.find((project) => project.id === "api").workspacePath, workspace);
    assert.equal(projectList.projects.find((project) => project.id === "web").workspacePath, workspace);

    let jira = app.database.getTask("jira-plan-1");
    let result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning`, "POST", {
      version: jira.version,
    });
    assert.equal(result.context.plan.status, "planning");
    assert.ok(result.context.plan.promptedAt);
    assert.equal(app.database.getAiChatThread(result.context.plan.threadId).sandbox, "read-only");
    const planningThreadId = result.context.plan.threadId;
    await waitFor(() => app.database.getAiChatThread(planningThreadId).currentRun === null);

    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-context`, "PUT", {
      version: jira.version,
      projectIds: ["api", "web"],
    });
    assert.deepEqual(result.context.projects.map((project) => project.id), ["api", "web"]);
    jira = result.context.jira;
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning`, "POST", {
      version: jira.version,
    });
    assert.equal(result.context.plan.threadId, planningThreadId);
    await waitFor(() => app.database.getAiChatThread(planningThreadId).currentRun === null);

    const specPath = path.join(directory, "spec.md");
    const ticketsPath = path.join(directory, "tickets.json");
    await writeFile(specPath, "# Checkout spec");
    result = await cli(baseUrl, directory, [
      "jira", "planning", "save", jira.id,
      "--spec-file", specPath,
      "--if-version", String(result.context.plan.version),
      "--json",
    ]);
    await writeFile(ticketsPath, JSON.stringify({ items: [
        {
          key: "api",
          projectId: "api",
          title: "Build checkout API",
          description: "API slice",
          priority: "medium",
          labels: ["特性"],
          blockedBy: [],
        },
        {
          key: "web",
          projectId: "web",
          title: "Build checkout UI",
          description: "Web slice",
          priority: "medium",
          labels: ["特性"],
          blockedBy: ["api"],
        },
        {
          key: "docs",
          projectId: "api",
          title: "Document checkout API",
          description: "Independent documentation slice",
          priority: "low",
          labels: ["特性"],
          blockedBy: [],
        },
      ] }));
    result = await cli(baseUrl, directory, [
      "jira", "planning", "publish", jira.id,
      "--tickets-file", ticketsPath,
      "--if-version", String(result.plan.version),
      "--json",
    ]);
    assert.equal(result.plan.status, "published");
    assert.equal(result.context.issues.length, 3);
    const firstItems = new Map(result.plan.items.map((item) => [item.key, item]));
    const apiTask = app.database.getTask(firstItems.get("api").taskId);
    const webTask = app.database.getTask(firstItems.get("web").taskId);
    const docsTask = app.database.getTask(firstItems.get("docs").taskId);
    assert.equal(apiTask.status, "backlog");
    assert.equal(webTask.relations.blockedBy[0].id, apiTask.id);

    app.database.moveTask(apiTask.id, apiTask.version, "in_progress", undefined, undefined, undefined, AGENT);
    app.database.moveTask(docsTask.id, docsTask.version, "in_progress", undefined, undefined, undefined, AGENT);
    app.database.moveTask(webTask.id, webTask.version, "todo", undefined, undefined, undefined, AGENT);
    jira = app.database.getTask(jira.id);
    jira = app.database.updateTask(
      jira.id,
      jira.version,
      { title: "Revised checkout" },
      undefined,
      undefined,
      AGENT,
    );
    assert.equal(app.database.getJiraContext(jira.id).plan.needsReview, true);
    assert.throws(
      () => app.database.moveTask(
        webTask.id,
        app.database.getTask(webTask.id).version,
        "in_progress",
        undefined,
        undefined,
        undefined,
        AGENT,
      ),
      (error) => error?.code === "JIRA_PLAN_REVIEW_REQUIRED",
    );
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning`, "POST", {
      version: jira.version,
    });
    assert.equal(result.context.plan.threadId, planningThreadId);
    assert.equal(result.context.plan.needsReview, true);
    assert.throws(
      () => app.database.moveTask(
        webTask.id,
        app.database.getTask(webTask.id).version,
        "in_progress",
        undefined,
        undefined,
        undefined,
        AGENT,
      ),
      (error) => error?.code === "JIRA_PLAN_REVIEW_REQUIRED",
    );
    await waitFor(() => app.database.getAiChatThread(planningThreadId).currentRun === null);
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning/spec`, "PUT", {
      version: result.context.plan.version,
      spec: "# Revised checkout spec",
    });
    assert.throws(
      () => app.database.beginJiraPlanPublish(jira.id, result.plan.version, [{
        key: "replacement",
        projectId: "web",
        title: "Build revised checkout UI",
        description: "Revised web slice",
        priority: "high",
        labels: ["特性"],
        blockedBy: [],
      }]),
      (error) => error?.code === "JIRA_PLAN_PRESERVED_TASK_REQUIRED",
    );
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning/publish`, "POST", {
      version: result.plan.version,
      items: [
        {
          key: "api",
          projectId: "api",
          title: "Keep checkout API",
          description: "Preserve started API work",
          priority: "medium",
          labels: ["特性"],
          blockedBy: [],
        },
        {
          key: "docs",
          projectId: "api",
          title: "Keep checkout API docs",
          description: "Preserve started documentation work",
          priority: "low",
          labels: ["特性"],
          blockedBy: [],
        },
        {
          key: "replacement",
          projectId: "web",
          title: "Build revised checkout UI",
          description: "Revised web slice",
          priority: "high",
          labels: ["特性"],
          blockedBy: ["api"],
        },
      ],
    });

    assert.equal(app.database.getTask(apiTask.id).status, "in_progress");
    assert.equal(app.database.getTask(webTask.id).status, "canceled");
    const revisedItems = new Map(result.plan.items.map((item) => [item.key, item]));
    assert.equal(revisedItems.get("replacement").task.status, "backlog");
    assert.deepEqual(
      app.database.getTask(apiTask.id).relations.blocks.map((task) => task.id).sort(),
      [webTask.id, revisedItems.get("replacement").taskId].sort(),
    );

    let movedDocsTask = app.database.getTask(docsTask.id);
    movedDocsTask = app.database.updateTask(
      movedDocsTask.id,
      movedDocsTask.version,
      { projectId: "web" },
      undefined,
      undefined,
      AGENT,
    );
    jira = app.database.getTask(jira.id);
    jira = app.database.updateTask(
      jira.id,
      jira.version,
      { title: "Moved checkout docs" },
      undefined,
      undefined,
      AGENT,
    );
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning`, "POST", {
      version: jira.version,
    });
    await waitFor(() => app.database.getAiChatThread(planningThreadId).currentRun === null);
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning/spec`, "PUT", {
      version: result.context.plan.version,
      spec: "# Moved checkout API spec",
    });
    result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning/publish`, "POST", {
      version: result.plan.version,
      items: [
        {
          key: "api",
          projectId: "api",
          title: "Keep checkout API",
          description: "Preserve the API work",
          priority: "medium",
          labels: ["特性"],
          blockedBy: [],
        },
        {
          key: "docs",
          projectId: "web",
          title: "Keep moved checkout API docs",
          description: "Preserve the moved documentation work",
          priority: "low",
          labels: ["特性"],
          blockedBy: [],
        },
      ],
    });
    const movedItems = new Map(result.plan.items.map((item) => [item.key, item]));
    assert.equal(movedItems.get("docs").taskId, docsTask.id);
    assert.equal(movedItems.get("docs").projectId, "web");
    assert.equal(app.database.getTask(docsTask.id).projectId, "web");

    jira = app.database.getTask(jira.id);
    jira = app.database.updateTask(
      jira.id,
      jira.version,
      { description: "Build checkout after completion" },
      undefined,
      undefined,
      AGENT,
    );
    const startTurn = app.aiChat.startTurn.bind(app.aiChat);
    let startTurnCall = 0;
    let enterOldPlanning;
    let releaseOldPlanning;
    let enterFailedReplan;
    let releaseFailedReplan;
    const oldPlanningEntered = new Promise((resolve) => { enterOldPlanning = resolve; });
    const oldPlanningRelease = new Promise((resolve) => { releaseOldPlanning = resolve; });
    const failedReplanEntered = new Promise((resolve) => { enterFailedReplan = resolve; });
    const failedReplanRelease = new Promise((resolve) => { releaseFailedReplan = resolve; });
    app.aiChat.startTurn = async (threadId, input) => {
      startTurnCall += 1;
      if (startTurnCall === 1) {
        enterOldPlanning();
        await oldPlanningRelease;
      } else if (startTurnCall === 2) {
        throw new Error("intentional replan start failure");
      } else if (startTurnCall === 3) {
        enterFailedReplan();
        await failedReplanRelease;
        input = { ...input, message: `${input.message}\nWAIT_REPLAN` };
      }
      return startTurn(threadId, input);
    };
    const oldPlanningRequest = fetch(`${baseUrl}/api/tasks/${jira.id}/jira-planning`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: jira.version }),
    });
    await oldPlanningEntered;

    for (const issue of result.context.issues) {
      const task = app.database.getTask(issue.id);
      if (task && !["done", "canceled"].includes(task.status)) {
        app.database.moveTask(
          task.id,
          task.version,
          "done",
          undefined,
          undefined,
          undefined,
          AGENT,
        );
      }
    }
    const completedAt = new Date(Date.now() + 1_000).toISOString();
    app.database.syncJiraTasks([jiraIssue("done", completedAt)], {
      originId: "test",
      projectName: "Jira",
      syncedAt: completedAt,
    });
    const reopenedAt = new Date(Date.now() + 2_000).toISOString();
    app.database.syncJiraTasks([jiraIssue("in_progress", reopenedAt)], {
      originId: "test",
      projectName: "Jira",
      syncedAt: reopenedAt,
    });
    const reopened = app.database.getJiraContext(jira.id);
    assert.equal(reopened.lifecycle.pending.kind, "reopened");
    const previousPlanningThreadId = reopened.plan.threadId;
    const previousPlanVersion = reopened.plan.version;
    const previousThreadIds = app.aiChat.listThreads().map((thread) => thread.id).sort();

    const planningResponse = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-planning`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.jira.version }),
    });
    const planningPayload = await planningResponse.json();
    assert.equal(planningResponse.status, 409);
    assert.equal(planningPayload.error.code, "JIRA_REPLAN_REQUIRED");

    const failedReplanResponse = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.lifecycle.version, action: "replan" }),
    });
    assert.equal(failedReplanResponse.status, 500);
    const afterStartFailure = app.database.getJiraContext(jira.id);
    assert.equal(afterStartFailure.lifecycle.pending.kind, "reopened");
    assert.equal(afterStartFailure.plan.threadId, previousPlanningThreadId);
    assert.equal(afterStartFailure.plan.version, previousPlanVersion);
    assert.deepEqual(app.aiChat.listThreads().map((thread) => thread.id).sort(), previousThreadIds);

    const completeJiraReplan = app.database.completeJiraReplan.bind(app.database);
    app.database.completeJiraReplan = () => {
      throw new Error("intentional replan commit failure");
    };
    const replanRequest = fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.lifecycle.version, action: "replan" }),
    });
    await failedReplanEntered;
    const failedReplanThread = app.aiChat.listThreads().find(
      (thread) => !previousThreadIds.includes(thread.id),
    );
    assert.ok(failedReplanThread);

    releaseOldPlanning();
    const oldPlanningResponse = await oldPlanningRequest;
    const oldPlanningPayload = await oldPlanningResponse.json();
    assert.equal(oldPlanningResponse.status, 409);
    assert.equal(oldPlanningPayload.error.code, "JIRA_REOPEN_ACTION_IN_PROGRESS");
    await waitFor(() => app.database.getAiChatThread(previousPlanningThreadId).currentRun === null);
    assert.equal(app.database.getJiraContext(jira.id).plan.version, previousPlanVersion);

    const repositoryResponse = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-context`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.jira.version, projectIds: ["api"] }),
    });
    const repositoryPayload = await repositoryResponse.json();
    assert.equal(repositoryResponse.status, 409);
    assert.equal(repositoryPayload.error.code, "JIRA_REOPEN_ACTION_IN_PROGRESS");
    assert.throws(
      () => app.database.syncJiraTasks([jiraIssue("in_progress", reopenedAt)], {
        originId: "test",
        projectName: "Jira",
        syncedAt: reopenedAt,
      }),
      (error) => error?.code === "JIRA_REOPEN_ACTION_IN_PROGRESS",
    );
    const conflictingResponse = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.lifecycle.version, action: "rework" }),
    });
    const conflictingPayload = await conflictingResponse.json();
    assert.equal(conflictingResponse.status, 409);
    assert.equal(conflictingPayload.error.code, "JIRA_REOPEN_ACTION_IN_PROGRESS");
    const duplicateReplanRequest = fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.lifecycle.version, action: "replan" }),
    });
    releaseFailedReplan();
    const [failedCommitResponse, duplicateFailedCommitResponse] = await Promise.all([
      replanRequest,
      duplicateReplanRequest,
    ]);
    assert.equal(failedCommitResponse.status, 500);
    assert.equal(duplicateFailedCommitResponse.status, 500);
    assert.equal(app.database.getAiChatThread(failedReplanThread.id), null);
    assert.equal(app.database.listAiChatRuns(failedReplanThread.id).length, 0);
    const afterCommitFailure = app.database.getJiraContext(jira.id);
    assert.equal(afterCommitFailure.lifecycle.pending.kind, "reopened");
    assert.equal(afterCommitFailure.lifecycle.version, reopened.lifecycle.version);
    assert.equal(afterCommitFailure.plan.threadId, previousPlanningThreadId);
    assert.equal(afterCommitFailure.plan.version, previousPlanVersion);

    app.database.completeJiraReplan = completeJiraReplan;
    app.aiChat.startTurn = startTurn;
    const replanResponse = await fetch(`${baseUrl}/api/tasks/${jira.id}/jira-lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
      body: JSON.stringify({ version: reopened.lifecycle.version, action: "replan" }),
    });
    assert.equal(replanResponse.status, 200);
    result = await replanResponse.json();
    assert.equal(result.context.lifecycle.pending, null);
    assert.notEqual(result.context.plan.threadId, previousPlanningThreadId);
    const nextPlanningThreadId = result.context.plan.threadId;
    assert.equal(app.database.getAiChatThread(previousPlanningThreadId).archivedAt, null);
    await waitFor(() => app.database.getAiChatThread(nextPlanningThreadId).currentRun === null);
    for (const issue of result.context.issues) {
      const task = app.database.getTask(issue.id);
      if (task?.status !== "done") {
        app.database.moveTask(
          task.id,
          task.version,
          "done",
          undefined,
          undefined,
          undefined,
          AGENT,
        );
      }
    }
    const completedAgainAt = new Date(Date.now() + 3_000).toISOString();
    app.database.saveJiraSettings({ autoCompleteEnabled: false, autoArchiveEnabled: true });
    app.database.syncJiraTasks([jiraIssue("done", completedAgainAt)], {
      originId: "test",
      projectName: "Jira",
      syncedAt: completedAgainAt,
    });
    assert.ok(app.database.getAiChatThread(previousPlanningThreadId).archivedAt);
    assert.ok(app.database.getAiChatThread(nextPlanningThreadId).archivedAt);
    assert.equal(
      app.database.listAiChatThreads().some((thread) => (
        thread.id === previousPlanningThreadId || thread.id === nextPlanningThreadId
      )),
      false,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
