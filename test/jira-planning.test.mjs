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
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"codex-jira-plan"}\\n');
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
    app.database.createProject({ id: "api", name: "API", workspacePath: workspace });
    app.database.createProject({ id: "web", name: "Web", workspacePath: workspace });
    app.database.syncJiraTasks([{
      id: "jira-plan-1",
      identifier: "JIRA:TEST:1",
      title: "Checkout",
      description: "Build checkout",
      status: "todo",
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
      externalStatus: "To Do",
      createdAt: timestamp,
      updatedAt: timestamp,
    }], { originId: "test", projectName: "Jira", syncedAt: timestamp });

    let jira = app.database.getTask("jira-plan-1");
    let result = await api(baseUrl, `/api/tasks/${jira.id}/jira-planning`, "POST", {
      version: jira.version,
    });
    assert.equal(result.context.plan.status, "planning");
    assert.ok(result.context.plan.promptedAt);
    assert.equal(app.database.getAiChatThread(result.context.plan.threadId).sandbox, "read-only");
    const planningThreadId = result.context.plan.threadId;
    await waitFor(() => app.database.getAiChatThread(planningThreadId).currentRun === null);

    app.database.setJiraProjects(jira.id, jira.version, ["api", "web"], AGENT);
    jira = app.database.getTask(jira.id);
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
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
