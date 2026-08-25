import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPanelServer } from "../server/index.mjs";

const ORIGIN = createHash("sha256").update("jira-auto-complete-test").digest("hex");
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

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Jira automatic completion");
}

test("Jira automatic completion stays opt-in, confirms transitions, and exposes remote conflicts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-auto-complete-"));
  const remote = new Map(["AUTO-1", "AUTO-2", "AUTO-3"].map((key) => [key, {
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    updated: `2026-08-24T00:00:0${key.at(-1)}.000Z`,
  }]));
  const transitionPosts = new Map();
  let releaseFifthTransitionLookup;
  const fifthTransitionMayRespond = new Promise((resolve) => {
    releaseFifthTransitionLookup = resolve;
  });
  let markFifthTransitionLookupStarted;
  const fifthTransitionLookupStarted = new Promise((resolve) => {
    markFifthTransitionLookupStarted = resolve;
  });
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
    codexExecutable: process.execPath,
    jiraConfigStore: {
      read: async () => jiraConfig,
      save: async (config) => config,
    },
    jiraFetch: async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/rest/applinks/1.0/manifest") {
        return Response.json({ id: "jira-auto-complete-test" });
      }
      if (parsed.pathname === "/rest/api/2/myself") {
        return Response.json({ accountId: "account-a", displayName: "Shay" });
      }
      if (parsed.pathname === "/rest/api/2/search") {
        const issues = [...remote.entries()].flatMap(([key, current]) => (
          current.status.statusCategory.key === "done" ? [] : [{
            id: key.at(-1),
            key,
            fields: {
              summary: key,
              description: "Automatic completion",
              status: current.status,
              updated: current.updated,
              assignee: { accountId: "account-a", displayName: "Shay" },
              reporter: { accountId: "account-a", displayName: "Shay" },
              labels: [],
            },
          }]
        ));
        return Response.json({ total: issues.length, issues });
      }
      const issueMatch = parsed.pathname.match(/^\/rest\/api\/2\/issue\/(AUTO-\d)$/);
      if (issueMatch) {
        const key = issueMatch[1];
        const current = remote.get(key);
        return Response.json({
          id: key.at(-1),
          key,
          fields: {
            summary: key,
            description: "Automatic completion",
            status: current.status,
            updated: current.updated,
            assignee: { accountId: "account-a", displayName: "Shay" },
            reporter: { accountId: "account-a", displayName: "Shay" },
            labels: [],
          },
        });
      }
      const transitionMatch = parsed.pathname.match(/^\/rest\/api\/2\/issue\/(AUTO-\d)\/transitions$/);
      if (transitionMatch) {
        if (init.method === "POST") {
          const key = transitionMatch[1];
          transitionPosts.set(key, (transitionPosts.get(key) ?? 0) + 1);
          remote.set(key, {
            status: { name: "Done", statusCategory: { key: "done" } },
            updated: `2026-08-24T03:00:0${key.at(-1)}.000Z`,
          });
          return new Response(null, { status: 204 });
        }
        if (transitionMatch[1] === "AUTO-5") {
          markFifthTransitionLookupStarted();
          await fifthTransitionMayRespond;
        }
        return Response.json({
          transitions: [{
            id: "done",
            name: "Done",
            to: { name: "Done", statusCategory: { key: "done" } },
          }],
        });
      }
      throw new Error(`Unexpected Jira request: ${parsed.pathname}`);
    },
  });

  try {
    const timestamp = "2026-08-24T00:00:00.000Z";
    app.database.createProject({ id: "repo", name: "Repository", workspacePath: directory });
    for (const [index, key] of ["AUTO-1", "AUTO-2", "AUTO-3"].entries()) {
      const current = remote.get(key);
      app.database.syncJiraTasks([{
        id: `jira-${index + 1}`,
        identifier: `JIRA:TEST:${index + 1}`,
        title: key,
        description: "Automatic completion",
        status: "in_progress",
        priority: "medium",
        labels: [],
        sortOrder: (index + 1) * 1000,
        creator: ACTOR,
        assignee: ACTOR,
        dueDate: null,
        externalOrigin: ORIGIN,
        externalId: String(index + 1),
        externalKey: key,
        externalUrl: `https://jira.example.test/browse/${key}`,
        externalStatus: current.status.name,
        externalUpdatedAt: current.updated,
        createdAt: timestamp,
        updatedAt: timestamp,
      }], {
        archiveMissing: false,
        originId: ORIGIN,
        projectName: "Jira",
        syncedAt: timestamp,
      });
      let jira = app.database.getTask(`jira-${index + 1}`);
      app.database.setJiraProjects(jira.id, jira.version, ["repo"], ACTOR);
      jira = app.database.getTask(jira.id);
      const task = app.database.createTask({
        projectId: "repo",
        title: `Implement ${key}`,
        description: "",
        status: "todo",
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
      app.database.addJiraTaskLink(jira.id, jira.version, task.id, ACTOR);
    }

    const address = await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.deepEqual((await api(baseUrl, "/api/local/jira-settings")).settings, {
      autoCompleteEnabled: false,
      autoArchiveEnabled: false,
    });

    const firstContext = app.database.getJiraContext("jira-1");
    let firstIssue = app.database.getTask(firstContext.issues[0].id);
    const firstPlanningThread = app.database.createAiChatThread({
      id: "auto-planning-thread",
      title: "AUTO-1 planning",
      origin: {
        projectId: "repo",
        projectName: "Repository",
        workspacePath: directory,
      },
      codexThreadId: "codex-auto-planning-thread",
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    app.database.beginJiraPlanning("jira-1", firstContext.jira.version, firstPlanningThread.id);
    const firstExecutionThread = app.database.createAiChatThread({
      id: "auto-execution-thread",
      title: firstIssue.identifier,
      origin: {
        projectId: firstIssue.projectId,
        projectName: "Repository",
        workspacePath: directory,
        issueId: firstIssue.id,
        issueIdentifier: firstIssue.identifier,
      },
      codexThreadId: "codex-auto-execution-thread",
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    app.database.enqueueClaim(firstIssue.id, "manual");
    app.database.setClaimThread(firstIssue.id, firstExecutionThread.id);
    const firstExecutionRun = app.database.createAiChatRun({
      id: "auto-execution-run",
      threadId: firstExecutionThread.id,
      status: "running",
    });
    app.database.insertAiChatEvent({
      id: "auto-execution-event",
      threadId: firstExecutionThread.id,
      runId: firstExecutionRun.id,
      type: "agent_message",
      role: "assistant",
      content: "Implementation completed",
    });
    await api(baseUrl, `/api/tasks/${firstIssue.id}/move`, "POST", {
      version: firstIssue.version,
      status: "done",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(transitionPosts.get("AUTO-1") ?? 0, 0);
    assert.equal(app.database.getJiraAutoCompletion("jira-1"), null);
    assert.equal(app.database.getAiChatThread(firstPlanningThread.id).archivedAt, null);
    assert.equal(app.database.getAiChatThread(firstExecutionThread.id).archivedAt, null);

    await api(baseUrl, "/api/local/jira-settings", "PUT", {
      autoCompleteEnabled: true,
      autoArchiveEnabled: true,
    });
    await waitFor(() => app.database.getJiraAutoCompletion("jira-1")?.state === "completed");
    assert.equal(app.database.getTask("jira-1").status, "done");
    assert.equal(transitionPosts.get("AUTO-1"), 1);
    assert.ok(app.database.getAiChatThread(firstPlanningThread.id).archivedAt);
    assert.ok(app.database.getAiChatThread(firstExecutionThread.id).archivedAt);
    assert.throws(
      () => app.database.createAiChatRun({ threadId: firstPlanningThread.id }),
      (error) => error?.code === "AI_CHAT_THREAD_ARCHIVED",
    );
    assert.equal(
      app.database.listAiChatThreads().some((thread) => thread.id === firstPlanningThread.id),
      false,
    );
    assert.equal(
      app.database.listAiChatThreads().some((thread) => thread.id === firstExecutionThread.id),
      true,
    );
    const archivedSnapshot = await api(
      baseUrl,
      `/api/local/ai/threads/${firstExecutionThread.id}`,
    );
    assert.equal(archivedSnapshot.thread.codexThreadId, "codex-auto-execution-thread");
    assert.deepEqual(archivedSnapshot.runs.map((run) => run.id), [firstExecutionRun.id]);
    assert.deepEqual(archivedSnapshot.events.map((event) => event.id), ["auto-execution-event"]);
    app.database.updateAiChatRun(firstExecutionRun.id, {
      status: "completed",
      finishedAt: timestamp,
    });
    assert.equal(
      app.database.listAiChatThreads().some((thread) => thread.id === firstExecutionThread.id),
      false,
    );

    const secondContext = app.database.getJiraContext("jira-2");
    const secondIssue = app.database.getTask(secondContext.issues[0].id);
    remote.get("AUTO-2").updated = "2026-08-24T01:00:00.000Z";
    await api(baseUrl, `/api/tasks/${secondIssue.id}/move`, "POST", {
      version: secondIssue.version,
      status: "done",
    });
    await waitFor(() => app.database.getJiraAutoCompletion("jira-2")?.state === "conflict");
    assert.equal(transitionPosts.get("AUTO-2") ?? 0, 0);
    await api(baseUrl, "/api/tasks/jira-2/jira-auto-complete", "POST", { action: "retry" });
    await waitFor(() => app.database.getJiraAutoCompletion("jira-2")?.state === "completed");
    assert.equal(transitionPosts.get("AUTO-2"), 1);

    const thirdContext = app.database.getJiraContext("jira-3");
    const thirdIssue = app.database.getTask(thirdContext.issues[0].id);
    remote.get("AUTO-3").updated = "2026-08-24T02:00:00.000Z";
    await api(baseUrl, `/api/tasks/${thirdIssue.id}/move`, "POST", {
      version: thirdIssue.version,
      status: "done",
    });
    await waitFor(() => app.database.getJiraAutoCompletion("jira-3")?.state === "conflict");
    const accepted = await api(
      baseUrl,
      "/api/tasks/jira-3/jira-auto-complete",
      "POST",
      { action: "accept_remote" },
    );
    assert.equal(accepted.context.autoCompletion.state, "dismissed");
    assert.equal(accepted.context.jira.status, "in_progress");
    assert.equal(accepted.context.jira.externalUpdatedAt, "2026-08-24T02:00:00.000Z");
    assert.equal(transitionPosts.get("AUTO-3") ?? 0, 0);

    const fourthRemote = {
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      updated: "2026-08-24T00:00:04.000Z",
    };
    remote.set("AUTO-4", fourthRemote);
    app.database.syncJiraTasks([{
      id: "jira-4",
      identifier: "JIRA:TEST:4",
      title: "AUTO-4",
      description: "Automatic completion",
      status: "in_progress",
      priority: "medium",
      labels: [],
      sortOrder: 4000,
      creator: ACTOR,
      assignee: ACTOR,
      dueDate: null,
      externalOrigin: ORIGIN,
      externalId: "4",
      externalKey: "AUTO-4",
      externalUrl: "https://jira.example.test/browse/AUTO-4",
      externalStatus: fourthRemote.status.name,
      externalUpdatedAt: fourthRemote.updated,
      createdAt: timestamp,
      updatedAt: timestamp,
    }], {
      archiveMissing: false,
      originId: ORIGIN,
      projectName: "Jira",
      syncedAt: timestamp,
    });
    let fourthJira = app.database.getTask("jira-4");
    app.database.setJiraProjects(fourthJira.id, fourthJira.version, ["repo"], ACTOR);
    fourthJira = app.database.getTask(fourthJira.id);
    const fourthIssue = app.database.createTask({
      projectId: "repo",
      title: "Implement AUTO-4",
      description: "",
      status: "done",
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
    app.database.addJiraTaskLink(fourthJira.id, fourthJira.version, fourthIssue.id, ACTOR);
    app.jiraAutoComplete.reconcile(fourthJira.id);
    assert.equal(app.database.getJiraAutoCompletion(fourthJira.id).state, "queued");
    const currentContext = app.database.getJiraContext(fourthJira.id);
    app.database.removeJiraTaskLink(
      fourthJira.id,
      currentContext.jira.version,
      fourthIssue.id,
      ACTOR,
    );
    app.jiraAutoComplete.reconcile(fourthJira.id);
    assert.equal(app.database.getJiraAutoCompletion(fourthJira.id).state, "dismissed");

    const fifthRemote = {
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      updated: "2026-08-24T00:00:05.000Z",
    };
    remote.set("AUTO-5", fifthRemote);
    app.database.syncJiraTasks([{
      id: "jira-5",
      identifier: "JIRA:TEST:5",
      title: "AUTO-5",
      description: "Automatic completion",
      status: "in_progress",
      priority: "medium",
      labels: [],
      sortOrder: 5000,
      creator: ACTOR,
      assignee: ACTOR,
      dueDate: null,
      externalOrigin: ORIGIN,
      externalId: "5",
      externalKey: "AUTO-5",
      externalUrl: "https://jira.example.test/browse/AUTO-5",
      externalStatus: fifthRemote.status.name,
      externalUpdatedAt: fifthRemote.updated,
      createdAt: timestamp,
      updatedAt: timestamp,
    }], {
      archiveMissing: false,
      originId: ORIGIN,
      projectName: "Jira",
      syncedAt: timestamp,
    });
    let fifthJira = app.database.getTask("jira-5");
    app.database.setJiraProjects(fifthJira.id, fifthJira.version, ["repo"], ACTOR);
    fifthJira = app.database.getTask(fifthJira.id);
    const fifthIssue = app.database.createTask({
      projectId: "repo",
      title: "Implement AUTO-5",
      description: "",
      status: "done",
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
    app.database.addJiraTaskLink(fifthJira.id, fifthJira.version, fifthIssue.id, ACTOR);
    app.jiraAutoComplete.reconcile(fifthJira.id);
    await fifthTransitionLookupStarted;
    await api(baseUrl, "/api/local/jira-settings", "PUT", {
      autoCompleteEnabled: false,
      autoArchiveEnabled: true,
    });
    releaseFifthTransitionLookup();
    await waitFor(() => app.database.getJiraAutoCompletion(fifthJira.id)?.state === "dismissed");
    assert.equal(transitionPosts.get("AUTO-5") ?? 0, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed Jira conversation archiving reconciles link and restore eligibility", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-thread-archive-"));
  const app = createPanelServer({ dataDirectory: directory, codexExecutable: process.execPath });
  const timestamp = "2026-08-24T06:00:00.000Z";
  const syncJira = (id, status) => app.database.syncJiraTasks([{
    id,
    identifier: `JIRA:TEST:${id}`,
    title: id,
    description: "Conversation archive eligibility",
    status,
    priority: "medium",
    labels: [],
    sortOrder: 1000,
    creator: ACTOR,
    assignee: ACTOR,
    dueDate: null,
    externalOrigin: ORIGIN,
    externalId: id,
    externalKey: id.toUpperCase(),
    externalUrl: `https://jira.example.test/browse/${id.toUpperCase()}`,
    externalStatus: status,
    externalUpdatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  }], {
    archiveMissing: false,
    originId: ORIGIN,
    projectName: "Jira",
    syncedAt: timestamp,
  });
  const createIssue = (title, status) => app.database.createTask({
    projectId: "repo",
    title,
    description: "",
    status,
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
  const createPlan = (jiraId, threadId) => {
    const thread = app.database.createAiChatThread({
      id: threadId,
      title: threadId,
      origin: { projectId: "repo", projectName: "Repository", workspacePath: directory },
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    app.database.beginJiraPlanning(jiraId, app.database.getTask(jiraId).version, thread.id);
    return thread;
  };
  try {
    app.database.createProject({ id: "repo", name: "Repository", workspacePath: directory });
    app.database.saveJiraSettings({ autoCompleteEnabled: false, autoArchiveEnabled: true });

    syncJira("jira-add", "in_progress");
    let jira = app.database.getTask("jira-add");
    app.database.setJiraProjects(jira.id, jira.version, ["repo"], ACTOR);
    const addThread = createPlan(jira.id, "jira-add-plan");
    const addIssue = createIssue("Add done link", "done");
    syncJira(jira.id, "done");
    assert.equal(app.database.getAiChatThread(addThread.id).archivedAt, null);
    jira = app.database.getTask(jira.id);
    app.database.addJiraTaskLink(jira.id, jira.version, addIssue.id, ACTOR);
    assert.ok(app.database.getAiChatThread(addThread.id).archivedAt);

    syncJira("jira-remove", "in_progress");
    jira = app.database.getTask("jira-remove");
    app.database.setJiraProjects(jira.id, jira.version, ["repo"], ACTOR);
    const removeThread = createPlan(jira.id, "jira-remove-plan");
    const removeDone = createIssue("Remaining done link", "done");
    const removeTodo = createIssue("Removed unfinished link", "todo");
    jira = app.database.getTask(jira.id);
    app.database.addJiraTaskLink(jira.id, jira.version, removeDone.id, ACTOR);
    jira = app.database.getTask(jira.id);
    app.database.addJiraTaskLink(jira.id, jira.version, removeTodo.id, ACTOR);
    syncJira(jira.id, "done");
    assert.equal(app.database.getAiChatThread(removeThread.id).archivedAt, null);
    jira = app.database.getTask(jira.id);
    app.database.removeJiraTaskLink(jira.id, jira.version, removeTodo.id, ACTOR);
    assert.ok(app.database.getAiChatThread(removeThread.id).archivedAt);

    syncJira("jira-restore", "in_progress");
    jira = app.database.getTask("jira-restore");
    app.database.setJiraProjects(jira.id, jira.version, ["repo"], ACTOR);
    const restoreThread = createPlan(jira.id, "jira-restore-plan");
    const restoreIssue = createIssue("Restore done link", "done");
    jira = app.database.getTask(jira.id);
    app.database.addJiraTaskLink(jira.id, jira.version, restoreIssue.id, ACTOR);
    app.database.archiveTask(restoreIssue.id, restoreIssue.version, undefined, undefined, ACTOR);
    syncJira(jira.id, "done");
    assert.equal(app.database.getAiChatThread(restoreThread.id).archivedAt, null);
    const archivedIssue = app.database.getTask(restoreIssue.id);
    app.database.restoreTask(archivedIssue.id, archivedIssue.version, undefined, undefined, ACTOR);
    assert.ok(app.database.getAiChatThread(restoreThread.id).archivedAt);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
