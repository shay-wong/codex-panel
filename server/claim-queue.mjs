import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";
import { resolveWorkflow, workflowNotice } from "./workflow-settings.mjs";

const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [30_000, 120_000];

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown execution error");
}

function isTransientError(error) {
  const code = error instanceof ApiError ? error.code : error?.code;
  if (["THREAD_BUSY", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  return /(?:connection|network|timed? out|temporar|rate.?limit|\b429\b|spawn|codex exited|did not provide a thread id)/i
    .test(errorText(error));
}

function executionPrompt(task, executionIdentifier = task.identifier, peers = [], reuse = false, execution, review) {
  const branchInstruction = executionIdentifier === task.identifier
    ? `创建分支时使用任务标识 ${executionIdentifier}。`
    : `创建分支时使用 Jira 标识 ${executionIdentifier}，不要使用 Panel Issue 标识 ${task.identifier}。`;
  return [
    `自动执行 ${executionIdentifier} 对应的 Panel 议题 ${task.identifier}：${task.title}`,
    execution.skills.length
      ? `实施阶段按顺序使用：${execution.skills.map((skill) => skill.id).join(" → ")}。`
      : "使用 Codex 默认开发流程，读取项目约定、实现需求并运行相关验证。",
    workflowNotice(execution),
    review.skills.length
      ? `审核阶段按顺序使用：${review.skills.map((skill) => skill.id).join(" → ")}。审核流程以此配置为准。`
      : "验证后、提交前运行官方 Codex 审核命令 codex review --uncommitted，读取结果并修复实际问题；若改动已提交则使用 codex review --base <本次开发起点的提交SHA> 覆盖本次全部改动。不要把自行总结当成已执行官方审核。",
    workflowNotice(review),
    branchInstruction,
    ...(peers.length > 1 ? [
      `同一 Jira、同一仓库的执行议题：${peers.map((peer) => `${peer.identifier}（${peer.status}）`).join('、')}。共用当前执行对话、分支和工作树，按依赖顺序逐项处理；每张议题独立绑定、记录进度和审核结果。本轮只处理 ${task.identifier}，后续议题由队列继续派发；不要执行尚未授权的 backlog 议题。`,
    ] : []),
    ...(reuse ? ['继续使用当前会话已有的分支和工作树，不要重新创建分支、工作树或执行对话。'] : []),
    "开始前读取该议题的最新描述和全部评论，并严格按当前内容实施。不要创建第二个执行对话。",
    "完成实现、验证和本地代码审核后，在议题中记录关键改动、验证结果和剩余限制，并移动到 in_review。",
    "如果必须等待用户输入，在议题中提出明确问题并移动到 blocked；如果实施或测试确认失败，也记录原因并移动到 blocked。",
  ].join("\n\n");
}

export class ClaimQueueService {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.managePanelSkillPath = options.managePanelSkillPath ?? null;
    this.onTaskChanged = options.onTaskChanged ?? (() => {});
    this.onCommentCreated = options.onCommentCreated ?? (() => {});
    this.onQueueChanged = options.onQueueChanged ?? (() => {});
    this.onPolicyChanged = options.onPolicyChanged ?? (() => {});
    this.prepareExecution = options.prepareExecution ?? (async (task) => ({ task, workspacePath: null }));
    this.cleanupExecution = options.cleanupExecution ?? (async () => null);
    this.tickMs = options.tickMs ?? 1_000;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timer = null;
    this.ticking = false;
    this.wakeRequested = false;
    this.started = false;
    this.closed = false;
    this.activeExecutions = new Map();
    this.nativeReservations = new Map();
    this.#recoverInterruptedClaims();
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.#schedule(0);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getProjectPolicy(projectId) {
    return this.database.getProjectAutomationPolicy(projectId);
  }

  saveProjectPolicy(projectId, input) {
    const policy = this.database.saveProjectAutomationPolicy(projectId, input);
    this.onPolicyChanged(policy);
    this.#wake();
    return policy;
  }

  enqueue(taskId, source = "manual") {
    let task = this.database.getTask(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    if (source === "manual") this.database.assertIssueExecutionAllowed(taskId);
    if (task.status === "blocked") {
      if (source === "manual") {
        const claim = this.database.getClaimQueueItem(taskId);
        if (claim?.state !== "blocked" || claim.lastError === null) {
          throw new ApiError(
            409,
            "CLAIM_USER_INPUT_REQUIRED",
            "Reply to the blocked issue or conversation before continuing execution",
          );
        }
        source = "resume";
      }
      if (source !== "resume") {
        throw new ApiError(409, "CLAIM_TASK_STATUS", "Only waiting issues can be started manually");
      }
      task = this.#moveTask(task, "todo");
    }
    const claim = this.database.enqueueClaim(task.id, source);
    this.onQueueChanged(claim);
    this.#wake();
    return { task: this.database.getTask(task.id), claim };
  }

  resumeFromUserComment(taskId) {
    const claim = this.database.getClaimQueueItem(taskId);
    const task = this.database.getTask(taskId);
    if (!claim || task?.status !== "blocked") return null;
    try {
      this.database.assertIssueExecutionAllowed(taskId);
    } catch (error) {
      if (error instanceof ApiError && error.code.startsWith("JIRA_")) return null;
      throw error;
    }
    if (claim.state === "blocked") {
      if (claim.lastError !== null) return null;
      return this.enqueue(taskId, "resume");
    }
    if (claim.state !== "running") return null;
    const pending = this.database.requestClaimResume(taskId);
    if (!pending) return null;
    this.onQueueChanged(pending);
    return { task, claim: pending };
  }

  resumeAfterUserTurn(threadId, runId) {
    const thread = this.aiChat.getThread(threadId);
    const taskId = thread.origin.issueId;
    const claim = taskId ? this.database.getClaimQueueItem(taskId) : null;
    const task = taskId ? this.database.getTask(taskId) : null;
    if (!taskId || claim?.state !== "blocked" || task?.status !== "blocked") return false;
    const resume = () => {
      if (!this.closed) this.resumeFromUserComment(taskId);
    };
    void this.aiChat.waitForRun(runId).then(resume, resume);
    return true;
  }

  async runOnce() {
    await this.#tick(false);
  }

  async reserveNextNativeClaim() {
    if (!this.managePanelSkillPath) {
      throw new ApiError(409, "NATIVE_CLAIM_UNAVAILABLE", "Native Codex claim execution is unavailable");
    }
    await this.#tick(false);
    const now = Date.now();
    for (const [taskId, reservation] of this.nativeReservations) {
      if (reservation.expiresAt <= now) {
        await this.#failNativeReservation(
          reservation.reservationId,
          taskId,
          new Error("Codex native claim reservation timed out"),
        );
      }
    }
    const runningByProject = new Map();
    for (const { task } of this.database.listRunningClaims()) {
      if (!task) continue;
      runningByProject.set(task.projectId, (runningByProject.get(task.projectId) ?? 0) + 1);
    }
    for (const next of this.database.listReadyClaims()) {
      if (this.nativeReservations.has(next.task.id)) continue;
      const peers = this.database.jiraExecutionPeers(next.task.id);
      if (peers.some((peer) => peer.id !== next.task.id && (
        peer.status === 'in_progress'
        || (peer.status === 'blocked' && (peer.threadBinding || this.database.getClaimQueueItem(peer.id)))
        || this.nativeReservations.has(peer.id)
        || this.database.getClaimQueueItem(peer.id)?.state === 'running'
      ))) continue;
      if (next.task.relations.blockedBy.some((dependency) => (
        !['done', 'canceled'].includes(dependency.status)
        && !(dependency.status === 'in_review' && peers.some((peer) => peer.id === dependency.id))
      ))) continue;
      const owners = peers.filter((peer) => (
        peer.threadBinding && peer.developmentContext && ['in_review', 'done'].includes(peer.status)
      ));
      const prerequisites = owners.filter((peer) => next.task.relations.blockedBy.some((dependency) => dependency.id === peer.id));
      const candidates = prerequisites.length ? prerequisites : owners;
      const identities = new Set(candidates.map((peer) => JSON.stringify(peer.threadBinding)));
      if ((runningByProject.get(next.task.projectId) ?? 0) >= next.policy.parallelism) continue;
      const reservation = {
        reservationId: randomUUID(),
        taskId: next.task.id,
        projectId: next.task.projectId,
        expiresAt: now + 10 * 60_000,
      };
      this.nativeReservations.set(next.task.id, reservation);
      try {
        this.onQueueChanged(this.database.markClaimRunning(next.task.id, true));
        if (!next.task.threadBinding && identities.size > 1) {
          throw new ApiError(409, 'CLAIM_THREAD_CONFLICT', '同一 Jira 存在多个执行上下文，请先为此任务绑定要继续的会话');
        }
        const owner = next.task.threadBinding ? next.task : candidates[0];
        const prepared = owner ? {
          workspacePath: owner.threadBinding.workspacePath,
          codexProjectId: owner.threadBinding.codexProjectId,
          useWorktree: false,
        } : await this.prepareExecution(next.task);
        const execution = await resolveWorkflow(this.database, this.aiChat, next.task.projectId, "execution");
        const review = await resolveWorkflow(this.database, this.aiChat, next.task.projectId, "review");
        const skills = [...new Map([...execution.skills, ...review.skills].map((skill) => [skill.id, skill])).values()];
        const jira = this.database.getJiraContext(next.task.id).jira;
        const executionIdentifier = jira?.externalKey ?? next.task.identifier;
        reservation.workspacePath = prepared.workspacePath;
        reservation.threadBinding = owner?.threadBinding ?? null;
        reservation.developmentContext = owner?.developmentContext ?? null;
        return {
          ...reservation,
          identifier: executionIdentifier,
          panelIdentifier: next.task.identifier,
          title: `${executionIdentifier} · ${next.task.title}`,
          instruction: executionPrompt(next.task, executionIdentifier, peers, Boolean(owner), execution, review),
          collaborationMode: "default",
          workspacePath: prepared.workspacePath,
          workspaceLabel: prepared.workspaceLabel,
          projectName: prepared.projectName,
          codexProjectId: prepared.codexProjectId ?? next.task.projectId,
          codexProjectKind: "local",
          codexHostId: "local",
          autoSubmit: true,
          useWorktree: prepared.useWorktree !== false,
          skillReferences: [
            { name: "manage-panel", displayName: "Manage Panel", path: this.managePanelSkillPath },
            ...skills.map((skill) => ({ name: skill.id, displayName: skill.label, path: skill.path })),
          ],
        };
      } catch (error) {
        await this.#failNativeReservation(
          reservation.reservationId,
          next.task.id,
          error,
        );
      }
    }
    return null;
  }

  bindNativeClaim(reservationId, taskId, threadBinding, developmentContext = null) {
    const reservation = this.nativeReservations.get(taskId);
    if (!reservation || reservation.reservationId !== reservationId) {
      throw new ApiError(409, "CLAIM_RESERVATION_EXPIRED", "The native claim reservation expired");
    }
    if (reservation.threadBinding && (
      threadBinding.threadId !== reservation.threadBinding.threadId
      || threadBinding.codexProjectId !== reservation.threadBinding.codexProjectId
      || threadBinding.codexHostId !== reservation.threadBinding.codexHostId
    )) {
      throw new ApiError(409, 'CLAIM_THREAD_CONFLICT', 'Codex returned a different shared execution conversation');
    }
    if (threadBinding.workspacePath !== (developmentContext?.path ?? reservation.workspacePath)) {
      throw new ApiError(409, "CLAIM_WORKSPACE_CONFLICT", "Codex returned an unexpected execution workspace");
    }
    const current = this.database.getTask(taskId);
    if (['in_progress', 'in_review', 'done'].includes(current?.status)
      && current.threadBinding?.threadId === threadBinding.threadId
      && current.threadBinding?.workspacePath === threadBinding.workspacePath) {
      this.database.reconcileClaimQueue();
      this.nativeReservations.delete(taskId);
      const claim = this.database.getClaimQueueItem(taskId);
      this.onQueueChanged(claim);
      return { task: this.database.getTask(taskId), claim };
    }
    const result = this.database.bindNativeClaim(
      taskId,
      threadBinding,
      CODEX_AGENT_ACTOR,
      reservation.developmentContext ?? developmentContext,
    );
    this.nativeReservations.delete(taskId);
    this.onTaskChanged(result.task);
    this.onQueueChanged(result.claim);
    return result;
  }

  async failNativeClaim(reservationId, taskId, error) {
    return await this.#failNativeReservation(reservationId, taskId, new Error(error));
  }

  async #failNativeReservation(reservationId, taskId, error) {
    const reservation = this.nativeReservations.get(taskId);
    if (!reservation || reservation.reservationId !== reservationId) return null;
    this.nativeReservations.delete(taskId);
    const task = this.database.getTask(taskId);
    if (task?.threadBinding && ['in_progress', 'in_review', 'done'].includes(task.status)) {
      this.database.reconcileClaimQueue();
      const claim = this.database.getClaimQueueItem(taskId);
      this.onQueueChanged(claim);
      return claim;
    }
    await this.#handleFailure(taskId, null, error);
    return this.database.getClaimQueueItem(taskId);
  }

  async cleanupCompletedTask(task) {
    return await this.cleanupExecution(task);
  }

  #recoverInterruptedClaims() {
    for (const taskId of this.database.recoverInterruptedClaims()) {
      const task = this.database.getTask(taskId);
      const claim = this.database.getClaimQueueItem(taskId);
      const previousAttempt = this.database.listClaimAttempts(taskId).at(-1);
      let thread = null;
      if (claim?.threadId) {
        try {
          thread = this.aiChat.getThread(claim.threadId);
        } catch {}
      }
      const consistent = Boolean(
        task
        && claim?.threadId
        && previousAttempt?.runId
        && previousAttempt.threadId === claim.threadId
        && task.developmentContext?.type === "worktree"
        && thread?.origin.issueId === task.id
        && thread.origin.projectId === task.projectId
        && thread.origin.workspacePath === task.developmentContext.path,
      );
      const legacyConsistent = consistent && Boolean(thread && previousAttempt?.runId);
      if (legacyConsistent && task.status === "blocked" && claim.resumeRequested) {
        this.enqueue(taskId, "resume");
        continue;
      }
      if (!consistent) {
        if (task && ["in_progress", "todo"].includes(task.status)) this.#moveTask(task, "blocked");
        const blocked = this.database.finishClaim(
          taskId,
          "blocked",
          "Interrupted execution context could not be verified after Panel restarted",
        );
        this.onQueueChanged(blocked);
        continue;
      }
      if (!task || task.status !== "in_progress") continue;
      try {
        const moved = this.#moveTask(task, "todo");
        this.onQueueChanged(this.database.getClaimQueueItem(moved.id));
      } catch (error) {
        this.database.finishClaim(taskId, "blocked", errorText(error));
      }
    }
  }

  #schedule(delay = this.tickMs) {
    if (!this.started || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#tick(true);
    }, delay);
    this.timer.unref();
  }

  #wake() {
    if (!this.started || this.closed) return;
    if (this.ticking) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#schedule(0);
  }

  async #tick(reschedule) {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const jiraClaims = this.database.enqueueAuthorizedJiraClaims();
      const scanClaims = this.database.enqueueDueProjectScans();
      for (const taskId of this.database.reconcileClaimQueue()) {
        this.onQueueChanged(this.database.getClaimQueueItem(taskId));
      }
      for (const claim of [...jiraClaims, ...scanClaims]) this.onQueueChanged(claim);
      if (this.managePanelSkillPath) return;
      const runningByProject = new Map();
      const activeWorkspaces = new Set();
      for (const execution of this.activeExecutions.values()) {
        runningByProject.set(
          execution.projectId,
          (runningByProject.get(execution.projectId) ?? 0) + 1,
        );
        activeWorkspaces.add(execution.workspacePath);
      }
      for (const next of this.database.listReadyClaims()) {
        const running = runningByProject.get(next.task.projectId) ?? 0;
        if (running >= next.policy.parallelism) continue;
        let prepared;
        try {
          prepared = await this.prepareExecution(next.task);
        } catch (error) {
          await this.#handleFailure(next.task.id, null, error);
          continue;
        }
        const workspaceKey = prepared.workspaceKey ?? prepared.workspacePath;
        if (workspaceKey && activeWorkspaces.has(workspaceKey)) continue;
        const started = await this.#startClaim(
          { ...next, task: prepared.task },
          prepared.workspacePath,
          workspaceKey,
        );
        if (!started) continue;
        runningByProject.set(next.task.projectId, running + 1);
        if (workspaceKey) activeWorkspaces.add(workspaceKey);
      }
    } finally {
      this.ticking = false;
      if (reschedule && !this.closed) {
        const delay = this.wakeRequested ? 0 : this.tickMs;
        this.wakeRequested = false;
        this.#schedule(delay);
      }
    }
  }

  async #startClaim({ task, policy }, workspacePath, workspaceKey) {
    let attempt = null;
    try {
      let claim = this.database.markClaimRunning(task.id);
      this.onQueueChanged(claim);
      let threadId = this.database.suggestedExecutionThreadId(task.id);
      let thread = null;
      if (threadId) {
        try {
          thread = this.aiChat.getThread(threadId);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "AI_CHAT_THREAD_NOT_FOUND") throw error;
        }
      }
      if (!thread) {
        thread = await this.aiChat.createThread({
          ...(threadId ? { id: threadId } : {}),
          projectId: task.projectId,
          issueId: task.id,
          title: `${task.identifier} · 自动执行`,
          purpose: "formal",
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
          sandbox: "workspace-write",
        });
        threadId = thread.id;
      }
      if (thread.origin.issueId !== task.id || thread.origin.projectId !== task.projectId) {
        throw new ApiError(
          409,
          "CLAIM_THREAD_CONFLICT",
          `Conversation '${thread.id}' does not belong to '${task.identifier}'`,
        );
      }
      if (workspacePath && thread.origin.workspacePath !== workspacePath) {
        throw new ApiError(
          409,
          "CLAIM_WORKSPACE_CONFLICT",
          `Conversation '${thread.id}' does not use the development context for '${task.identifier}'`,
        );
      }
      const previousAttempt = this.database.listClaimAttempts(task.id).at(-1);
      if (previousAttempt && previousAttempt.threadId !== thread.id) {
        throw new ApiError(
          409,
          "CLAIM_ATTEMPT_CONFLICT",
          `Execution history for '${task.identifier}' belongs to another conversation`,
        );
      }
      task = this.#moveTask(task, "in_progress");
      claim = this.database.setClaimThread(task.id, thread.id);
      attempt = this.database.createClaimAttempt({ taskId: task.id, threadId: thread.id });
      const execution = await resolveWorkflow(this.database, this.aiChat, task.projectId, "execution");
      const review = await resolveWorkflow(this.database, this.aiChat, task.projectId, "review");
      const skillIds = [...new Set([...execution.skills, ...review.skills].map((skill) => skill.id))];
      const run = await this.aiChat.startTurn(thread.id, {
        message: [...skillIds.map(() => "\uFFFC"), executionPrompt(task, task.identifier, [], false, execution, review)].join("\n\n"),
        skillIds,
      });
      this.database.attachClaimAttemptRun(attempt.id, run.id);
      this.activeExecutions.set(task.id, {
        runId: run.id,
        projectId: task.projectId,
        workspacePath: workspaceKey,
      });
      void this.aiChat.waitForRun(run.id).then(
        (finished) => this.#finishRun(task.id, attempt.id, finished),
        (error) => this.#handleFailure(task.id, attempt.id, error),
      );
      return true;
    } catch (error) {
      await this.#handleFailure(task.id, attempt?.id ?? null, error);
      return false;
    }
  }

  async #finishRun(taskId, attemptId, run) {
    if (this.closed) return;
    this.activeExecutions.delete(taskId);
    const task = this.database.getTask(taskId);
    if (run.status === "completed" && ["in_review", "done"].includes(task?.status)) {
      this.database.finishClaimAttempt(attemptId, "completed");
      this.onQueueChanged(this.database.finishClaim(taskId, "completed"));
      this.#wake();
      return;
    }
    if (run.status === "completed" && task?.status === "blocked") {
      this.database.finishClaimAttempt(attemptId, "blocked");
      this.#finishBlocked(taskId);
      return;
    }
    const error = run.error
      ?? (run.status === "completed"
        ? "执行已结束，但 Issue 没有进入待审核或阻塞状态"
        : `Codex execution ${run.status}`);
    await this.#handleFailure(taskId, attemptId, new Error(error));
  }

  async #handleFailure(taskId, attemptId, error) {
    if (this.closed) return;
    this.activeExecutions.delete(taskId);
    const message = errorText(error);
    if (attemptId) this.database.finishClaimAttempt(attemptId, "failed", message);
    let task = this.database.getTask(taskId);
    const claim = this.database.getClaimQueueItem(taskId);
    if (task?.status === "blocked" && claim?.resumeRequested) {
      this.#finishBlocked(taskId, message);
      return;
    }
    const canRetry = isTransientError(error) && claim && claim.attemptCount <= MAX_RETRIES;
    if (canRetry) {
      if (task?.status === "in_progress") task = this.#moveTask(task, "todo");
      const delay = this.retryDelaysMs[Math.max(0, claim.attemptCount - 1)]
        ?? this.retryDelaysMs.at(-1)
        ?? 30_000;
      const retryAt = new Date(Date.now() + delay).toISOString();
      this.onQueueChanged(this.database.scheduleClaimRetry(taskId, message, retryAt));
      this.#wake();
      return;
    }
    if (task?.status === "in_progress" || task?.status === "todo") {
      task = this.#moveTask(task, "blocked");
    }
    const comment = this.database.createComment(taskId, {
      body: `自动执行已停止：${message}`,
      actor: CODEX_AGENT_ACTOR,
    });
    this.onCommentCreated({ comment, task: this.database.getTask(taskId) });
    this.#finishBlocked(taskId, message);
  }

  #finishBlocked(taskId, error = null) {
    const blocked = this.database.finishClaim(taskId, "blocked", error);
    if (blocked.resumeRequested) {
      this.enqueue(taskId, "resume");
      return;
    }
    this.onQueueChanged(blocked);
    this.#wake();
  }

  #moveTask(task, status) {
    const moved = this.database.moveTask(
      task.id,
      task.version,
      status,
      undefined,
      undefined,
      undefined,
      CODEX_AGENT_ACTOR,
    );
    this.onTaskChanged(moved);
    return moved;
  }
}
