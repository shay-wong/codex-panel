import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createPanelServer } from "../server/index.mjs";
import { ClaimQueueService } from "../server/claim-queue.mjs";
import { PanelDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "claim-test-user",
  name: "Claim Test User",
  avatarUrl: null,
};
const execFileAsync = promisify(execFile);

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-claim-queue-"));
  const filename = path.join(directory, "panel.sqlite");
  const database = new PanelDatabase(filename);
  database.createProject({ id: "claim-project", name: "Claim Project", workspacePath: directory });
  database.saveProjectAutomationPolicy("claim-project", {
    enabledByUser: true,
    paused: false,
    intervalMinutes: 5,
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
  return {
    database,
    directory,
    filename,
    createTask(title, priority = "none") {
      return database.createTask({
        projectId: "claim-project",
        title,
        description: "",
        status: "todo",
        priority,
        labels: [],
        threadId: null,
        actor,
        assignee: actor,
        workflowId: null,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
      });
    },
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("claim queue persists source order, priority, retry delay, and restart recovery", async () => {
  const item = await fixture();
  try {
    const manual = item.createTask("Manual", "low");
    const resumed = item.createTask("Resumed", "low");
    const jira = item.createTask("Jira", "low");
    const scanLow = item.createTask("Scan low", "low");
    const scanUrgent = item.createTask("Scan urgent", "urgent");

    item.database.enqueueClaim(scanLow.id, "scan");
    item.database.enqueueClaim(jira.id, "jira");
    item.database.enqueueClaim(scanUrgent.id, "scan");
    item.database.enqueueClaim(resumed.id, "resume");
    item.database.enqueueClaim(manual.id, "manual");
    item.database.saveProjectAutomationPolicy("claim-project", {
      enabledByUser: false,
      paused: true,
      intervalMinutes: 5,
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    assert.equal(item.database.nextClaim(), null);
    item.database.saveProjectAutomationPolicy("claim-project", {
      enabledByUser: false,
      paused: false,
      intervalMinutes: 5,
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    assert.deepEqual(item.database.enqueueDueProjectScans(), []);

    for (const expected of [manual.id, resumed.id, scanUrgent.id, scanLow.id, jira.id]) {
      const next = item.database.nextClaim();
      assert.equal(next.task.id, expected, `unexpected next task: ${next.task.title}`);
      item.database.markClaimRunning(expected);
      item.database.finishClaim(expected, "completed");
    }

    const retryTask = item.createTask("Retry after restart", "low");
    item.database.enqueueClaim(retryTask.id, "scan");
    item.database.markClaimRunning(retryTask.id);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    item.database.scheduleClaimRetry(retryTask.id, "temporary", retryAt);
    assert.equal(item.database.nextClaim(), null);
    assert.equal(item.database.nextClaim(new Date(Date.now() + 120_000).toISOString()).task.id, retryTask.id);

    item.database.markClaimRunning(retryTask.id);
    item.database.createAiChatThread({
      id: "claim-thread",
      title: "Claim execution",
      origin: {
        projectId: "claim-project",
        projectName: "Claim Project",
        workspacePath: item.directory,
        issueId: retryTask.id,
        issueIdentifier: retryTask.identifier,
      },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    item.database.setClaimThread(retryTask.id, "claim-thread");
    const attempt = item.database.createClaimAttempt({
      taskId: retryTask.id,
      threadId: "claim-thread",
    });

    item.database.close();
    item.database = new PanelDatabase(item.filename);
    assert.deepEqual(item.database.recoverInterruptedClaims(), [retryTask.id]);
    assert.equal(item.database.getClaimQueueItem(retryTask.id).state, "queued");
    assert.equal(item.database.getClaimQueueItem(retryTask.id).source, "resume");
    assert.equal(item.database.listClaimAttempts(retryTask.id).find((entry) => entry.id === attempt.id).status, "interrupted");
    assert.equal(item.database.getProjectAutomationPolicy("claim-project").enabledByUser, false);
    assert.equal(item.database.nextClaim().task.id, retryTask.id);
  } finally {
    await item.close();
  }
});

test("native claim starts only after Codex returns a complete project binding", async () => {
  const item = await fixture();
  const task = item.createTask("Native execution");
  const queue = new ClaimQueueService({
    database: item.database,
    aiChat: {
      async getCatalog() {
        return { skills: [{ id: "implement", label: "Implement", path: "/skills/implement/SKILL.md" }] };
      },
    },
    managePanelSkillPath: "/skills/manage-panel/SKILL.md",
    prepareExecution: async (candidate) => ({
      task: candidate,
      workspacePath: item.directory,
      workspaceKey: item.directory,
    }),
  });
  try {
    queue.enqueue(task.id);
    const reservation = await queue.reserveNextNativeClaim();
    assert.equal(reservation.taskId, task.id);
    assert.equal(reservation.autoSubmit, true);
    assert.deepEqual(reservation.skillReferences.map((skill) => skill.name), ["manage-panel", "implement"]);
    assert.equal(item.database.getClaimQueueItem(task.id).state, "running");
    assert.equal(item.database.getTask(task.id).status, "todo");

    const bound = queue.bindNativeClaim(reservation.reservationId, task.id, {
      threadId: "native-thread-1",
      codexProjectId: "codex-project-1",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: item.directory,
    });
    assert.equal(bound.claim.state, "running");
    assert.equal(bound.task.status, "in_progress");
    assert.equal(bound.task.threadBinding.threadId, "native-thread-1");
    assert.equal(bound.task.threadBinding.codexProjectId, "codex-project-1");
    assert.equal(item.database.listClaimAttempts(task.id).length, 1);
    assert.equal(item.database.listClaimAttempts(task.id)[0].runId, null);
  } finally {
    queue.close();
    await item.close();
  }
});

test("native claim reservation prevents duplicate dispatch and counts startup failures", async () => {
  const item = await fixture();
  const task = item.createTask("Native startup failure");
  let releasePreparation;
  const preparation = new Promise((resolve) => { releasePreparation = resolve; });
  const queue = new ClaimQueueService({
    database: item.database,
    aiChat: {
      async getCatalog() {
        return { skills: [{ id: "implement", label: "Implement", path: "/skills/implement/SKILL.md" }] };
      },
    },
    managePanelSkillPath: "/skills/manage-panel/SKILL.md",
    prepareExecution: async (candidate) => {
      await preparation;
      return { task: candidate, workspacePath: item.directory, workspaceKey: item.directory };
    },
    retryDelaysMs: [0, 0],
  });
  try {
    queue.enqueue(task.id);
    const firstReservation = queue.reserveNextNativeClaim();
    assert.equal(await queue.reserveNextNativeClaim(), null);
    releasePreparation();
    const reservation = await firstReservation;

    await queue.failNativeClaim(reservation.reservationId, task.id, "Codex connection timed out");
    const claim = item.database.getClaimQueueItem(task.id);
    assert.equal(claim.state, "retry_wait");
    assert.equal(claim.attemptCount, 1);
  } finally {
    queue.close();
    await item.close();
  }
});

test("Jira native claims use the external key for task and branch context", async () => {
  const item = await fixture();
  const task = item.createTask("Jira execution");
  const timestamp = new Date().toISOString();
  item.database.syncJiraTasks([{
    id: "jira-native-1",
    identifier: "JIRA:TEST:1",
    title: "Jira requirement",
    description: "Execute in the repository",
    status: "in_progress",
    priority: "medium",
    labels: [],
    sortOrder: 1000,
    creator: actor,
    assignee: actor,
    dueDate: null,
    externalOrigin: "test",
    externalId: "1",
    externalKey: "TEST-123",
    externalUrl: "https://jira.test/browse/TEST-123",
    externalStatus: "In Progress",
    createdAt: timestamp,
    updatedAt: timestamp,
  }], { originId: "test", projectName: "Jira", syncedAt: timestamp });
  let jira = item.database.getTask("jira-native-1");
  item.database.setJiraProjects(jira.id, jira.version, ["claim-project"], actor);
  jira = item.database.getTask(jira.id);
  item.database.addJiraTaskLink(jira.id, jira.version, task.id, actor);
  const queue = new ClaimQueueService({
    database: item.database,
    aiChat: {
      async getCatalog() {
        return { skills: [{ id: "implement", label: "Implement", path: "/skills/implement/SKILL.md" }] };
      },
    },
    managePanelSkillPath: "/skills/manage-panel/SKILL.md",
    prepareExecution: async (candidate) => ({
      task: candidate,
      workspacePath: item.directory,
      workspaceKey: item.directory,
    }),
  });
  try {
    queue.enqueue(task.id, "jira");
    const reservation = await queue.reserveNextNativeClaim();
    assert.equal(reservation.identifier, "TEST-123");
    assert.match(reservation.title, /^TEST-123 /);
    assert.match(reservation.instruction, /使用 Jira 标识 TEST-123/);
    assert.match(reservation.instruction, new RegExp(`不要使用 Panel Issue 标识 ${task.identifier}`));
  } finally {
    queue.close();
    await item.close();
  }
});

test("claim queue applies project capacity and workspace locks independently", async () => {
  const item = await fixture();
  const otherWorkspace = path.join(item.directory, "other-workspace");
  await mkdir(otherWorkspace);
  item.database.createProject({
    id: "other-project",
    name: "Other Project",
    workspacePath: otherWorkspace,
  });
  item.database.saveProjectAutomationPolicy("claim-project", {
    enabledByUser: true,
    paused: false,
    intervalMinutes: 5,
    model: "gpt-5.5",
    reasoningEffort: "high",
    defaultParallelism: 3,
    parallelismOverride: null,
  });
  item.database.saveProjectAutomationPolicy("other-project", {
    enabledByUser: true,
    paused: false,
    intervalMinutes: 5,
    model: "gpt-5.5",
    reasoningEffort: "high",
    defaultParallelism: 3,
    parallelismOverride: 2,
  });

  const createTask = (projectId, title, priority = "none") => item.database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority,
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  const first = createTask("claim-project", "First shared workspace", "urgent");
  const second = createTask("claim-project", "Second shared workspace", "urgent");
  const isolatedFirst = createTask("claim-project", "First isolated workspace");
  const isolatedSecond = createTask("claim-project", "Second isolated workspace");
  const isolatedThird = createTask("claim-project", "Third isolated workspace");
  const otherFirst = createTask("other-project", "Other project first");
  const otherSecond = createTask("other-project", "Other project second");
  const otherThird = createTask("other-project", "Other project third");
  const isolatedTasks = [isolatedFirst, isolatedSecond, isolatedThird];
  const otherTasks = [otherFirst, otherSecond, otherThird];
  const workspaces = new Map([
    [first.id, path.join(item.directory, "shared")],
    [second.id, path.join(item.directory, "shared")],
    [isolatedFirst.id, path.join(item.directory, "isolated-first")],
    [isolatedSecond.id, path.join(item.directory, "isolated-second")],
    [isolatedThird.id, path.join(item.directory, "isolated-third")],
    [otherFirst.id, path.join(otherWorkspace, "first")],
    [otherSecond.id, path.join(otherWorkspace, "second")],
    [otherThird.id, path.join(otherWorkspace, "third")],
  ]);
  const completions = new Map();
  const aiChat = {
    async createThread(input) {
      return item.database.createAiChatThread({
        title: input.title,
        origin: {
          projectId: input.projectId,
          projectName: item.database.getProject(input.projectId).name,
          workspacePath: workspaces.get(input.issueId),
          issueId: input.issueId,
          issueIdentifier: item.database.getTask(input.issueId).identifier,
        },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        sandbox: input.sandbox,
      });
    },
    getThread(threadId) {
      return item.database.getAiChatThread(threadId);
    },
    async startTurn(threadId) {
      const thread = item.database.getAiChatThread(threadId);
      const run = item.database.createAiChatRun({
        id: `run-${thread.origin.issueId}`,
        threadId,
      });
      let finish;
      const completion = new Promise((resolve) => { finish = resolve; });
      completions.set(run.id, { completion, finish });
      return run;
    },
    waitForRun(runId) {
      return completions.get(runId).completion;
    },
  };
  const queue = new ClaimQueueService({
    database: item.database,
    aiChat,
    prepareExecution: async (task) => ({
      task,
      workspacePath: workspaces.get(task.id),
      workspaceKey: workspaces.get(task.id),
    }),
  });
  try {
    const tasks = [
      first,
      second,
      ...isolatedTasks,
      ...otherTasks,
    ];
    for (const task of tasks) {
      queue.enqueue(task.id);
    }
    await queue.runOnce();

    const sharedRunning = [first, second].find(
      (task) => item.database.getClaimQueueItem(task.id).state === "running",
    );
    const sharedQueued = [first, second].find((task) => task.id !== sharedRunning?.id);
    assert.ok(sharedRunning);
    assert.equal(item.database.getClaimQueueItem(sharedQueued.id).state, "queued");
    assert.equal(
      isolatedTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "running").length,
      2,
    );
    assert.equal(
      isolatedTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "queued").length,
      1,
    );
    assert.equal(
      otherTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "running").length,
      2,
    );
    assert.equal(
      otherTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "queued").length,
      1,
    );
    assert.equal(
      tasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "running").length,
      5,
    );

    const runningFirst = item.database.getTask(sharedRunning.id);
    item.database.moveTask(
      sharedRunning.id,
      runningFirst.version,
      "in_review",
      undefined,
      undefined,
      undefined,
      actor,
    );
    const firstRunId = `run-${sharedRunning.id}`;
    completions.get(firstRunId).finish({ id: firstRunId, status: "completed", error: null });
    await waitFor(() => item.database.getClaimQueueItem(sharedRunning.id).state === "completed");
    await queue.runOnce();

    assert.equal(item.database.getClaimQueueItem(sharedQueued.id).state, "running");
    assert.equal(
      isolatedTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "running").length,
      2,
    );
    assert.equal(
      otherTasks.filter((task) => item.database.getClaimQueueItem(task.id).state === "running").length,
      2,
    );
  } finally {
    queue.close();
    await item.close();
  }
});

test("Panel reserves a repository until Codex binds its native worktree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-automatic-worktrees-"));
  const repository = path.join(directory, "repository");
  const dataDirectory = path.join(directory, "data");
  const codexStatePath = path.join(directory, "codex-state.json");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await writeFile(path.join(repository, "README.md"), "# Fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repository,
    "-c", "user.name=Panel Test",
    "-c", "user.email=panel@example.test",
    "commit", "-m", "fixture",
  ]);
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { repository: { rootPaths: [repository] } },
  }));
  const app = createPanelServer({
    dataDirectory,
    codexExecutable: process.execPath,
    codexStatePath,
    skillPath: "/skills/manage-panel/SKILL.md",
  });
  const createTask = (title) => app.database.createTask({
    projectId: "repository",
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  try {
    app.database.createProject({
      id: "repository",
      name: "Repository",
      workspacePath: repository,
    });
    const task = createTask("Native worktree");
    const nativeWorktree = path.join(directory, "codex-worktree");
    await execFileAsync("git", ["-C", repository, "worktree", "add", "-b", "shay-native-1", nativeWorktree]);
    app.claimQueue.aiChat = {
      async getCatalog() {
        return { skills: [{ id: "implement", label: "Implement", path: "/skills/implement/SKILL.md" }] };
      },
    };
    app.claimQueue.enqueue(task.id);
    const reservation = await app.claimQueue.reserveNextNativeClaim();

    assert.equal(reservation.workspacePath, await realpath(repository));
    assert.equal(reservation.useWorktree, true);
    assert.equal(app.database.getClaimQueueItem(task.id).state, "running");
    assert.equal(app.database.getTask(task.id).developmentContext, null);

    const bound = app.claimQueue.bindNativeClaim(reservation.reservationId, task.id, {
      threadId: "native-thread-1",
      codexProjectId: "repository",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: nativeWorktree,
    }, {
      type: "worktree",
      path: nativeWorktree,
      branch: "shay-native-1",
    });
    assert.equal(bound.claim.state, "running");
    assert.equal(bound.task.status, "in_progress");
    assert.equal(bound.task.developmentContext.path, nativeWorktree);
    assert.equal(bound.task.developmentContext.branch, "shay-native-1");
    assert.equal(bound.task.threadBinding.workspacePath, nativeWorktree);
    await access(nativeWorktree);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed execution blocks and resumes from user input", async () => {
  const item = await fixture();
  const task = item.createTask("Needs user input");
  const aiChat = {
    async createThread(input) {
      return item.database.createAiChatThread({
        id: input.id,
        title: input.title,
        origin: {
          projectId: task.projectId,
          projectName: "Claim Project",
          workspacePath: item.directory,
          issueId: task.id,
          issueIdentifier: task.identifier,
        },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        sandbox: input.sandbox,
      });
    },
    getThread(threadId) {
      return item.database.getAiChatThread(threadId);
    },
    async startTurn() {
      throw new Error("implementation failed");
    },
  };
  const queue = new ClaimQueueService({ database: item.database, aiChat });
  try {
    queue.enqueue(task.id);
    await queue.runOnce();
    assert.equal(item.database.getTask(task.id).status, "blocked");
    assert.equal(item.database.getClaimQueueItem(task.id).state, "blocked");
    assert.match(item.database.listComments(task.id)[0].body, /implementation failed/);

    queue.resumeFromUserComment(task.id);
    assert.equal(item.database.getTask(task.id).status, "todo");
    assert.equal(item.database.getClaimQueueItem(task.id).state, "queued");
    assert.equal(item.database.getClaimQueueItem(task.id).source, "resume");
  } finally {
    queue.close();
    await item.close();
  }
});

test("a reply received before a blocked run settles is resumed afterward", async () => {
  const item = await fixture();
  const task = item.createTask("Reply race");
  let finishRun;
  const completion = new Promise((resolve) => {
    finishRun = resolve;
  });
  const aiChat = {
    async createThread(input) {
      return item.database.createAiChatThread({
        title: input.title,
        origin: {
          projectId: task.projectId,
          projectName: "Claim Project",
          workspacePath: item.directory,
          issueId: task.id,
          issueIdentifier: task.identifier,
        },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        sandbox: input.sandbox,
      });
    },
    getThread(threadId) {
      return item.database.getAiChatThread(threadId);
    },
    async startTurn(threadId) {
      return item.database.createAiChatRun({ id: "reply-race-run", threadId });
    },
    waitForRun() {
      return completion;
    },
  };
  const queue = new ClaimQueueService({ database: item.database, aiChat });
  try {
    queue.enqueue(task.id);
    await queue.runOnce();
    const running = item.database.getTask(task.id);
    item.database.moveTask(
      task.id,
      running.version,
      "blocked",
      undefined,
      undefined,
      undefined,
      actor,
    );

    queue.resumeFromUserComment(task.id);
    assert.equal(item.database.getClaimQueueItem(task.id).state, "running");
    assert.equal(item.database.getClaimQueueItem(task.id).resumeRequested, true);

    finishRun({ id: "reply-race-run", status: "completed", error: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.database.getTask(task.id).status, "todo");
    assert.equal(item.database.getClaimQueueItem(task.id).state, "queued");
    assert.equal(item.database.getClaimQueueItem(task.id).source, "resume");
    assert.equal(item.database.getClaimQueueItem(task.id).resumeRequested, false);
  } finally {
    queue.close();
    await item.close();
  }
});

test("a reply received before a transient failure skips the retry wait", async () => {
  const item = await fixture();
  const task = item.createTask("Reply before retry");
  let failRun;
  const completion = new Promise((resolve, reject) => {
    failRun = reject;
  });
  let resumed;
  const resumedClaim = new Promise((resolve) => {
    resumed = resolve;
  });
  const aiChat = {
    async createThread(input) {
      return item.database.createAiChatThread({
        title: input.title,
        origin: {
          projectId: task.projectId,
          projectName: "Claim Project",
          workspacePath: item.directory,
          issueId: task.id,
          issueIdentifier: task.identifier,
        },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        sandbox: input.sandbox,
      });
    },
    getThread(threadId) {
      return item.database.getAiChatThread(threadId);
    },
    async startTurn(threadId) {
      return item.database.createAiChatRun({ id: "reply-retry-run", threadId });
    },
    waitForRun() {
      return completion;
    },
  };
  const queue = new ClaimQueueService({
    database: item.database,
    aiChat,
    onQueueChanged(claim) {
      if (claim.state === "queued" && claim.source === "resume") resumed();
    },
  });
  try {
    queue.enqueue(task.id);
    await queue.runOnce();
    const running = item.database.getTask(task.id);
    item.database.moveTask(
      task.id,
      running.version,
      "blocked",
      undefined,
      undefined,
      undefined,
      actor,
    );
    queue.resumeFromUserComment(task.id);

    failRun(new Error("connection reset"));
    await resumedClaim;
    assert.equal(item.database.getTask(task.id).status, "todo");
    assert.equal(item.database.getClaimQueueItem(task.id).state, "queued");
    assert.equal(item.database.getClaimQueueItem(task.id).source, "resume");
    assert.equal(item.database.getClaimQueueItem(task.id).resumeRequested, false);
  } finally {
    queue.close();
    await item.close();
  }
});

test("a reply received before restart resumes the interrupted claim", async () => {
  const item = await fixture();
  const task = item.createTask("Reply before restart");
  try {
    item.database.enqueueClaim(task.id, "manual");
    item.database.markClaimRunning(task.id);
    item.database.createAiChatThread({
      id: "reply-restart-thread",
      title: "Claim execution",
      origin: {
        projectId: task.projectId,
        projectName: "Claim Project",
        workspacePath: item.directory,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    item.database.updateTask(task.id, task.version, {
      developmentContext: { type: "worktree", path: item.directory, branch: "panel/reply-restart" },
    }, undefined, undefined, actor);
    item.database.setClaimThread(task.id, "reply-restart-thread");
    const attempt = item.database.createClaimAttempt({
      taskId: task.id,
      threadId: "reply-restart-thread",
    });
    const run = item.database.createAiChatRun({
      id: "reply-restart-run",
      threadId: "reply-restart-thread",
    });
    item.database.attachClaimAttemptRun(attempt.id, run.id);
    const running = item.database.getTask(task.id);
    item.database.moveTask(
      task.id,
      running.version,
      "blocked",
      undefined,
      undefined,
      undefined,
      actor,
    );
    item.database.requestClaimResume(task.id);

    item.database.close();
    item.database = new PanelDatabase(item.filename);
    const queue = new ClaimQueueService({
      database: item.database,
      aiChat: {
        getThread(threadId) {
          return item.database.getAiChatThread(threadId);
        },
      },
    });
    try {
      assert.equal(item.database.getTask(task.id).status, "todo");
      assert.equal(item.database.getClaimQueueItem(task.id).state, "queued");
      assert.equal(item.database.getClaimQueueItem(task.id).source, "resume");
      assert.equal(item.database.getClaimQueueItem(task.id).resumeRequested, false);
      assert.equal(item.database.listClaimAttempts(task.id)[0].status, "interrupted");
    } finally {
      queue.close();
    }
  } finally {
    await item.close();
  }
});

test("restart blocks an interrupted claim whose development context cannot be verified", async () => {
  const item = await fixture();
  const task = item.createTask("Unverifiable restart");
  try {
    item.database.enqueueClaim(task.id, "manual");
    item.database.markClaimRunning(task.id);
    item.database.createAiChatThread({
      id: "unverifiable-thread",
      title: "Claim execution",
      origin: {
        projectId: task.projectId,
        projectName: "Claim Project",
        workspacePath: item.directory,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    item.database.setClaimThread(task.id, "unverifiable-thread");
    const attempt = item.database.createClaimAttempt({
      taskId: task.id,
      threadId: "unverifiable-thread",
    });
    const run = item.database.createAiChatRun({
      id: "unverifiable-run",
      threadId: "unverifiable-thread",
    });
    item.database.attachClaimAttemptRun(attempt.id, run.id);
    item.database.moveTask(
      task.id,
      item.database.getTask(task.id).version,
      "in_progress",
      undefined,
      undefined,
      undefined,
      actor,
    );

    item.database.close();
    item.database = new PanelDatabase(item.filename);
    const queue = new ClaimQueueService({
      database: item.database,
      aiChat: {
        getThread(threadId) {
          return item.database.getAiChatThread(threadId);
        },
      },
    });
    try {
      assert.equal(item.database.getTask(task.id).status, "blocked");
      assert.equal(item.database.getClaimQueueItem(task.id).state, "blocked");
      assert.match(item.database.getClaimQueueItem(task.id).lastError, /could not be verified/);
    } finally {
      queue.close();
    }
  } finally {
    await item.close();
  }
});

test("Jira simple start enters the manual queue even while automatic claiming is off", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-simple-claim-"));
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  const codexStatePath = path.join(directory, "codex-state.json");
  const originId = createHash("sha256").update("claim-queue-jira").digest("hex");
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
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { repo: { rootPaths: [directory] } },
  }));
  let jiraStatus = { name: "To Do", statusCategory: { key: "new" } };
  const app = createPanelServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    skillPath: "/skills/manage-panel/SKILL.md",
    jiraConfigStore: {
      read: async () => ({
        version: 3,
        baseUrl: "https://jira.example.test",
        username: "claim-user",
        password: "token",
        originId,
        accountId: "claim-user",
        displayName: "Claim User",
        projects: [],
      }),
      save: async (config) => config,
    },
    jiraFetch: async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/rest/applinks/1.0/manifest") {
        return Response.json({ id: "claim-queue-jira" });
      }
      if (parsed.pathname === "/rest/api/2/issue/CLAIM-1") {
        return Response.json({ fields: { status: jiraStatus } });
      }
      if (parsed.pathname === "/rest/api/2/issue/CLAIM-1/transitions") {
        if (init.method === "POST") {
          jiraStatus = { name: "In Progress", statusCategory: { key: "indeterminate" } };
          return new Response(null, { status: 204 });
        }
        return Response.json({ transitions: [{
          id: "start",
          name: "Start",
          to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        }] });
      }
      throw new Error(`Unexpected Jira request: ${parsed.pathname}`);
    },
  });
  try {
    const address = await app.listen({ port: 0 });
    const timestamp = new Date().toISOString();
    app.database.createProject({ id: "repo", name: "Repository", workspacePath: directory });
    app.database.saveProjectAutomationPolicy("repo", {
      enabledByUser: false,
      paused: true,
      intervalMinutes: 5,
      model: "gpt-test",
      reasoningEffort: "medium",
    });
    app.database.syncJiraTasks([{
      id: "jira-claim-1",
      identifier: "JIRA:CLAIM:1",
      title: "Claim requirement",
      description: "Run this now",
      status: "todo",
      priority: "medium",
      labels: [],
      sortOrder: 1000,
      creator: actor,
      assignee: actor,
      dueDate: null,
      externalOrigin: originId,
      externalId: "1",
      externalKey: "CLAIM-1",
      externalUrl: "https://jira.example.test/browse/CLAIM-1",
      externalStatus: "To Do",
      createdAt: timestamp,
      updatedAt: timestamp,
    }], { originId, projectName: "Jira", syncedAt: timestamp });
    let jira = app.database.getTask("jira-claim-1");
    app.database.setJiraProjects(jira.id, jira.version, ["repo"], actor);
    jira = app.database.getTask(jira.id);

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/tasks/${jira.id}/jira-simple-start`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        body: JSON.stringify({ version: jira.version }),
      },
    );
    assert.equal(response.status, 200, await response.text());
    const item = app.database.listJiraSimpleStartItems(jira.id)[0];
    const claim = app.database.getClaimQueueItem(item.taskId);
    assert.equal(claim.source, "manual");
    assert.equal(claim.state, "queued");
    assert.equal(claim.threadId, null);
    assert.equal(item.threadId, null);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
