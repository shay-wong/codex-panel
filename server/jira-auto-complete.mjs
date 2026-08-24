import { ApiError } from "./database.mjs";

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [30_000, 120_000];

function isTransientError(error) {
  return error instanceof ApiError && error.status >= 500;
}

export class JiraAutoCompleteService {
  constructor(options) {
    this.database = options.database;
    this.jira = options.jira;
    this.onChanged = options.onChanged ?? (() => {});
    this.tickMs = options.tickMs ?? 1_000;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timer = null;
    this.running = false;
    this.started = false;
    this.closed = false;
    this.currentOperation = null;
    this.database.recoverJiraAutoCompletions();
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.database.queueEligibleJiraAutoCompletions();
    this.#schedule(0);
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.currentOperation;
  }

  queueForTask(taskId) {
    const jiraTaskId = this.database.queueEligibleJiraAutoCompletion(taskId);
    if (jiraTaskId) {
      this.onChanged(this.database.getJiraContext(jiraTaskId));
      this.#schedule(0);
    }
    return jiraTaskId;
  }

  reconcile(jiraTaskId) {
    const queued = this.database.reconcileJiraAutoCompletion(jiraTaskId);
    this.onChanged(this.database.getJiraContext(jiraTaskId));
    if (queued) this.#schedule(0);
    return queued;
  }

  queueAllEligible() {
    const jiraTaskIds = this.database.queueEligibleJiraAutoCompletions();
    for (const jiraTaskId of jiraTaskIds) {
      this.onChanged(this.database.getJiraContext(jiraTaskId));
    }
    if (jiraTaskIds.length > 0) this.#schedule(0);
    return jiraTaskIds;
  }

  retry(jiraTaskId) {
    const completion = this.database.queueJiraAutoCompletionRetry(jiraTaskId);
    this.#schedule(0);
    return completion;
  }

  #schedule(delay = this.tickMs) {
    if (!this.started || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#tick();
    }, delay);
    this.timer.unref?.();
  }

  async #tick() {
    if (this.running || this.closed) return;
    const next = this.database.takeNextJiraAutoCompletion();
    if (!next) {
      this.#schedule();
      return;
    }
    this.running = true;
    this.onChanged(this.database.getJiraContext(next.jira.id));
    this.currentOperation = (async () => {
      try {
        const result = await this.jira.completeTask(next.jira, next.completion.expectedUpdatedAt);
        this.onChanged(this.database.finishJiraAutoCompletion(next.jira.id, result));
      } catch (error) {
        const canRetry = isTransientError(error) && next.completion.attemptCount <= MAX_RETRIES;
        const delay = canRetry
          ? this.retryDelaysMs[Math.max(0, next.completion.attemptCount - 1)]
            ?? this.retryDelaysMs.at(-1)
            ?? 30_000
          : null;
        const retryAt = delay === null ? null : new Date(Date.now() + delay).toISOString();
        this.database.failJiraAutoCompletion(next.jira.id, error, {
          retryAt,
          remote: error instanceof ApiError ? error.details?.remote : null,
        });
        this.onChanged(this.database.getJiraContext(next.jira.id));
      }
    })();
    try {
      await this.currentOperation;
    } finally {
      this.currentOperation = null;
      this.running = false;
      this.#schedule(0);
    }
  }
}
