import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_LABEL_NAMES,
  JIRA_PROJECT_ID,
  jiraDescriptionToMarkdown,
} from "../shared/domain.mjs";

const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const CLAIM_SOURCE_RANK = Object.freeze({ manual: 0, resume: 1, jira: 2, scan: 2 });
const CLAIM_SOURCE_RANK_SQL = Object.entries(CLAIM_SOURCE_RANK)
  .map(([source, rank]) => `WHEN '${source}' THEN ${rank}`)
  .join(" ");
const JIRA_SIMPLE_START_ITEMS_TABLE = `
  CREATE TABLE jira_simple_start_items (
    operation_id TEXT NOT NULL REFERENCES jira_simple_start_operations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operation_id, project_id),
    UNIQUE (operation_id, task_id),
    UNIQUE (operation_id, thread_id)
  );
`;
const TASK_TREE_MAX_NODES = 1_000;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function storedThreadBindingForExisting(current, threadBinding, threadId) {
  if (
    threadBinding === undefined
    && current?.threadBinding
    && current.threadBinding.threadId === threadId
  ) {
    return storedThreadBinding(current.threadBinding, threadId);
  }
  return storedThreadBinding(threadBinding, threadId);
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.external_source === "jira"
      ? jiraDescriptionToMarkdown(row.description)
      : row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    developmentContext,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    source: row.external_source === "jira" ? "jira" : "local",
    externalOrigin: row.external_origin ?? null,
    externalKey: row.external_key ?? null,
    externalUrl: row.external_url ?? null,
    externalStatus: row.external_status ?? null,
    externalUpdatedAt: row.external_updated_at ?? null,
    externalSyncedAt: row.external_synced_at ?? null,
    externalSyncError: row.external_sync_error ?? null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    externalKey: row.external_key ?? null,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    externalUrl: row.external_url ?? null,
    externalStatus: row.external_status ?? null,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
    version: row.version,
  };
}

function taskTreeNode(row, parentId, depth, path) {
  return {
    id: row.id,
    parentId,
    depth,
    path,
    summary: {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      archivedAt: row.archived_at,
    },
  };
}

function commentFromRow(row) {
  const comment = {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(comment, "changeRevision", { value: row.change_revision });
  return comment;
}

function attachmentFromRow(row) {
  const attachment = {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
  Object.defineProperty(attachment, "changeRevision", { value: row.change_revision });
  return attachment;
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    source: row.id === JIRA_PROJECT_ID ? "jira" : "local",
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
    failureCount: Number(row.failure_count ?? 0),
  };
}

function projectReadmeFromRow(row, projectId) {
  return {
    projectId: row.project_id ?? projectId,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    purpose: row.purpose ?? "temporary",
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    archivedAt: row.archived_at,
    currentRun: null,
    latestTodo: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jiraSimpleStartFromRow(row) {
  return {
    id: row.id,
    status: row.status,
    transitionedAt: row.transitioned_at,
    projectCount: Number(row.project_count ?? 0),
    readyCount: Number(row.ready_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function jiraPlanItemFromRow(row) {
  return {
    key: row.item_key,
    publication: row.publication,
    projectId: row.project_id,
    taskId: row.task_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    blockedBy: JSON.parse(row.blocked_by),
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function claimQueueItemFromRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    source: row.source,
    state: row.state,
    resumeRequested: Boolean(row.resume_requested),
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function claimAttemptFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    threadId: row.thread_id,
    runId: row.run_id,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && /^[A-Z0-9]+$/i.test(existingPrefix) && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = project.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 3);
  return namePrefix || idPrefix.slice(0, 3);
}

export class PanelDatabase {
  #jiraPauseResolutions = new Map();
  #jiraReopenActions = new Map();

  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        external_status TEXT,
        external_updated_at TEXT,
        external_synced_at TEXT,
        external_sync_error TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS comment_attachment_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      );

      CREATE TABLE IF NOT EXISTS project_readmes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_readme_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
      );

      CREATE TABLE IF NOT EXISTS jira_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        attempted_at TEXT,
        succeeded_at TEXT,
        issue_count INTEGER NOT NULL DEFAULT 0,
        unknown_issue_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS jira_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auto_complete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_complete_enabled IN (0, 1)),
        auto_archive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_archive_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        purpose TEXT NOT NULL DEFAULT 'temporary' CHECK (purpose IN ('temporary', 'formal')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS automation_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_project_parallelism INTEGER NOT NULL DEFAULT 3
          CHECK (default_project_parallelism BETWEEN 1 AND 8),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_automation_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        enabled_by_user INTEGER NOT NULL DEFAULT 0 CHECK (enabled_by_user IN (0, 1)),
        paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
        interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (interval_minutes IN (5, 10, 15, 30, 60)),
        model TEXT NOT NULL DEFAULT 'gpt-5.5',
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        parallelism_override INTEGER CHECK (parallelism_override BETWEEN 1 AND 8),
        next_scan_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_claim_queue (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        thread_id TEXT UNIQUE REFERENCES ai_chat_threads(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'resume', 'jira', 'scan')),
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'running', 'retry_wait', 'blocked', 'failed', 'completed', 'canceled'
        )),
        resume_requested INTEGER NOT NULL DEFAULT 0 CHECK (resume_requested IN (0, 1)),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS issue_claim_queue_dispatch
        ON issue_claim_queue(state, available_at, enqueued_at);

      CREATE TABLE IF NOT EXISTS issue_claim_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT UNIQUE REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted', 'blocked'
        )),
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS issue_claim_attempts_task_started
        ON issue_claim_attempts(task_id, started_at, id);

    `);

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const projectSummaryColumns = this.database.prepare(
      "PRAGMA table_info(project_summaries)",
    ).all();
    if (!projectSummaryColumns.some((column) => column.name === "failure_count")) {
      this.database.exec(`
        ALTER TABLE project_summaries
        ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
      `);
      this.database.exec(`
        UPDATE project_summaries SET failure_count = 1 WHERE error IS NOT NULL
      `);
    }

    const automationPolicyColumns = this.database.prepare(
      "PRAGMA table_info(project_automation_policies)",
    ).all();
    if (!automationPolicyColumns.some((column) => column.name === "parallelism_override")) {
      this.database.exec(`
        ALTER TABLE project_automation_policies
        ADD COLUMN parallelism_override INTEGER CHECK (parallelism_override BETWEEN 1 AND 8)
      `);
    }

    const aiChatThreadColumns = this.database.prepare("PRAGMA table_info(ai_chat_threads)").all();
    if (!aiChatThreadColumns.some((column) => column.name === "archived_at")) {
      this.database.exec("ALTER TABLE ai_chat_threads ADD COLUMN archived_at TEXT");
    }
    if (!aiChatThreadColumns.some((column) => column.name === "purpose")) {
      this.database.exec(`
        ALTER TABLE ai_chat_threads
        ADD COLUMN purpose TEXT NOT NULL DEFAULT 'temporary'
        CHECK (purpose IN ('temporary', 'formal'))
      `);
    }
    this.database.exec(`
      UPDATE ai_chat_threads SET purpose = 'formal'
      WHERE purpose = 'temporary'
        AND id IN (SELECT thread_id FROM issue_claim_queue WHERE thread_id IS NOT NULL)
    `);

    const jiraSettingsColumns = this.database.prepare("PRAGMA table_info(jira_settings)").all();
    if (!jiraSettingsColumns.some((column) => column.name === "auto_archive_enabled")) {
      this.database.exec(`
        ALTER TABLE jira_settings
        ADD COLUMN auto_archive_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (auto_archive_enabled IN (0, 1))
      `);
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasWorkflowId = taskColumns.some((column) => column.name === "workflow_id");
    if (hasWorkflowId) {
      this.database.exec("ALTER TABLE tasks DROP COLUMN workflow_id");
    }
    this.database.exec("DROP TABLE IF EXISTS workflow_workspaces");
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!taskColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_source")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_origin")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_origin TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_key")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_key TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_status")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_status TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_updated_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_updated_at TEXT");
      this.database.exec(`
        UPDATE tasks SET external_updated_at = updated_at WHERE external_source = 'jira'
      `);
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_synced_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_synced_at TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_sync_error")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_sync_error TEXT");
    }
    this.database.exec(`
      DROP INDEX IF EXISTS tasks_external_source_id;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id
      ON tasks(external_source, external_origin, external_id)
      WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL
    `);
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!projectColumns.some((column) => column.name === "labels")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE projects
          ADD COLUMN labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}'
        `);
        const labelsByProject = new Map(
          this.database.prepare("SELECT id FROM projects").all().map((project) => (
            [project.id, [...DEFAULT_LABEL_NAMES]]
          )),
        );
        for (const task of this.database.prepare(`
          SELECT project_id, labels
          FROM tasks
          ORDER BY created_at, id
        `).all()) {
          const projectLabels = labelsByProject.get(task.project_id);
          if (!projectLabels) continue;
          for (const label of JSON.parse(task.labels)) {
            if (!projectLabels.includes(label)) projectLabels.push(label);
          }
        }
        const updateProjectLabels = this.database.prepare(`
          UPDATE projects SET labels = ? WHERE id = ?
        `);
        for (const [projectId, labels] of labelsByProject) {
          updateProjectLabels.run(JSON.stringify(labels), projectId);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';

      CREATE TABLE IF NOT EXISTS jira_task_projects (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS jira_task_links (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, task_id),
        CHECK (jira_task_id <> task_id)
      );

      CREATE INDEX IF NOT EXISTS jira_task_links_jira
        ON jira_task_links(jira_task_id, created_at);

      CREATE TABLE IF NOT EXISTS jira_lifecycles (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        pending_kind TEXT CHECK (pending_kind IN ('waiting', 'ended', 'reopened', 'duplicate')),
        pending_from_status TEXT,
        pending_to_status TEXT,
        pending_created_at TEXT,
        paused_task_ids TEXT NOT NULL DEFAULT '[]',
        reopened INTEGER NOT NULL DEFAULT 0 CHECK (reopened IN (0, 1)),
        is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0, 1)),
        duplicate_of_key TEXT,
        duplicate_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_auto_completions (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'running', 'retry_wait', 'conflict', 'failed', 'completed', 'dismissed'
        )),
        expected_updated_at TEXT,
        remote_updated_at TEXT,
        remote_status TEXT,
        remote_task_status TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jira_auto_completions_dispatch
        ON jira_auto_completions(state, available_at, updated_at);

      CREATE TABLE IF NOT EXISTS jira_rework_items (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, cycle, project_id)
      );

      CREATE TABLE IF NOT EXISTS jira_simple_start_operations (
        id TEXT PRIMARY KEY,
        jira_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('creating', 'complete')),
        transitioned_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ${JIRA_SIMPLE_START_ITEMS_TABLE.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")}

      CREATE TABLE IF NOT EXISTS jira_plans (
        jira_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT UNIQUE REFERENCES ai_chat_threads(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('planning', 'review', 'publishing', 'published')),
        spec TEXT NOT NULL DEFAULT '',
        source_snapshot TEXT NOT NULL,
        prompted_at TEXT,
        publication INTEGER NOT NULL DEFAULT 0 CHECK (publication >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_plan_threads (
        jira_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL UNIQUE REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS jira_plan_items (
        jira_task_id TEXT NOT NULL REFERENCES jira_plans(jira_task_id) ON DELETE CASCADE,
        publication INTEGER NOT NULL CHECK (publication > 0),
        item_key TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        blocked_by TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (jira_task_id, publication, item_key),
        UNIQUE (jira_task_id, publication, task_id)
      );

      CREATE INDEX IF NOT EXISTS jira_plan_items_task
        ON jira_plan_items(task_id);

      CREATE TABLE IF NOT EXISTS jira_plan_edges (
        jira_task_id TEXT NOT NULL REFERENCES jira_plans(jira_task_id) ON DELETE CASCADE,
        publication INTEGER NOT NULL CHECK (publication > 0),
        source_task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        created_relation INTEGER NOT NULL CHECK (created_relation IN (0, 1)),
        PRIMARY KEY (jira_task_id, publication, source_task_id, target_task_id),
        CHECK (source_task_id <> target_task_id)
      );
    `);
    this.database.exec(`
      INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
      SELECT jira_task_id, thread_id, created_at
      FROM jira_plans
      WHERE thread_id IS NOT NULL;

      UPDATE ai_chat_threads SET purpose = 'formal'
      WHERE purpose = 'temporary'
        AND id IN (SELECT thread_id FROM jira_plan_threads);

      CREATE TRIGGER IF NOT EXISTS task_relations_require_same_project
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION')
        WHERE EXISTS (
          SELECT 1
          FROM tasks AS source
          JOIN tasks AS target ON target.id = NEW.target_task_id
          WHERE source.id = NEW.source_task_id
            AND source.project_id != target.project_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS task_relations_prevent_parent_cycle
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'RELATION_CYCLE')
        WHERE EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT source_task_id
            FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = NEW.source_task_id
            UNION
            SELECT task_relations.source_task_id
            FROM task_relations
            JOIN ancestors ON task_relations.target_task_id = ancestors.id
            WHERE task_relations.relation_type = 'parent'
          )
          SELECT 1 FROM ancestors WHERE id = NEW.target_task_id
        );
      END;
    `);

    const taskRelationColumns = this.database.prepare("PRAGMA table_info(task_relations)").all();
    if (!taskRelationColumns.some((column) => column.name === "origin")) {
      this.database.exec(`
        ALTER TABLE task_relations
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual', 'mention'))
      `);
    }

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!commentColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      }
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    if (!commentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = tasks.id
          GROUP BY task_threads.task_id, task_threads.thread_id, task_threads.created_at
          ORDER BY
            CASE WHEN COUNT(comments.thread_id) > 0 THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    if (!attachmentColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('inline', 'attachment'))");
      this.database.exec(`
        UPDATE attachments
        SET kind = 'inline'
        WHERE content_type LIKE 'image/%'
          AND (
            (
              comment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE tasks.id = attachments.task_id
                  AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
            OR (
              comment_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM comments
                WHERE comments.id = attachments.comment_id
                  AND instr(comments.body, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
          )
      `);
    }
    if (!attachmentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS comments_task_change_revision ON comments(task_id, change_revision)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_task_change_revision ON attachments(task_id, change_revision) WHERE comment_id IS NULL");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_change_revision ON attachments(comment_id, change_revision) WHERE comment_id IS NOT NULL");
    const maxChangeRevision = this.database.prepare(`
      SELECT MAX(change_revision) AS value
      FROM (
        SELECT change_revision FROM comments
        UNION ALL
        SELECT change_revision FROM attachments
      )
    `).get().value ?? 0;
    this.database.prepare(`
      INSERT INTO comment_attachment_revision (id, value)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value = MAX(value, excluded.value)
    `).run(maxChangeRevision);

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.database.prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
  }

  close() {
    this.database.close();
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          thread_codex_project_id TEXT,
          thread_codex_project_kind TEXT,
          thread_codex_host_id TEXT,
          thread_workspace_path TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, workspace_path, labels, next_task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.name,
        input.workspacePath,
        DEFAULT_PROJECT_LABELS_JSON,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES (?, ?, NULL, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(JIRA_PROJECT_ID, name, timestamp, timestamp);
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY projects.id
    `).get(JIRA_PROJECT_ID);
  }

  syncJiraTasks(issues, {
    archiveMissing = true,
    originId = null,
    projectName,
    legacyIdentity = null,
    unknownTasks = [],
    syncedAt = now(),
  } = {}) {
    // ponytail: one short global sync lock is enough until multiple Jira providers are supported.
    if (this.#jiraPauseResolutions.size > 0) {
      throw new ApiError(409, "JIRA_PAUSE_IN_PROGRESS", "Jira sync is waiting for a lifecycle pause to finish");
    }
    if (this.#jiraReopenActions.size > 0) {
      throw new ApiError(409, "JIRA_REOPEN_ACTION_IN_PROGRESS", "Jira sync is waiting for a reopened action to finish");
    }
    const timestamp = syncedAt;
    const seenTaskIds = new Set();
    const projectLabels = JSON.stringify([
      ...new Set(issues.flatMap((issue) => issue.labels)),
    ]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `).run(JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      const findExisting = this.database.prepare(`
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      `);
      const migrateLegacyIdentity = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      `);
      if (legacyIdentity) {
        const legacyTasks = this.database.prepare(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        `).all(JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          migrateLegacyIdentity.run(
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }
      const insertTask = this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          external_status, external_updated_at, external_synced_at, external_sync_error,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          ?, ?, ?, NULL,
          ?, 1, ?, ?
        )
      `);
      const updateTask = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          external_status = ?, external_updated_at = ?, external_synced_at = ?, external_sync_error = NULL,
          archived_at = ?,
          version = version + 1, updated_at = ?
        WHERE id = ?
      `);

      for (const issue of issues) {
        const existing = findExisting.get(issue.externalOrigin, issue.externalId);
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        const externalUpdatedAt = issue.externalUpdatedAt ?? issue.updatedAt ?? null;
        if (!existing) {
          insertTask.run(
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            issue.status,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.externalStatus,
            externalUpdatedAt,
            syncedAt,
            issue.archived ? timestamp : null,
            issue.createdAt,
            issue.updatedAt,
          );
          continue;
        }

        this.#syncJiraLifecycle(existing, issue.status, timestamp);
        const lifecycle = this.getJiraLifecycle(existing.id);
        const archived = Boolean(issue.archived)
          && lifecycle.pending?.kind !== "ended"
          && !this.#jiraDuplicateNeedsDecision(existing.id, issue.duplicateOf, lifecycle);

        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== issue.status
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.external_status !== issue.externalStatus
          || existing.external_updated_at !== externalUpdatedAt
          || existing.external_sync_error !== null
          || Boolean(existing.archived_at) !== archived;
        if (!changed) {
          this.database.prepare(`
            UPDATE tasks
            SET external_synced_at = ?, external_sync_error = NULL
            WHERE id = ?
          `).run(syncedAt, existing.id);
          continue;
        }
        updateTask.run(
          issue.identifier,
          issue.title,
          issue.description,
          issue.status,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          issue.externalStatus,
          externalUpdatedAt,
          syncedAt,
          archived ? timestamp : null,
          issue.updatedAt,
          existing.id,
        );
      }

      for (const issue of issues) {
        const task = findExisting.get(issue.externalOrigin, issue.externalId);
        if (task) this.#syncJiraDuplicate(task, issue.duplicateOf, timestamp);
      }

      if (archiveMissing) {
        const existingTasks = this.database.prepare(`
          SELECT id FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND archived_at IS NULL
            AND (? IS NULL OR external_origin = ?)
        `).all(JIRA_PROJECT_ID, originId, originId);
        const archiveTask = this.database.prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `);
        const unknownTaskIds = new Set(unknownTasks.map((task) => task.id));
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id) && !unknownTaskIds.has(task.id)) {
            archiveTask.run(timestamp, timestamp, task.id);
          }
        }
      }
      const markUnknown = this.database.prepare(`
        UPDATE tasks
        SET external_sync_error = ?
        WHERE id = ? AND external_source = 'jira' AND archived_at IS NULL
      `);
      for (const task of unknownTasks) markUnknown.run(task.message, task.id);
      this.#archiveCompletedJiraThreads(timestamp);
      this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(timestamp, JIRA_PROJECT_ID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = this.database.prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `).run(id, id);
    if (result.changes !== 1) {
      const issueCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
      `).get(id).issue_count);
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    return project;
  }

  listActiveJiraTasks(originId) {
    return this.database.prepare(`
      SELECT id, external_id AS externalId, external_key AS externalKey
      FROM tasks
      WHERE external_source = 'jira'
        AND external_origin = ?
        AND archived_at IS NULL
        AND external_key IS NOT NULL
      ORDER BY created_at, id
    `).all(originId);
  }

  getJiraSyncState() {
    const row = this.database.prepare("SELECT * FROM jira_sync_state WHERE id = 1").get();
    return {
      lastAttemptedAt: row?.attempted_at ?? null,
      lastSuccessfulAt: row?.succeeded_at ?? null,
      syncedIssueCount: Number(row?.issue_count ?? 0),
      unknownIssueCount: Number(row?.unknown_issue_count ?? 0),
      syncError: row?.error_message
        ? { code: row.error_code ?? "JIRA_SYNC_FAILED", message: row.error_message }
        : null,
    };
  }

  getJiraSettings() {
    const row = this.database.prepare(
      "SELECT auto_complete_enabled, auto_archive_enabled FROM jira_settings WHERE id = 1",
    ).get();
    return {
      autoCompleteEnabled: Boolean(row?.auto_complete_enabled),
      autoArchiveEnabled: Boolean(row?.auto_archive_enabled),
    };
  }

  saveJiraSettings({ autoCompleteEnabled, autoArchiveEnabled }) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO jira_settings (id, auto_complete_enabled, auto_archive_enabled, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          auto_complete_enabled = excluded.auto_complete_enabled,
          auto_archive_enabled = excluded.auto_archive_enabled,
          updated_at = excluded.updated_at
      `).run(autoCompleteEnabled ? 1 : 0, autoArchiveEnabled ? 1 : 0, timestamp);
      if (!autoCompleteEnabled) {
        this.database.prepare(`
          UPDATE jira_auto_completions
          SET state = 'dismissed', error_code = NULL, error_message = NULL, updated_at = ?
          WHERE state IN ('queued', 'retry_wait')
        `).run(timestamp);
      }
      if (autoArchiveEnabled) this.#archiveCompletedJiraThreads(timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraSettings();
  }

  recordJiraSyncAttempt(attemptedAt = now()) {
    this.database.prepare(`
      INSERT INTO jira_sync_state (id, attempted_at)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET attempted_at = excluded.attempted_at
    `).run(attemptedAt);
  }

  recordJiraSyncSuccess({ attemptedAt, succeededAt, issueCount, unknownIssueCount }) {
    this.database.prepare(`
      INSERT INTO jira_sync_state (
        id, attempted_at, succeeded_at, issue_count, unknown_issue_count, error_code, error_message
      ) VALUES (1, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        succeeded_at = excluded.succeeded_at,
        issue_count = excluded.issue_count,
        unknown_issue_count = excluded.unknown_issue_count,
        error_code = NULL,
        error_message = NULL
    `).run(attemptedAt, succeededAt, issueCount, unknownIssueCount);
  }

  markJiraSyncError(message, code = "JIRA_SYNC_FAILED", attemptedAt = now()) {
    const safeMessage = String(message).slice(0, 1000);
    this.database.prepare(`
      INSERT INTO jira_sync_state (id, attempted_at, error_code, error_message)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error_code = excluded.error_code,
        error_message = excluded.error_message
    `).run(attemptedAt, String(code).slice(0, 120), safeMessage);
    this.database.prepare(`
      UPDATE tasks
      SET external_sync_error = ?
      WHERE external_source = 'jira' AND archived_at IS NULL
    `).run(safeMessage);
  }

  getJiraContext(id) {
    const task = this.#requireTask(id);
    const jiraTask = task.source === "jira"
      ? task
      : (() => {
        const row = this.database.prepare(`
          SELECT jira.*
          FROM jira_task_links
          JOIN tasks AS jira ON jira.id = jira_task_links.jira_task_id
          WHERE jira_task_links.task_id = ?
        `).get(task.id);
        return row ? this.#taskWithRelations(row) : null;
      })();
    if (!jiraTask) {
      const availableJira = task.source === "jira" ? [] : this.database.prepare(`
        SELECT jira.*
        FROM jira_task_projects
        JOIN tasks AS jira ON jira.id = jira_task_projects.jira_task_id
        WHERE jira_task_projects.project_id = ?
          AND jira.archived_at IS NULL
        ORDER BY jira.sort_order, jira.created_at, jira.id
      `).all(task.projectId).map(taskRelationSummaryFromRow);
      return {
        jira: null,
        projects: [],
        issues: [],
        availableIssues: [],
        availableJira,
        simpleStart: null,
        plan: null,
        lifecycle: null,
        autoCompletion: null,
        conversationArchive: null,
      };
    }
    const projects = this.database.prepare(`
      SELECT projects.*
      FROM jira_task_projects
      JOIN projects ON projects.id = jira_task_projects.project_id
      WHERE jira_task_projects.jira_task_id = ?
      ORDER BY projects.name, projects.id
    `).all(jiraTask.id).map(projectFromRow);
    const issues = this.database.prepare(`
      SELECT tasks.*
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id
    `).all(jiraTask.id).map(taskRelationSummaryFromRow);
    const availableIssues = task.source === "jira"
      ? this.database.prepare(`
        SELECT tasks.*
        FROM tasks
        JOIN jira_task_projects ON jira_task_projects.project_id = tasks.project_id
        LEFT JOIN jira_task_links ON jira_task_links.task_id = tasks.id
        WHERE jira_task_projects.jira_task_id = ?
          AND tasks.external_source IS NOT 'jira'
          AND tasks.archived_at IS NULL
          AND jira_task_links.task_id IS NULL
        ORDER BY tasks.project_id, tasks.status, tasks.sort_order, tasks.created_at, tasks.id
      `).all(jiraTask.id).map(taskRelationSummaryFromRow)
      : [];
    return {
      jira: jiraTask,
      projects,
      issues,
      availableIssues,
      availableJira: [],
      simpleStart: this.getJiraSimpleStartOperation(jiraTask.id),
      plan: this.getJiraPlan(jiraTask.id),
      lifecycle: this.getJiraLifecycle(jiraTask.id),
      autoCompletion: this.getJiraAutoCompletion(jiraTask.id),
      conversationArchive: this.getJiraConversationArchive(jiraTask.id),
    };
  }

  getJiraConversationArchive(jiraTaskId) {
    const jira = this.#requireTask(jiraTaskId);
    if (jira.source !== "jira") {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Conversation archive requires a Jira task");
    }
    const issueCounts = this.database.prepare(`
      SELECT
        COUNT(*) AS linked_issue_count,
        COALESCE(SUM(CASE WHEN issues.archived_at IS NOT NULL OR issues.status != 'done' THEN 1 ELSE 0 END), 0)
          AS blocked_issue_count
      FROM jira_task_links AS links
      JOIN tasks AS issues ON issues.id = links.task_id
      WHERE links.jira_task_id = ?
    `).get(jiraTaskId);
    const threadCounts = this.database.prepare(`
      WITH related_threads(id) AS (
        SELECT thread_id FROM jira_plan_threads WHERE jira_task_id = ?
        UNION
        SELECT items.thread_id
        FROM jira_simple_start_operations AS operations
        JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
        WHERE operations.jira_task_id = ?
        UNION
        SELECT queue.thread_id
        FROM jira_task_links AS links
        JOIN issue_claim_queue AS queue ON queue.task_id = links.task_id
        WHERE links.jira_task_id = ? AND queue.thread_id IS NOT NULL
        UNION
        SELECT attempts.thread_id
        FROM jira_task_links AS links
        JOIN issue_claim_attempts AS attempts ON attempts.task_id = links.task_id
        WHERE links.jira_task_id = ?
        UNION
        SELECT thread_id FROM jira_rework_items WHERE jira_task_id = ?
      )
      SELECT
        COUNT(*) AS related_thread_count,
        COALESCE(SUM(CASE WHEN threads.archived_at IS NULL THEN 1 ELSE 0 END), 0)
          AS unarchived_thread_count
      FROM related_threads
      JOIN ai_chat_threads AS threads ON threads.id = related_threads.id
    `).get(...Array(5).fill(jiraTaskId));
    const linkedIssueCount = Number(issueCounts.linked_issue_count);
    const blockedIssueCount = Number(issueCounts.blocked_issue_count);
    const relatedThreadCount = Number(threadCounts.related_thread_count);
    const unarchivedThreadCount = Number(threadCounts.unarchived_thread_count);
    const reason = jira.status !== "done"
      ? "jira_not_done"
      : linkedIssueCount === 0
        ? "no_linked_issues"
        : blockedIssueCount > 0
          ? "linked_issues_incomplete"
          : relatedThreadCount === 0
            ? "no_related_conversations"
            : unarchivedThreadCount === 0
              ? "already_archived"
              : null;
    return {
      eligible: reason === null,
      reason,
      relatedThreadCount,
      unarchivedThreadCount,
    };
  }

  archiveJiraConversations(jiraTaskId, version) {
    const jira = this.#requireTask(jiraTaskId);
    this.#requireVersion(jira, version);
    if (jira.source !== "jira") {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Conversation archive requires a Jira task");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getJiraConversationArchive(jiraTaskId);
      if (!state.eligible) {
        throw new ApiError(
          409,
          "JIRA_CONVERSATION_ARCHIVE_UNAVAILABLE",
          `Jira conversations cannot be archived: ${state.reason}`,
          { reason: state.reason },
        );
      }
      this.#archiveCompletedJiraThreads(timestamp, jiraTaskId, true);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTaskId);
  }

  getJiraAutoCompletion(jiraTaskId) {
    const row = this.database.prepare(`
      SELECT * FROM jira_auto_completions WHERE jira_task_id = ?
    `).get(jiraTaskId);
    if (!row) return null;
    return {
      state: row.state,
      expectedUpdatedAt: row.expected_updated_at,
      remoteUpdatedAt: row.remote_updated_at,
      remoteStatus: row.remote_status,
      remoteTaskStatus: row.remote_task_status,
      attemptCount: row.attempt_count,
      availableAt: row.available_at,
      error: row.error_message
        ? { code: row.error_code ?? "JIRA_AUTO_COMPLETE_FAILED", message: row.error_message }
        : null,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    };
  }

  queueEligibleJiraAutoCompletion(taskId) {
    if (!this.getJiraSettings().autoCompleteEnabled) return null;
    const linkedJira = this.database.prepare(`
      SELECT jira.id
      FROM jira_task_links AS link
      JOIN tasks AS jira ON jira.id = link.jira_task_id
      WHERE link.task_id = ?
      LIMIT 1
    `).get(taskId);
    if (!linkedJira) return null;
    return this.reconcileJiraAutoCompletion(linkedJira.id);
  }

  reconcileJiraAutoCompletion(jiraTaskId) {
    if (!this.getJiraSettings().autoCompleteEnabled) {
      this.dismissPendingJiraAutoCompletion(jiraTaskId);
      return null;
    }
    const jira = this.database.prepare(`
      SELECT jira.id, jira.external_updated_at
      FROM tasks AS jira
      WHERE jira.id = ?
        AND jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
    `).get(jiraTaskId);
    if (!jira) {
      this.dismissPendingJiraAutoCompletion(jiraTaskId);
      return null;
    }
    this.#queueJiraAutoCompletion(jira);
    return jira.id;
  }

  queueEligibleJiraAutoCompletions() {
    if (!this.getJiraSettings().autoCompleteEnabled) return [];
    const candidates = this.database.prepare(`
      SELECT jira.id, jira.external_updated_at
      FROM tasks AS jira
      WHERE jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      ORDER BY jira.sort_order, jira.created_at, jira.id
    `).all();
    for (const jira of candidates) this.#queueJiraAutoCompletion(jira);
    return candidates.map((jira) => jira.id);
  }

  #queueJiraAutoCompletion(jira) {
    const timestamp = now();
    const changed = this.database.prepare(`
      INSERT INTO jira_auto_completions (
        jira_task_id, state, expected_updated_at, attempt_count, available_at, updated_at
      ) VALUES (?, 'queued', ?, 0, ?, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        state = 'queued',
        expected_updated_at = excluded.expected_updated_at,
        remote_updated_at = NULL,
        remote_status = NULL,
        remote_task_status = NULL,
        attempt_count = 0,
        available_at = excluded.available_at,
        error_code = NULL,
        error_message = NULL,
        completed_at = NULL,
        updated_at = excluded.updated_at
      WHERE jira_auto_completions.state = 'dismissed'
    `).run(jira.id, jira.external_updated_at, timestamp, timestamp);
    if (changed.changes === 1) this.#touchJiraAutoCompletionTask(jira.id, timestamp);
  }

  dismissPendingJiraAutoCompletion(jiraTaskId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = 'dismissed', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE jira_task_id = ? AND state IN ('queued', 'retry_wait')
    `).run(timestamp, jiraTaskId);
    if (result.changes === 1) this.#touchJiraAutoCompletionTask(jiraTaskId, timestamp);
  }

  queueJiraAutoCompletionRetry(jiraTaskId) {
    if (!this.getJiraSettings().autoCompleteEnabled) {
      throw new ApiError(409, "JIRA_AUTO_COMPLETE_DISABLED", "Enable Jira automatic completion before retrying");
    }
    const jira = this.#requireTask(jiraTaskId);
    if (jira.source !== "jira") {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Only Jira issues can retry automatic completion");
    }
    const current = this.getJiraAutoCompletion(jira.id);
    if (!current || !["conflict", "failed", "dismissed"].includes(current.state)) {
      throw new ApiError(409, "JIRA_AUTO_COMPLETE_NOT_RETRYABLE", "Jira automatic completion is not waiting for retry");
    }
    const eligible = this.database.prepare(`
      SELECT 1
      FROM jira_task_links
      WHERE jira_task_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = ?
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      LIMIT 1
    `).get(jira.id, jira.id);
    if (!eligible) {
      this.dismissPendingJiraAutoCompletion(jira.id);
      throw new ApiError(
        409,
        "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE",
        "Every linked issue must still be done before retrying Jira completion",
      );
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = 'queued',
          expected_updated_at = COALESCE(remote_updated_at, ?),
          attempt_count = 0,
          available_at = ?,
          error_code = NULL,
          error_message = NULL,
          completed_at = NULL,
          updated_at = ?
      WHERE jira_task_id = ?
    `).run(jira.externalUpdatedAt, timestamp, timestamp, jira.id);
    this.#touchJiraAutoCompletionTask(jira.id, timestamp);
    return this.getJiraAutoCompletion(jira.id);
  }

  dismissJiraAutoCompletionConflict(jiraTaskId) {
    const current = this.getJiraAutoCompletion(jiraTaskId);
    if (!current || current.state !== "conflict") {
      throw new ApiError(409, "JIRA_AUTO_COMPLETE_NOT_CONFLICTED", "Jira automatic completion has no remote conflict to accept");
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = 'dismissed', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE jira_task_id = ?
    `).run(timestamp, jiraTaskId);
    this.#touchJiraAutoCompletionTask(jiraTaskId, timestamp);
    return this.getJiraContext(jiraTaskId);
  }

  takeNextJiraAutoCompletion() {
    const timestamp = now();
    const row = this.database.prepare(`
      SELECT completion.jira_task_id
      FROM jira_auto_completions AS completion
      JOIN tasks AS jira ON jira.id = completion.jira_task_id
      WHERE completion.state IN ('queued', 'retry_wait')
        AND completion.available_at <= ?
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
      ORDER BY completion.available_at, completion.updated_at, completion.jira_task_id
      LIMIT 1
    `).get(timestamp);
    if (!row) return null;
    const changed = this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
      WHERE jira_task_id = ? AND state IN ('queued', 'retry_wait')
    `).run(timestamp, row.jira_task_id);
    if (changed.changes !== 1) return null;
    this.#touchJiraAutoCompletionTask(row.jira_task_id, timestamp);
    const jira = this.getTask(row.jira_task_id);
    return jira ? { jira, completion: this.getJiraAutoCompletion(jira.id) } : null;
  }

  isJiraAutoCompletionEligible(jiraTaskId) {
    if (!this.getJiraSettings().autoCompleteEnabled) return false;
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM tasks AS jira
      WHERE jira.id = ?
        AND jira.external_source = 'jira'
        AND jira.archived_at IS NULL
        AND jira.status NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM jira_lifecycles
          WHERE jira_task_id = jira.id AND (pending_kind IS NOT NULL OR is_duplicate = 1)
        )
        AND EXISTS (SELECT 1 FROM jira_task_links WHERE jira_task_id = jira.id)
        AND NOT EXISTS (
          SELECT 1
          FROM jira_task_links AS candidate_link
          JOIN tasks AS candidate ON candidate.id = candidate_link.task_id
          WHERE candidate_link.jira_task_id = jira.id
            AND (candidate.archived_at IS NOT NULL OR candidate.status != 'done')
        )
    `).get(jiraTaskId));
  }

  finishJiraAutoCompletion(jiraTaskId, result) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE tasks
        SET status = 'done', external_status = ?, external_updated_at = ?, external_synced_at = ?,
            external_sync_error = NULL, archived_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(result.statusName, result.updatedAt, timestamp, timestamp, jiraTaskId);
      this.database.prepare(`
        UPDATE jira_auto_completions
        SET state = 'completed', remote_updated_at = ?, remote_status = ?, remote_task_status = 'done',
            error_code = NULL, error_message = NULL, completed_at = ?, updated_at = ?
        WHERE jira_task_id = ?
      `).run(result.updatedAt, result.statusName, timestamp, timestamp, jiraTaskId);
      this.#archiveCompletedJiraThreads(timestamp, jiraTaskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTaskId);
  }

  failJiraAutoCompletion(jiraTaskId, error, { retryAt = null, remote = null } = {}) {
    const timestamp = now();
    const state = error.code === "JIRA_AUTO_COMPLETE_CONFLICT"
      ? "conflict"
      : error.code === "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE" ? "dismissed"
      : retryAt ? "retry_wait" : "failed";
    this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = ?, available_at = COALESCE(?, available_at), remote_updated_at = ?,
          remote_status = ?, remote_task_status = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE jira_task_id = ?
    `).run(
      state,
      retryAt,
      remote?.updatedAt ?? null,
      remote?.statusName ?? null,
      remote?.taskStatus ?? null,
      state === "dismissed" ? null : String(error.code ?? "JIRA_AUTO_COMPLETE_FAILED").slice(0, 120),
      state === "dismissed" ? null : String(error.message ?? error).slice(0, 1000),
      timestamp,
      jiraTaskId,
    );
    this.#touchJiraAutoCompletionTask(jiraTaskId, timestamp);
    return this.getJiraAutoCompletion(jiraTaskId);
  }

  recoverJiraAutoCompletions() {
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_auto_completions
      SET state = 'queued', available_at = ?, updated_at = ?
      WHERE state = 'running'
    `).run(timestamp, timestamp);
  }

  #touchJiraAutoCompletionTask(jiraTaskId, timestamp) {
    this.database.prepare(`
      UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?
    `).run(timestamp, jiraTaskId);
  }

  getJiraLifecycle(jiraTaskId) {
    const row = this.database.prepare(`
      SELECT * FROM jira_lifecycles WHERE jira_task_id = ?
    `).get(jiraTaskId);
    if (!row) {
      return {
        pending: null,
        pausedIssueIds: [],
        reopened: false,
        duplicateOf: null,
        version: 0,
      };
    }
    return {
      pending: row.pending_kind
        ? {
          kind: row.pending_kind,
          fromStatus: row.pending_from_status,
          toStatus: row.pending_to_status,
          suggestedAction: row.pending_kind === "reopened"
            ? "rework"
            : row.pending_kind === "duplicate"
              ? "migrate"
              : "pause",
          createdAt: row.pending_created_at,
        }
        : null,
      pausedIssueIds: JSON.parse(row.paused_task_ids),
      reopened: Boolean(row.reopened),
      duplicateOf: row.is_duplicate
        ? {
          externalKey: row.duplicate_of_key,
          jiraTaskId: row.duplicate_task_id,
          accessible: row.duplicate_task_id !== null,
        }
        : null,
      version: row.version,
    };
  }

  resolveJiraLifecycle(jiraTaskId, version, action, pauseTargets = null) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id, null, pauseTargets);
    if (jiraTask.source !== "jira") {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Only Jira issues have lifecycle decisions");
    }
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (!lifecycle.pending) {
      throw new ApiError(409, "JIRA_LIFECYCLE_NOT_PENDING", "This Jira issue has no pending lifecycle decision");
    }
    if (lifecycle.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since it was read");
    }
    if (lifecycle.pending.kind === "reopened") {
      throw new ApiError(409, "JIRA_REOPENED_ACTION_REQUIRED", "Choose rework or planning for a reopened Jira issue");
    }
    if (lifecycle.pending.kind === "duplicate" && action !== "keep" && action !== "migrate") {
      throw new ApiError(409, "JIRA_DUPLICATE_ACTION_REQUIRED", "Choose whether to migrate duplicate Jira links");
    }
    if (lifecycle.pending.kind !== "duplicate" && action !== "pause" && action !== "keep") {
      throw new ApiError(409, "JIRA_LIFECYCLE_ACTION_INVALID", "This action does not match the pending decision");
    }
    const activePause = this.#jiraPauseResolutions.get(jiraTask.id);
    if (activePause && (action !== "pause" || activePause !== pauseTargets)) {
      throw new ApiError(409, "JIRA_PAUSE_IN_PROGRESS", "This Jira lifecycle pause is already being applied");
    }

    const timestamp = now();
    const affectedTaskIds = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (action === "migrate") {
        if (!lifecycle.duplicateOf?.jiraTaskId) {
          throw new ApiError(
            409,
            "JIRA_DUPLICATE_CANONICAL_UNAVAILABLE",
            "The canonical Jira issue is not accessible; existing links were preserved",
          );
        }
        const linked = this.database.prepare(`
          SELECT task_id FROM jira_task_links WHERE jira_task_id = ?
        `).all(jiraTask.id);
        this.database.prepare(`
          INSERT OR IGNORE INTO jira_task_projects (jira_task_id, project_id, created_at)
          SELECT ?, project_id, ? FROM jira_task_projects WHERE jira_task_id = ?
        `).run(lifecycle.duplicateOf.jiraTaskId, timestamp, jiraTask.id);
        this.database.prepare(`
          UPDATE jira_task_links SET jira_task_id = ? WHERE jira_task_id = ?
        `).run(lifecycle.duplicateOf.jiraTaskId, jiraTask.id);
        this.database.prepare("DELETE FROM jira_task_projects WHERE jira_task_id = ?").run(jiraTask.id);
        this.database.prepare(`
          UPDATE tasks SET version = version + 1, updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, jiraTask.id, lifecycle.duplicateOf.jiraTaskId);
        affectedTaskIds.push(...linked.map((link) => link.task_id));
      } else if (action === "pause") {
        const linked = this.#jiraPauseTargets(jiraTask.id);
        if (
          pauseTargets
          && JSON.stringify(linked.map(({ id, status }) => ({ id, status })))
            !== JSON.stringify(pauseTargets.map(({ id, status }) => ({ id, status })))
        ) {
          throw new ApiError(
            409,
            "JIRA_PAUSE_TARGETS_CHANGED",
            "Linked issues changed while pause was being prepared; review and try again",
          );
        }
        const update = this.database.prepare(`
          UPDATE tasks
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ?
        `);
        for (const task of linked) {
          const status = task.status === "todo" ? "backlog" : "blocked";
          if (update.run(status, timestamp, task.id, task.status).changes === 1) {
            affectedTaskIds.push(task.id);
          }
        }
      }
      const resolved = this.database.prepare(`
        UPDATE jira_lifecycles
        SET pending_kind = NULL,
            pending_from_status = NULL,
            pending_to_status = NULL,
            pending_created_at = NULL,
            paused_task_ids = ?,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ? AND version = ?
      `).run(
        JSON.stringify(action === "pause" ? affectedTaskIds : lifecycle.pausedIssueIds),
        timestamp,
        jiraTask.id,
        version,
      );
      if (resolved.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed while the decision was applied");
      }
      if (lifecycle.pending.kind === "ended") {
        this.database.prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND archived_at IS NULL
        `).run(timestamp, timestamp, jiraTask.id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { context: this.getJiraContext(jiraTask.id), affectedTaskIds };
  }

  beginJiraLifecyclePause(jiraTaskId, version) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id);
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (jiraTask.source !== "jira" || lifecycle.pending?.suggestedAction !== "pause") {
      throw new ApiError(409, "JIRA_PAUSE_UNAVAILABLE", "This Jira issue is not waiting for pause confirmation");
    }
    if (lifecycle.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since it was read");
    }
    if (this.#jiraPauseResolutions.has(jiraTask.id)) {
      throw new ApiError(409, "JIRA_PAUSE_IN_PROGRESS", "This Jira lifecycle pause is already being applied");
    }
    const targets = this.#jiraPauseTargets(jiraTask.id).map((task) => this.getTask(task.id));
    this.#jiraPauseResolutions.set(jiraTask.id, targets);
    return targets;
  }

  finishJiraLifecyclePause(jiraTaskId, targets) {
    if (this.#jiraPauseResolutions.get(jiraTaskId) === targets) {
      this.#jiraPauseResolutions.delete(jiraTaskId);
    }
  }

  beginJiraReopenAction(jiraTaskId, version, action) {
    const jiraTask = this.#requireTask(jiraTaskId);
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (jiraTask.source !== "jira" || lifecycle.pending?.kind !== "reopened") {
      throw new ApiError(409, "JIRA_REOPEN_ACTION_UNAVAILABLE", "This Jira issue is not waiting for a reopened action");
    }
    if (lifecycle.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since it was read");
    }
    this.#assertJiraMutationUnlocked(jiraTask.id);
    const reservation = { action };
    this.#jiraReopenActions.set(jiraTask.id, reservation);
    return reservation;
  }

  finishJiraReopenAction(jiraTaskId, reservation) {
    if (this.#jiraReopenActions.get(jiraTaskId) === reservation) {
      this.#jiraReopenActions.delete(jiraTaskId);
    }
  }

  beginJiraRework(jiraTaskId, version, reservation) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id, reservation);
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (lifecycle.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since it was read");
    }
    if (lifecycle.pending?.kind !== "reopened") {
      throw new ApiError(409, "JIRA_REWORK_UNAVAILABLE", "Rework is only available for a reopened Jira issue");
    }
    const projects = this.database.prepare(`
      SELECT project_id
      FROM jira_task_projects
      WHERE jira_task_id = ?
      UNION
      SELECT tasks.project_id
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
      ORDER BY project_id
    `).all(jiraTask.id, jiraTask.id);
    if (projects.length === 0) {
      throw new ApiError(409, "JIRA_REWORK_PROJECT_REQUIRED", "Link a repository before creating rework");
    }
    const timestamp = now();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO jira_rework_items (
        jira_task_id, cycle, project_id, task_id, thread_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const project of projects) {
      insert.run(jiraTask.id, version, project.project_id, randomUUID(), randomUUID(), timestamp);
    }
    return {
      jira: jiraTask,
      items: this.database.prepare(`
        SELECT project_id AS projectId, task_id AS taskId, thread_id AS threadId
        FROM jira_rework_items
        WHERE jira_task_id = ? AND cycle = ?
        ORDER BY project_id
      `).all(jiraTask.id, version),
    };
  }

  beginJiraReplan(jiraTaskId, version, reservation) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id, reservation);
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (lifecycle.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since it was read");
    }
    if (lifecycle.pending?.kind !== "reopened" || !this.getJiraPlan(jiraTask.id)) {
      throw new ApiError(409, "JIRA_REPLAN_UNAVAILABLE", "Planning again requires a reopened planned Jira issue");
    }
    return this.getJiraContext(jiraTask.id);
  }

  completeJiraReopen(jiraTaskId, version, reservation) {
    this.#assertJiraMutationUnlocked(jiraTaskId, reservation);
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE jira_lifecycles
      SET pending_kind = NULL,
          pending_from_status = NULL,
          pending_to_status = NULL,
          pending_created_at = NULL,
          reopened = 0,
          version = version + 1,
          updated_at = ?
      WHERE jira_task_id = ? AND version = ? AND pending_kind = 'reopened'
    `).run(timestamp, jiraTaskId, version);
    if (result.changes !== 1) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since rework started");
    }
    return this.getJiraContext(jiraTaskId);
  }

  completeJiraReplan(jiraTaskId, taskVersion, lifecycleVersion, planVersion, threadId, reservation) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id, reservation);
    this.#requireVersion(jiraTask, taskVersion);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.database.prepare(`
        UPDATE jira_plans
        SET thread_id = ?, status = 'planning', source_snapshot = ?, prompted_at = ?,
            version = version + 1, updated_at = ?
        WHERE jira_task_id = ? AND version = ?
      `).run(
        threadId,
        this.#jiraPlanSourceSnapshot(jiraTask),
        timestamp,
        timestamp,
        jiraTask.id,
        planVersion,
      );
      if (plan.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", "Jira plan changed since replanning started");
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)
      `).run(jiraTask.id, threadId, timestamp);
      const lifecycle = this.database.prepare(`
        UPDATE jira_lifecycles
        SET pending_kind = NULL,
            pending_from_status = NULL,
            pending_to_status = NULL,
            pending_created_at = NULL,
            reopened = 0,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ? AND version = ? AND pending_kind = 'reopened'
      `).run(timestamp, jiraTask.id, lifecycleVersion);
      if (lifecycle.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", "Jira lifecycle changed since replanning started");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTask.id);
  }

  #syncJiraLifecycle(existing, nextStatus, timestamp) {
    const lifecycle = this.getJiraLifecycle(existing.id);
    const currentTerminal = existing.status === "done" || existing.status === "canceled";
    const nextTerminal = nextStatus === "done" || nextStatus === "canceled";
    const linkedUnfinished = Boolean(this.database.prepare(`
      SELECT 1
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status NOT IN ('done', 'canceled')
      LIMIT 1
    `).get(existing.id));

    if (existing.status !== nextStatus && currentTerminal && !nextTerminal) {
      this.#setJiraLifecyclePending(existing.id, "reopened", existing.status, nextStatus, timestamp, true);
      return;
    }

    if (nextStatus === "in_progress") {
      if (lifecycle.reopened) return;
      const plan = this.getJiraPlan(existing.id);
      const remainingPausedIds = plan?.needsReview
        ? lifecycle.pausedIssueIds
        : this.#releaseJiraFrontier(existing.id, lifecycle.pausedIssueIds, timestamp);
      if (lifecycle.version > 0 && (
        lifecycle.pending
        || JSON.stringify(remainingPausedIds) !== JSON.stringify(lifecycle.pausedIssueIds)
      )) {
        this.database.prepare(`
          UPDATE jira_lifecycles
          SET pending_kind = NULL,
              pending_from_status = NULL,
              pending_to_status = NULL,
              pending_created_at = NULL,
              paused_task_ids = ?,
              version = version + 1,
              updated_at = ?
          WHERE jira_task_id = ?
        `).run(JSON.stringify(remainingPausedIds), timestamp, existing.id);
      }
      return;
    }

    if (existing.status === nextStatus || !linkedUnfinished) return;
    if (nextTerminal) {
      this.#setJiraLifecyclePending(existing.id, "ended", existing.status, nextStatus, timestamp);
      return;
    }
    if (
      (nextStatus === "todo" || nextStatus === "backlog")
      && !["todo", "backlog"].includes(existing.status)
    ) {
      this.#setJiraLifecyclePending(existing.id, "waiting", existing.status, nextStatus, timestamp);
    }
  }

  #jiraPauseTargets(jiraTaskId) {
    return this.database.prepare(`
      SELECT tasks.id, tasks.status, tasks.version
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status IN ('todo', 'in_progress')
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id
    `).all(jiraTaskId);
  }

  #syncJiraDuplicate(jiraTask, duplicateOf, timestamp) {
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (!duplicateOf) {
      if (!lifecycle.duplicateOf) return;
      this.database.prepare(`
        UPDATE jira_lifecycles
        SET is_duplicate = 0,
            duplicate_of_key = NULL,
            duplicate_task_id = NULL,
            pending_kind = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_kind END,
            pending_from_status = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_from_status END,
            pending_to_status = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_to_status END,
            pending_created_at = CASE WHEN pending_kind = 'duplicate' THEN NULL ELSE pending_created_at END,
            version = version + 1,
            updated_at = ?
        WHERE jira_task_id = ?
      `).run(timestamp, jiraTask.id);
      return;
    }

    const canonical = duplicateOf.accessible && duplicateOf.externalKey
      ? this.database.prepare(`
        SELECT id
        FROM tasks
        WHERE external_source = 'jira'
          AND external_origin = ?
          AND external_key = ?
          AND external_sync_error IS NULL
        LIMIT 1
      `).get(jiraTask.external_origin, duplicateOf.externalKey)
      : null;
    const pendingKind = this.#jiraDuplicateNeedsDecision(jiraTask.id, duplicateOf, lifecycle)
      ? "duplicate"
      : lifecycle.pending?.kind ?? null;
    if (
      lifecycle.duplicateOf?.externalKey === (duplicateOf.externalKey ?? null)
      && lifecycle.duplicateOf?.jiraTaskId === (canonical?.id ?? null)
      && lifecycle.pending?.kind === pendingKind
    ) return;
    this.database.prepare(`
      INSERT INTO jira_lifecycles (
        jira_task_id, pending_kind, pending_from_status, pending_to_status,
        pending_created_at, paused_task_ids, reopened, is_duplicate,
        duplicate_of_key, duplicate_task_id, version, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, '[]', 0, 1, ?, ?, 1, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        pending_kind = excluded.pending_kind,
        pending_from_status = CASE WHEN excluded.pending_kind = 'duplicate' THEN NULL ELSE jira_lifecycles.pending_from_status END,
        pending_to_status = CASE WHEN excluded.pending_kind = 'duplicate' THEN NULL ELSE jira_lifecycles.pending_to_status END,
        pending_created_at = CASE WHEN excluded.pending_kind = 'duplicate' THEN excluded.pending_created_at ELSE jira_lifecycles.pending_created_at END,
        is_duplicate = 1,
        duplicate_of_key = excluded.duplicate_of_key,
        duplicate_task_id = excluded.duplicate_task_id,
        version = jira_lifecycles.version + 1,
        updated_at = excluded.updated_at
    `).run(
      jiraTask.id,
      pendingKind,
      pendingKind === "duplicate" ? timestamp : null,
      duplicateOf.externalKey ?? null,
      canonical?.id ?? null,
      timestamp,
    );
  }

  #jiraDuplicateNeedsDecision(jiraTaskId, duplicateOf, lifecycle = this.getJiraLifecycle(jiraTaskId)) {
    if (!duplicateOf) return false;
    const hasLinks = Boolean(this.database.prepare(`
      SELECT 1 FROM jira_task_links WHERE jira_task_id = ? LIMIT 1
    `).get(jiraTaskId));
    return hasLinks && (
      lifecycle.pending?.kind === "duplicate"
      || lifecycle.duplicateOf?.externalKey !== (duplicateOf.externalKey ?? null)
    );
  }

  #setJiraLifecyclePending(jiraTaskId, kind, fromStatus, toStatus, timestamp, reopened = false) {
    this.database.prepare(`
      INSERT INTO jira_lifecycles (
        jira_task_id, pending_kind, pending_from_status, pending_to_status,
        pending_created_at, paused_task_ids, reopened, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, 1, ?)
      ON CONFLICT(jira_task_id) DO UPDATE SET
        pending_kind = excluded.pending_kind,
        pending_from_status = excluded.pending_from_status,
        pending_to_status = excluded.pending_to_status,
        pending_created_at = excluded.pending_created_at,
        reopened = MAX(jira_lifecycles.reopened, excluded.reopened),
        version = jira_lifecycles.version + 1,
        updated_at = excluded.updated_at
    `).run(jiraTaskId, kind, fromStatus, toStatus, timestamp, reopened ? 1 : 0, timestamp);
  }

  #releaseJiraFrontier(jiraTaskId, pausedTaskIds, timestamp) {
    const paused = new Set(pausedTaskIds);
    const linked = this.database.prepare(`
      SELECT tasks.id, tasks.status
      FROM jira_task_links
      JOIN tasks ON tasks.id = jira_task_links.task_id
      WHERE jira_task_links.jira_task_id = ?
        AND tasks.archived_at IS NULL
        AND tasks.status IN ('backlog', 'blocked')
      ORDER BY tasks.project_id, tasks.sort_order, tasks.created_at, tasks.id
    `).all(jiraTaskId);
    const blocked = this.database.prepare(`
      SELECT 1
      FROM task_relations
      JOIN tasks AS prerequisite ON prerequisite.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
        AND prerequisite.status NOT IN ('done', 'canceled')
      LIMIT 1
    `);
    const release = this.database.prepare(`
      UPDATE tasks
      SET status = 'todo', version = version + 1, updated_at = ?
      WHERE id = ? AND status = ?
    `);
    for (const task of linked) {
      if (task.status === "blocked" && !paused.has(task.id)) continue;
      if (blocked.get(task.id)) continue;
      release.run(timestamp, task.id, task.status);
      paused.delete(task.id);
    }
    for (const taskId of [...paused]) {
      const task = this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
      if (!task || task.status !== "blocked") paused.delete(taskId);
    }
    return [...paused];
  }

  #jiraPlanSourceSnapshot(jiraTask) {
    const projectIds = this.database.prepare(`
      SELECT project_id
      FROM jira_task_projects
      WHERE jira_task_id = ?
      ORDER BY project_id
    `).all(jiraTask.id).map((row) => row.project_id);
    return JSON.stringify({
      title: jiraTask.title,
      description: jiraTask.description,
      priority: jiraTask.priority,
      labels: [...jiraTask.labels].sort(),
      projectIds,
    });
  }

  listJiraPlanItems(jiraTaskId, publication) {
    if (!publication) return [];
    const taskStatement = this.database.prepare("SELECT * FROM tasks WHERE id = ?");
    return this.database.prepare(`
      SELECT *
      FROM jira_plan_items
      WHERE jira_task_id = ? AND publication = ?
      ORDER BY rowid
    `).all(jiraTaskId, publication).map((row) => {
      const item = jiraPlanItemFromRow(row);
      const task = taskStatement.get(item.taskId);
      return {
        ...item,
        task: task ? taskRelationSummaryFromRow(task) : null,
      };
    });
  }

  getJiraPlan(jiraTaskId) {
    const row = this.database.prepare(`
      SELECT * FROM jira_plans WHERE jira_task_id = ?
    `).get(jiraTaskId);
    if (!row) return null;
    const jiraTask = this.#requireTask(jiraTaskId);
    return {
      threadId: row.thread_id,
      status: row.status,
      spec: row.spec,
      needsReview: row.source_snapshot !== this.#jiraPlanSourceSnapshot(jiraTask)
        || (row.publication > 0 && row.status !== "published"),
      promptedAt: row.prompted_at,
      publication: row.publication,
      version: row.version,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: this.listJiraPlanItems(jiraTaskId, row.publication),
    };
  }

  beginJiraPlanning(jiraTaskId, taskVersion, threadId) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id);
    this.#requireVersion(jiraTask, taskVersion);
    if (jiraTask.source !== "jira" || jiraTask.archivedAt !== null) {
      throw new ApiError(409, "JIRA_PLANNING_UNAVAILABLE", "Only active Jira issues can be planned");
    }
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (lifecycle.pending?.kind === "reopened") {
      throw new ApiError(409, "JIRA_REPLAN_REQUIRED", "Choose how to handle the reopened Jira issue first");
    }
    if (lifecycle.duplicateOf) {
      throw new ApiError(409, "JIRA_DUPLICATE", "Use the canonical Jira issue instead of planning a duplicate");
    }
    if (this.getJiraSimpleStartOperation(jiraTask.id)) {
      throw new ApiError(
        409,
        "JIRA_PLANNING_SIMPLE_START_CONFLICT",
        "This Jira issue already uses the simple execution flow",
      );
    }
    const existing = this.database.prepare(`
      SELECT * FROM jira_plans WHERE jira_task_id = ?
    `).get(jiraTask.id);
    const sourceSnapshot = this.#jiraPlanSourceSnapshot(jiraTask);
    const timestamp = now();
    if (!existing) {
      if (!threadId) {
        throw new ApiError(409, "JIRA_PLANNING_THREAD_REQUIRED", "Planning requires an AI conversation");
      }
      this.database.prepare(`
        INSERT INTO jira_plans (
          jira_task_id, thread_id, status, spec, source_snapshot, prompted_at,
          publication, version, published_at, created_at, updated_at
        ) VALUES (?, ?, 'planning', '', ?, NULL, 0, 1, NULL, ?, ?)
      `).run(jiraTask.id, threadId, sourceSnapshot, timestamp, timestamp);
      this.database.prepare(`
        INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)
      `).run(jiraTask.id, threadId, timestamp);
      return { plan: this.getJiraPlan(jiraTask.id), shouldPrompt: true };
    }
    const nextThreadId = threadId ?? existing.thread_id;
    if (!nextThreadId) {
      throw new ApiError(409, "JIRA_PLANNING_THREAD_REQUIRED", "Planning requires an AI conversation");
    }
    const shouldRefresh = existing.source_snapshot !== sourceSnapshot
      || existing.thread_id !== nextThreadId;
    if (shouldRefresh) {
      this.database.prepare(`
        UPDATE jira_plans
        SET thread_id = ?, status = 'planning', source_snapshot = ?, prompted_at = NULL,
            version = version + 1, updated_at = ?
        WHERE jira_task_id = ?
      `).run(nextThreadId, sourceSnapshot, timestamp, jiraTask.id);
      this.database.prepare(`
        INSERT OR IGNORE INTO jira_plan_threads (jira_task_id, thread_id, created_at)
        VALUES (?, ?, ?)
      `).run(jiraTask.id, nextThreadId, timestamp);
    }
    const plan = this.getJiraPlan(jiraTask.id);
    return { plan, shouldPrompt: shouldRefresh || plan.promptedAt === null };
  }

  markJiraPlanPrompted(jiraTaskId) {
    this.#assertJiraMutationUnlocked(jiraTaskId);
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_plans
      SET prompted_at = ?, version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND prompted_at IS NULL
    `).run(timestamp, timestamp, jiraTaskId);
    return this.getJiraPlan(jiraTaskId);
  }

  saveJiraPlanSpec(jiraTaskId, version, spec) {
    this.#assertJiraMutationUnlocked(jiraTaskId);
    const plan = this.database.prepare(`
      SELECT * FROM jira_plans WHERE jira_task_id = ?
    `).get(jiraTaskId);
    if (!plan) {
      throw new ApiError(404, "JIRA_PLAN_NOT_FOUND", "Start Jira planning before saving a spec");
    }
    if (plan.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira plan changed since it was read");
    }
    if (plan.status === "publishing") {
      throw new ApiError(409, "JIRA_PLAN_PUBLISHING", "Finish the current publication before editing the spec");
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_plans
      SET spec = ?, status = 'review', version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND version = ?
    `).run(spec, timestamp, jiraTaskId, version);
    return this.getJiraPlan(jiraTaskId);
  }

  beginJiraPlanPublish(jiraTaskId, version, items) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id);
    const plan = this.database.prepare(`
      SELECT * FROM jira_plans WHERE jira_task_id = ?
    `).get(jiraTaskId);
    if (!plan) {
      throw new ApiError(404, "JIRA_PLAN_NOT_FOUND", "Start Jira planning before publishing tickets");
    }
    if (plan.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira plan changed since it was read");
    }
    if (!plan.spec.trim()) {
      throw new ApiError(409, "JIRA_PLAN_SPEC_REQUIRED", "Save the Jira planning spec before publishing tickets");
    }
    if (plan.status !== "review" && plan.status !== "publishing") {
      throw new ApiError(409, "JIRA_PLAN_REVIEW_REQUIRED", "Save the reviewed Jira spec before publishing tickets");
    }
    if (plan.source_snapshot !== this.#jiraPlanSourceSnapshot(jiraTask)) {
      throw new ApiError(409, "JIRA_PLAN_REVIEW_REQUIRED", "Jira content or linked repositories changed; review the plan again");
    }
    const projectIds = new Set(this.database.prepare(`
      SELECT project_id FROM jira_task_projects WHERE jira_task_id = ?
    `).all(jiraTaskId).map((row) => row.project_id));
    if (projectIds.size === 0) {
      throw new ApiError(409, "JIRA_PLAN_PROJECT_REQUIRED", "Link at least one repository before publishing tickets");
    }
    const invalid = items.find((item) => !projectIds.has(item.projectId));
    if (invalid) {
      throw new ApiError(
        409,
        "JIRA_PLAN_PROJECT_INVALID",
        `Ticket '${invalid.key}' uses a repository that is not linked to Jira`,
      );
    }

    const comparable = (entries) => JSON.stringify(entries.map((item) => ({
      key: item.key,
      projectId: item.projectId,
      title: item.title,
      description: item.description,
      priority: item.priority,
      labels: item.labels,
      blockedBy: item.blockedBy,
    })));
    if (plan.status === "publishing") {
      const currentItems = this.listJiraPlanItems(jiraTaskId, plan.publication);
      if (comparable(currentItems) !== comparable(items)) {
        throw new ApiError(
          409,
          "JIRA_PLAN_PUBLISH_CONFLICT",
          "Retry the interrupted publication with the same ticket manifest",
        );
      }
      return {
        plan: this.getJiraPlan(jiraTaskId),
        items: currentItems,
        previousItems: this.listJiraPlanItems(jiraTaskId, plan.publication - 1),
      };
    }

    const publication = plan.publication + 1;
    const previousItems = this.listJiraPlanItems(jiraTaskId, plan.publication);
    const missingPreservedItem = previousItems.find((previous) => (
      previous.task
      && ["in_progress", "in_review", "blocked", "done"].includes(previous.task.status)
      && !items.some((item) => item.key === previous.key && item.projectId === previous.task.projectId)
    ));
    if (missingPreservedItem) {
      throw new ApiError(
        409,
        "JIRA_PLAN_PRESERVED_TASK_REQUIRED",
        `Keep started issue '${missingPreservedItem.task.identifier}' in the revised plan`,
      );
    }
    const previousByKey = new Map(previousItems.map((item) => [item.key, item]));
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare(`
        INSERT INTO jira_plan_items (
          jira_task_id, publication, item_key, project_id, task_id,
          title, description, priority, labels, blocked_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        const previous = previousByKey.get(item.key);
        const previousTask = previous
          ? this.database.prepare("SELECT * FROM tasks WHERE id = ? AND archived_at IS NULL").get(previous.taskId)
          : null;
        insert.run(
          jiraTaskId,
          publication,
          item.key,
          item.projectId,
          previousTask?.project_id === item.projectId ? previous.taskId : randomUUID(),
          item.title,
          item.description,
          item.priority,
          JSON.stringify(item.labels),
          JSON.stringify(item.blockedBy),
          timestamp,
        );
      }
      this.database.prepare(`
        UPDATE jira_plans
        SET status = 'publishing', publication = ?, version = version + 1, updated_at = ?
        WHERE jira_task_id = ? AND version = ?
      `).run(publication, timestamp, jiraTaskId, version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      plan: this.getJiraPlan(jiraTaskId),
      items: this.listJiraPlanItems(jiraTaskId, publication),
      previousItems,
    };
  }

  replaceJiraPlanBlocks(jiraTaskId, previousPublication, publication, nextEdges) {
    const previousRows = previousPublication > 0 ? this.database.prepare(`
      SELECT source_task_id, target_task_id, created_relation
      FROM jira_plan_edges
      WHERE jira_task_id = ? AND publication = ?
    `).all(jiraTaskId, previousPublication) : [];
    const previous = new Map(previousRows.map((row) => [
      `${row.source_task_id}\0${row.target_task_id}`,
      row.created_relation === 1,
    ]));
    const next = new Set(nextEdges.map(([sourceId, targetId]) => `${sourceId}\0${targetId}`));
    const remove = this.database.prepare(`
      DELETE FROM task_relations
      WHERE relation_type = 'blocks' AND source_task_id = ? AND target_task_id = ?
    `);
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('blocks', ?, ?, ?)
    `);
    const record = this.database.prepare(`
      INSERT INTO jira_plan_edges (
        jira_task_id, publication, source_task_id, target_task_id, created_relation
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const timestamp = now();
    const cancelableStatuses = new Set(["backlog", "todo", "canceled"]);
    const taskStatus = this.database.prepare("SELECT status FROM tasks WHERE id = ?");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const [edge, createdRelation] of previous) {
        if (next.has(edge) || !createdRelation) continue;
        const endpoints = edge.split("\0");
        if (endpoints.every((taskId) => cancelableStatuses.has(taskStatus.get(taskId)?.status))) {
          remove.run(...endpoints);
        }
      }
      for (const edge of next) {
        const endpoints = edge.split("\0");
        const inserted = insert.run(...endpoints, timestamp);
        record.run(
          jiraTaskId,
          publication,
          ...endpoints,
          previous.get(edge) === true || inserted.changes === 1 ? 1 : 0,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishJiraPlanPublish(jiraTaskId, publication) {
    this.#assertJiraMutationUnlocked(jiraTaskId);
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE jira_plans
      SET status = 'published', published_at = ?, version = version + 1, updated_at = ?
      WHERE jira_task_id = ? AND publication = ? AND status = 'publishing'
    `).run(timestamp, timestamp, jiraTaskId, publication);
    if (result.changes !== 1) {
      throw new ApiError(409, "JIRA_PLAN_PUBLISH_INACTIVE", "The Jira plan is not publishing");
    }
    return this.getJiraPlan(jiraTaskId);
  }

  assertIssueExecutionAllowed(taskId) {
    if (!taskId) return;
    const link = this.database.prepare(`
      SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
    `).get(taskId);
    if (link && this.getJiraLifecycle(link.jira_task_id).pending?.suggestedAction === "pause") {
      throw new ApiError(
        409,
        "JIRA_LIFECYCLE_PAUSE_PENDING",
        "Resolve the linked Jira lifecycle notice before starting or continuing this issue",
      );
    }
  }

  #assertJiraMutationUnlocked(taskId, reservation = null, pauseTargets = null) {
    for (const [jiraTaskId, active] of this.#jiraPauseResolutions) {
      if (active === pauseTargets) continue;
      const linked = jiraTaskId !== taskId && this.database.prepare(`
        SELECT 1 FROM jira_task_links WHERE jira_task_id = ? AND task_id = ?
      `).get(jiraTaskId, taskId);
      if (jiraTaskId === taskId || linked) {
        throw new ApiError(
          409,
          "JIRA_PAUSE_IN_PROGRESS",
          "This issue cannot change while its Jira lifecycle pause is being applied",
        );
      }
    }
    for (const [jiraTaskId, active] of this.#jiraReopenActions) {
      if (active === reservation) continue;
      const linked = jiraTaskId !== taskId && this.database.prepare(`
        SELECT 1 FROM jira_task_links WHERE jira_task_id = ? AND task_id = ?
      `).get(jiraTaskId, taskId);
      if (jiraTaskId === taskId || linked) {
        throw new ApiError(
          409,
          "JIRA_REOPEN_ACTION_IN_PROGRESS",
          "This issue cannot change while its reopened Jira action is being applied",
        );
      }
    }
  }

  #assertJiraPlanAllowsExecution(taskId, status) {
    if (status !== "in_progress") return;
    this.assertIssueExecutionAllowed(taskId);
    const link = this.database.prepare(`
      SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
    `).get(taskId);
    if (link && this.getJiraPlan(link.jira_task_id)?.needsReview) {
      throw new ApiError(
        409,
        "JIRA_PLAN_REVIEW_REQUIRED",
        "Review the changed Jira plan before starting this issue",
      );
    }
  }

  getJiraSimpleStartOperation(jiraTaskId) {
    const row = this.database.prepare(`
      SELECT
        operations.*,
        COUNT(items.project_id) AS project_count,
        SUM(CASE WHEN threads.id IS NOT NULL THEN 1 ELSE 0 END) AS ready_count
      FROM jira_simple_start_operations AS operations
      LEFT JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
      LEFT JOIN ai_chat_threads AS threads ON threads.id = items.thread_id
      WHERE operations.jira_task_id = ?
      GROUP BY operations.id
    `).get(jiraTaskId);
    return row ? jiraSimpleStartFromRow(row) : null;
  }

  listJiraSimpleStartItems(jiraTaskId) {
    return this.database.prepare(`
      SELECT items.project_id, items.task_id, items.thread_id
      FROM jira_simple_start_operations AS operations
      JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
      WHERE operations.jira_task_id = ?
      ORDER BY items.project_id
    `).all(jiraTaskId).map((row) => ({
      projectId: row.project_id,
      taskId: row.task_id,
      threadId: row.thread_id,
    }));
  }

  beginJiraSimpleStart(jiraTaskId, version) {
    const jiraTask = this.#requireTask(jiraTaskId);
    this.#assertJiraMutationUnlocked(jiraTask.id);
    const existing = this.getJiraSimpleStartOperation(jiraTask.id);
    if (existing) {
      return { jira: jiraTask, operation: existing, items: this.listJiraSimpleStartItems(jiraTask.id) };
    }
    if (this.getJiraPlan(jiraTask.id)) {
      throw new ApiError(
        409,
        "JIRA_SIMPLE_START_PLANNING_CONFLICT",
        "This Jira issue already uses the AI planning flow",
      );
    }
    this.#requireVersion(jiraTask, version);
    if (jiraTask.source !== "jira" || jiraTask.archivedAt !== null) {
      throw new ApiError(409, "JIRA_SIMPLE_START_UNAVAILABLE", "Only active Jira issues can be started");
    }
    const lifecycle = this.getJiraLifecycle(jiraTask.id);
    if (lifecycle.pending) {
      throw new ApiError(
        409,
        "JIRA_LIFECYCLE_PENDING",
        "Resolve the Jira lifecycle notice before starting this issue",
      );
    }
    if (lifecycle.duplicateOf) {
      throw new ApiError(409, "JIRA_DUPLICATE", "Use the canonical Jira issue instead of starting a duplicate");
    }
    if (jiraTask.status !== "todo") {
      throw new ApiError(409, "JIRA_SIMPLE_START_STATUS", "只有待认领的 Jira 可以创建并开始");
    }
    const context = this.getJiraContext(jiraTask.id);
    if (context.projects.length === 0) {
      throw new ApiError(409, "JIRA_SIMPLE_START_PROJECT_REQUIRED", "请先为 Jira 关联至少一个仓库");
    }
    const operationId = randomUUID();
    const timestamp = now();
    const items = context.projects.map((project) => {
      const linked = context.issues.filter((issue) => issue.projectId === project.id);
      if (linked.length > 1) {
        throw new ApiError(
          409,
          "JIRA_SIMPLE_START_PROJECT_CONFLICT",
          `仓库 ${project.name} 已关联多个执行 Issue，请先保留一个`,
        );
      }
      return {
        projectId: project.id,
        taskId: linked[0]?.id ?? randomUUID(),
        threadId: randomUUID(),
      };
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO jira_simple_start_operations (
          id, jira_task_id, status, transitioned_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'creating', NULL, NULL, ?, ?)
      `).run(operationId, jiraTask.id, timestamp, timestamp);
      const insertItem = this.database.prepare(`
        INSERT INTO jira_simple_start_items (
          operation_id, project_id, task_id, thread_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          operationId,
          item.projectId,
          item.taskId,
          item.threadId,
          timestamp,
          timestamp,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      jira: jiraTask,
      operation: this.getJiraSimpleStartOperation(jiraTask.id),
      items,
    };
  }

  markJiraSimpleStartTransitioned(operationId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE jira_simple_start_operations
      SET transitioned_at = COALESCE(transitioned_at, ?), updated_at = ?
      WHERE id = ? AND status = 'creating'
    `).run(timestamp, timestamp, operationId);
    if (result.changes !== 1) {
      throw new ApiError(409, "JIRA_SIMPLE_START_INACTIVE", "Jira 创建操作已经结束");
    }
  }

  completeJiraSimpleStart(operationId) {
    const operation = this.database.prepare(`
      SELECT id FROM jira_simple_start_operations WHERE id = ? AND status = 'creating'
    `).get(operationId);
    if (!operation) return;
    const pending = this.database.prepare(`
      SELECT 1
      FROM jira_simple_start_items AS items
      LEFT JOIN tasks ON tasks.id = items.task_id
      LEFT JOIN ai_chat_threads ON ai_chat_threads.id = items.thread_id
      WHERE items.operation_id = ?
        AND (tasks.id IS NULL OR ai_chat_threads.id IS NULL)
      LIMIT 1
    `).get(operationId);
    if (pending) {
      throw new ApiError(409, "JIRA_SIMPLE_START_INCOMPLETE", "仍有仓库未完成 Issue 或对话创建");
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE jira_simple_start_operations
      SET status = 'complete', completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, operationId);
  }

  setJiraProjects(id, version, projectIds, actor, workspaceProjectIds = new Set()) {
    const jiraTask = this.#requireTask(id);
    this.#requireVersion(jiraTask, version);
    this.#assertJiraMutationUnlocked(jiraTask.id);
    if (jiraTask.source !== "jira") {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Only Jira issues can link repositories");
    }
    const uniqueProjectIds = [...new Set(projectIds)];
    if (uniqueProjectIds.length > 0) {
      const placeholders = uniqueProjectIds.map(() => "?").join(", ");
      const projects = this.database.prepare(`
        SELECT id, workspace_path FROM projects
        WHERE id IN (${placeholders}) AND id != ?
      `).all(...uniqueProjectIds, JIRA_PROJECT_ID);
      if (
        projects.length !== uniqueProjectIds.length
        || projects.some((project) => (
          project.workspace_path === null && !workspaceProjectIds.has(project.id)
        ))
      ) {
        throw new ApiError(
          400,
          "JIRA_PROJECT_INVALID",
          "Jira can only link projects with a local workspace",
        );
      }
    }
    const currentProjectIds = this.database.prepare(`
      SELECT project_id FROM jira_task_projects
      WHERE jira_task_id = ? ORDER BY project_id
    `).all(jiraTask.id).map((row) => row.project_id);
    const nextProjectIds = [...uniqueProjectIds].sort();
    if (JSON.stringify(currentProjectIds) === JSON.stringify(nextProjectIds)) {
      return this.getJiraContext(jiraTask.id);
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const invalidLinkedIssue = this.database.prepare(`
        SELECT tasks.identifier
        FROM jira_task_links
        JOIN tasks ON tasks.id = jira_task_links.task_id
        WHERE jira_task_links.jira_task_id = ?
          AND tasks.project_id NOT IN (${nextProjectIds.length > 0 ? nextProjectIds.map(() => "?").join(", ") : "NULL"})
        ORDER BY tasks.identifier
        LIMIT 1
      `).get(jiraTask.id, ...nextProjectIds);
      if (invalidLinkedIssue) {
        throw new ApiError(
          409,
          "JIRA_PROJECT_HAS_LINKED_ISSUES",
          `Unlink or move '${invalidLinkedIssue.identifier}' before removing its project`,
        );
      }
      this.database.prepare("DELETE FROM jira_task_projects WHERE jira_task_id = ?").run(jiraTask.id);
      const insert = this.database.prepare(`
        INSERT INTO jira_task_projects (jira_task_id, project_id, created_at)
        VALUES (?, ?, ?)
      `);
      for (const projectId of nextProjectIds) insert.run(jiraTask.id, projectId, timestamp);
      this.#recordTaskActivity(jiraTask.id, actor, [{
        field: "jiraProjects",
        before: currentProjectIds,
        after: nextProjectIds,
      }], timestamp);
      this.#touchTask(jiraTask.id, version, null, null, timestamp);
      this.#archiveCompletedJiraThreads(timestamp, jiraTask.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTask.id);
  }

  addJiraTaskLink(jiraId, version, taskId, actor, reservation = null) {
    const jiraTask = this.#requireTask(jiraId);
    const task = this.#requireTask(taskId);
    this.#requireVersion(jiraTask, version);
    if (jiraTask.source !== "jira" || task.source === "jira") {
      throw new ApiError(409, "JIRA_LINK_INVALID", "Link one Jira issue to one Panel issue");
    }
    if (task.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived issues cannot be linked to Jira");
    }
    this.#assertJiraMutationUnlocked(jiraTask.id, reservation);
    if (this.getJiraLifecycle(jiraTask.id).pending?.suggestedAction === "pause") {
      throw new ApiError(
        409,
        "JIRA_LIFECYCLE_PAUSE_PENDING",
        "Resolve the Jira lifecycle notice before linking another issue",
      );
    }
    const linkedProject = this.database.prepare(`
      SELECT 1 FROM jira_task_projects WHERE jira_task_id = ? AND project_id = ?
    `).get(jiraTask.id, task.projectId);
    if (!linkedProject) {
      throw new ApiError(
        409,
        "JIRA_PROJECT_LINK_REQUIRED",
        "Link the issue project to Jira before linking the issue",
      );
    }
    const existing = this.database.prepare(`
      SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
    `).get(task.id);
    if (existing?.jira_task_id === jiraTask.id) {
      throw new ApiError(409, "JIRA_LINK_EXISTS", "This Jira link already exists");
    }
    if (existing) {
      throw new ApiError(409, "JIRA_LINK_CONFLICT", "This Panel issue is already linked to another Jira issue");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO jira_task_links (jira_task_id, task_id, created_at) VALUES (?, ?, ?)
      `).run(jiraTask.id, task.id, timestamp);
      this.#recordTaskActivity(jiraTask.id, actor, [{
        field: "jiraIssue",
        before: null,
        after: relationActivityValue("jira", task),
      }], timestamp);
      this.#touchTask(jiraTask.id, version, null, null, timestamp);
      this.#archiveCompletedJiraThreads(timestamp, jiraTask.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTask.id);
  }

  removeJiraTaskLink(jiraId, version, taskId, actor, reservation = null) {
    const jiraTask = this.#requireTask(jiraId);
    const task = this.#requireTask(taskId);
    this.#requireVersion(jiraTask, version);
    if (jiraTask.source !== "jira" || task.source === "jira") {
      throw new ApiError(409, "JIRA_LINK_INVALID", "Link one Jira issue to one Panel issue");
    }
    this.#assertJiraMutationUnlocked(jiraTask.id, reservation);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.database.prepare(`
        DELETE FROM jira_task_links WHERE jira_task_id = ? AND task_id = ?
      `).run(jiraTask.id, task.id);
      if (removed.changes !== 1) {
        throw new ApiError(404, "JIRA_LINK_NOT_FOUND", "This Jira link does not exist");
      }
      this.#recordTaskActivity(jiraTask.id, actor, [{
        field: "jiraIssue",
        before: relationActivityValue("jira", task),
        after: null,
      }], timestamp);
      this.#touchTask(jiraTask.id, version, null, null, timestamp);
      this.#archiveCompletedJiraThreads(timestamp, jiraTask.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getJiraContext(jiraTask.id);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  getProjectAutomationPolicy(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT * FROM project_automation_policies WHERE project_id = ?
    `).get(projectId);
    const counts = Object.fromEntries(this.database.prepare(`
      SELECT state, COUNT(*) AS count
      FROM issue_claim_queue
      WHERE project_id = ?
      GROUP BY state
    `).all(projectId).map((item) => [item.state, Number(item.count)]));
    const settings = this.getAutomationSettings();
    const parallelismOverride = row?.parallelism_override ?? null;
    return {
      projectId,
      status: row?.enabled_by_user && !row.paused ? "ACTIVE" : "PAUSED",
      enabledByUser: Boolean(row?.enabled_by_user),
      paused: Boolean(row?.paused),
      intervalMinutes: row?.interval_minutes ?? 5,
      model: row?.model ?? "gpt-5.5",
      reasoningEffort: row?.reasoning_effort ?? "high",
      defaultParallelism: settings.defaultProjectParallelism,
      parallelismOverride,
      parallelism: parallelismOverride ?? settings.defaultProjectParallelism,
      nextScanAt: row?.next_scan_at ?? null,
      queue: {
        queued: (counts.queued ?? 0) + (counts.retry_wait ?? 0),
        running: counts.running ?? 0,
        blocked: counts.blocked ?? 0,
        failed: counts.failed ?? 0,
      },
      updatedAt: row?.updated_at ?? null,
    };
  }

  saveProjectAutomationPolicy(projectId, input) {
    const current = this.getProjectAutomationPolicy(projectId);
    const timestamp = now();
    const defaultParallelism = input.defaultParallelism ?? current.defaultParallelism;
    const parallelismOverride = input.parallelismOverride === undefined
      ? current.parallelismOverride
      : input.parallelismOverride;
    this.saveAutomationSettings(defaultParallelism, timestamp);
    const startsOrResumes = input.enabledByUser && !input.paused && (
      !current.enabledByUser
      || current.paused
      || current.intervalMinutes !== input.intervalMinutes
    );
    this.database.prepare(`
      INSERT INTO project_automation_policies (
        project_id, enabled_by_user, paused, interval_minutes, model,
        reasoning_effort, parallelism_override, next_scan_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        enabled_by_user = excluded.enabled_by_user,
        paused = excluded.paused,
        interval_minutes = excluded.interval_minutes,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        parallelism_override = excluded.parallelism_override,
        next_scan_at = excluded.next_scan_at,
        updated_at = excluded.updated_at
    `).run(
      projectId,
      input.enabledByUser ? 1 : 0,
      input.paused ? 1 : 0,
      input.intervalMinutes,
      input.model,
      input.reasoningEffort,
      parallelismOverride,
      startsOrResumes ? timestamp : current.nextScanAt,
      current.updatedAt ?? timestamp,
      timestamp,
    );
    return this.getProjectAutomationPolicy(projectId);
  }

  getAutomationSettings() {
    const row = this.database.prepare(`
      SELECT default_project_parallelism FROM automation_settings WHERE id = 1
    `).get();
    return { defaultProjectParallelism: row?.default_project_parallelism ?? 3 };
  }

  saveAutomationSettings(defaultProjectParallelism, timestamp = now()) {
    this.database.prepare(`
      INSERT INTO automation_settings (id, default_project_parallelism, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        default_project_parallelism = excluded.default_project_parallelism,
        updated_at = excluded.updated_at
    `).run(defaultProjectParallelism, timestamp);
    return this.getAutomationSettings();
  }

  addProjectLabel(projectId, label) {
    const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const labels = JSON.parse(project.labels);
    if (!labels.includes(label)) {
      this.database.prepare(`
        UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...labels, label]), now(), projectId);
    }
    return this.getProject(projectId);
  }

  deleteProjectLabel(projectId, label) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = now();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const updateTask = this.database.prepare(`
        UPDATE tasks
        SET labels = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const task of this.database.prepare(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `).all(projectId)) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          updateTask.run(
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(projectId);
  }

  getProjectSummary(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error, failure_count
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
      failureCount: 0,
    };
  }

  listProjectSummaries() {
    return this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error, failure_count
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error, failure_count
      ) VALUES (?, ?, ?, ?, NULL, 0)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL,
        failure_count = 0
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error, failure_count
      ) VALUES (?, NULL, NULL, ?, ?, 1)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error,
        failure_count = project_summaries.failure_count + 1
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getProjectReadme(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, content, version, created_at, updated_at
      FROM project_readmes
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? projectReadmeFromRow(row, projectId)
      : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
  }

  saveProjectReadme(projectId, content, expectedVersion) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).get(projectId);
      if (expectedVersion !== undefined) {
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
            expectedVersion,
            actualVersion,
          });
        }
      }
      if (current) {
        const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
        const params = expectedVersion !== undefined
          ? [content, timestamp, projectId, expectedVersion]
          : [content, timestamp, projectId];
        this.database.prepare(`
          UPDATE project_readmes
          SET content = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?${versionCondition}
        `).run(...params);
      } else {
        this.database.prepare(`
          INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(projectId, content, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProjectReadme(projectId);
  }

  createProjectReadmeAttachment(projectId, input) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    this.database.prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      projectId,
      input.filename,
      input.contentType,
      input.size,
      now(),
    );
    return this.getProjectReadmeAttachment(input.id);
  }

  getProjectReadmeAttachment(id) {
    const row = this.database.prepare(`
      SELECT * FROM project_readme_attachments WHERE id = ?
    `).get(id);
    return row ? projectReadmeAttachmentFromRow(row) : null;
  }

  listAiChatThreads() {
    const rows = this.database.prepare(`
      SELECT * FROM ai_chat_threads WHERE archived_at IS NULL OR status = 'running'
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status, purpose,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.purpose ?? "temporary",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      originIssueId: "origin_issue_id",
      originIssueIdentifier: "origin_issue_identifier",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    if (this.getAiChatThread(input.threadId)?.archivedAt) {
      throw new ApiError(409, "AI_CHAT_THREAD_ARCHIVED", "Cannot continue an archived conversation");
    }
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  getAiChatEvent(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return row ? aiChatEventFromRow(row) : null;
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  getClaimQueueItem(taskId) {
    return claimQueueItemFromRow(this.database.prepare(`
      SELECT * FROM issue_claim_queue WHERE task_id = ?
    `).get(taskId));
  }

  listClaimAttempts(taskId) {
    return this.database.prepare(`
      SELECT * FROM issue_claim_attempts
      WHERE task_id = ?
      ORDER BY started_at, id
    `).all(taskId).map(claimAttemptFromRow);
  }

  enqueueClaim(taskId, source, availableAt = now()) {
    const task = this.#requireTask(taskId);
    if (task.source === "jira" || task.archivedAt !== null) {
      throw new ApiError(409, "CLAIM_TASK_UNAVAILABLE", "Only active Panel issues can be queued");
    }
    if (!["todo", "blocked"].includes(task.status)) {
      const current = this.getClaimQueueItem(task.id);
      if (current?.state === "running") return current;
      throw new ApiError(409, "CLAIM_TASK_STATUS", "Only waiting or blocked issues can be queued");
    }
    if (!Object.hasOwn(CLAIM_SOURCE_RANK, source)) {
      throw new ApiError(400, "INVALID_CLAIM_SOURCE", `Unknown claim source '${source}'`);
    }
    const current = this.getClaimQueueItem(task.id);
    if (current?.state === "running") return current;
    const timestamp = now();
    const effectiveSource = current && ["queued", "retry_wait"].includes(current.state)
      && CLAIM_SOURCE_RANK[current.source] <= CLAIM_SOURCE_RANK[source]
      ? current.source
      : source;
    const enqueuedAt = current && ["queued", "retry_wait"].includes(current.state)
      ? current.enqueuedAt
      : timestamp;
    this.database.prepare(`
      INSERT INTO issue_claim_queue (
        task_id, project_id, thread_id, source, state, resume_requested, attempt_count,
        available_at, enqueued_at, started_at, finished_at, last_error, updated_at
      ) VALUES (?, ?, NULL, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_id = excluded.project_id,
        source = excluded.source,
        state = 'queued',
        resume_requested = 0,
        attempt_count = CASE
          WHEN issue_claim_queue.state IN ('failed', 'completed', 'canceled') THEN 0
          ELSE issue_claim_queue.attempt_count
        END,
        available_at = excluded.available_at,
        enqueued_at = excluded.enqueued_at,
        started_at = NULL,
        finished_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(task.id, task.projectId, effectiveSource, availableAt, enqueuedAt, timestamp);
    return this.getClaimQueueItem(task.id);
  }

  enqueueAuthorizedJiraClaims() {
    const candidates = this.database.prepare(`
      SELECT linked.task_id
      FROM jira_task_links AS linked
      JOIN tasks AS issues ON issues.id = linked.task_id
      JOIN tasks AS jira ON jira.id = linked.jira_task_id
      JOIN project_automation_policies AS policy ON policy.project_id = issues.project_id
      LEFT JOIN jira_lifecycles AS lifecycle ON lifecycle.jira_task_id = jira.id
      WHERE issues.archived_at IS NULL
        AND issues.status = 'todo'
        AND jira.status = 'in_progress'
        AND policy.enabled_by_user = 1
        AND lifecycle.pending_kind IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM issue_claim_queue AS queued
          WHERE queued.task_id = issues.id
            AND queued.state IN ('queued', 'running', 'retry_wait')
        )
      ORDER BY issues.project_id, issues.sort_order, issues.created_at, issues.id
    `).all();
    return candidates.map(({ task_id: taskId }) => this.enqueueClaim(taskId, "jira"));
  }

  enqueueDueProjectScans(at = now()) {
    const due = this.database.prepare(`
      SELECT * FROM project_automation_policies
      WHERE enabled_by_user = 1
        AND paused = 0
        AND (next_scan_at IS NULL OR next_scan_at <= ?)
      ORDER BY COALESCE(next_scan_at, created_at), project_id
    `).all(at);
    const queued = [];
    for (const policy of due) {
      const tasks = this.database.prepare(`
        SELECT tasks.id
        FROM tasks
        WHERE tasks.project_id = ?
          AND tasks.archived_at IS NULL
          AND tasks.status = 'todo'
          AND tasks.external_source IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM jira_task_links WHERE jira_task_links.task_id = tasks.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM issue_claim_queue AS queued
            WHERE queued.task_id = tasks.id
              AND queued.state IN ('queued', 'running', 'retry_wait')
          )
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      `).all(policy.project_id);
      for (const task of tasks) queued.push(this.enqueueClaim(task.id, "scan", at));
      const nextScanAt = new Date(
        new Date(at).getTime() + Number(policy.interval_minutes) * 60_000,
      ).toISOString();
      this.database.prepare(`
        UPDATE project_automation_policies
        SET next_scan_at = ?, updated_at = ?
        WHERE project_id = ?
      `).run(nextScanAt, at, policy.project_id);
    }
    return queued;
  }

  reconcileClaimQueue() {
    const timestamp = now();
    this.database.prepare(`
      UPDATE issue_claim_queue
      SET state = CASE
            WHEN tasks.status IN ('in_review', 'done') THEN 'completed'
            WHEN tasks.status = 'blocked' THEN 'blocked'
            ELSE 'canceled'
          END,
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?
      FROM tasks
      WHERE tasks.id = issue_claim_queue.task_id
        AND issue_claim_queue.state IN ('queued', 'retry_wait')
        AND (
          tasks.archived_at IS NOT NULL
          OR tasks.status NOT IN ('todo', 'in_progress')
        )
    `).run(timestamp, timestamp);
  }

  listReadyClaims(at = now()) {
    return this.database.prepare(`
      SELECT queue.task_id
      FROM issue_claim_queue AS queue
      JOIN tasks ON tasks.id = queue.task_id
      LEFT JOIN project_automation_policies AS policy ON policy.project_id = queue.project_id
      WHERE queue.state IN ('queued', 'retry_wait')
        AND queue.available_at <= ?
        AND tasks.archived_at IS NULL
        AND tasks.status = 'todo'
        AND COALESCE(policy.paused, 0) = 0
      ORDER BY
        CASE queue.source
          ${CLAIM_SOURCE_RANK_SQL}
          ELSE 3
        END,
        CASE tasks.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        tasks.sort_order,
        queue.enqueued_at,
        tasks.created_at,
        tasks.id
    `).all(at).map((row) => {
      const task = this.getTask(row.task_id);
      return {
        task,
        claim: this.getClaimQueueItem(row.task_id),
        policy: this.getProjectAutomationPolicy(task.projectId),
      };
    });
  }

  nextClaim(at = now()) {
    return this.listReadyClaims(at)[0] ?? null;
  }

  setClaimThread(taskId, threadId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE issue_claim_queue SET thread_id = ?, updated_at = ? WHERE task_id = ?
    `).run(threadId, timestamp, taskId);
    if (result.changes !== 1) {
      throw new ApiError(404, "CLAIM_NOT_FOUND", `Claim queue item '${taskId}' does not exist`);
    }
    return this.getClaimQueueItem(taskId);
  }

  markClaimRunning(taskId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE issue_claim_queue
      SET state = 'running', attempt_count = attempt_count + 1,
          resume_requested = 0, started_at = ?, finished_at = NULL,
          last_error = NULL, updated_at = ?
      WHERE task_id = ? AND state IN ('queued', 'retry_wait')
    `).run(timestamp, timestamp, taskId);
    if (result.changes !== 1) {
      throw new ApiError(409, "CLAIM_NOT_READY", `Claim queue item '${taskId}' is not ready`);
    }
    return this.getClaimQueueItem(taskId);
  }

  requestClaimResume(taskId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE issue_claim_queue
      SET resume_requested = 1, updated_at = ?
      WHERE task_id = ? AND state = 'running'
    `).run(timestamp, taskId);
    if (result.changes !== 1) return null;
    return this.getClaimQueueItem(taskId);
  }

  createClaimAttempt(input) {
    const id = input.id ?? randomUUID();
    this.database.prepare(`
      INSERT INTO issue_claim_attempts (
        id, task_id, thread_id, run_id, status, error, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.threadId,
      input.runId ?? null,
      input.status ?? "running",
      input.error ?? null,
      input.startedAt ?? now(),
      input.finishedAt ?? null,
    );
    return claimAttemptFromRow(this.database.prepare(`
      SELECT * FROM issue_claim_attempts WHERE id = ?
    `).get(id));
  }

  attachClaimAttemptRun(id, runId) {
    this.database.prepare(`
      UPDATE issue_claim_attempts SET run_id = ? WHERE id = ? AND status = 'running'
    `).run(runId, id);
    return claimAttemptFromRow(this.database.prepare(`
      SELECT * FROM issue_claim_attempts WHERE id = ?
    `).get(id));
  }

  finishClaimAttempt(id, status, error = null) {
    const timestamp = now();
    this.database.prepare(`
      UPDATE issue_claim_attempts
      SET status = ?, error = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(status, error, timestamp, id);
    return claimAttemptFromRow(this.database.prepare(`
      SELECT * FROM issue_claim_attempts WHERE id = ?
    `).get(id));
  }

  scheduleClaimRetry(taskId, error, availableAt) {
    const timestamp = now();
    this.database.prepare(`
      UPDATE issue_claim_queue
      SET state = 'retry_wait', source = 'resume', available_at = ?,
          finished_at = NULL, last_error = ?, updated_at = ?
      WHERE task_id = ?
    `).run(availableAt, error, timestamp, taskId);
    return this.getClaimQueueItem(taskId);
  }

  finishClaim(taskId, state, error = null) {
    if (!["blocked", "failed", "completed", "canceled"].includes(state)) {
      throw new ApiError(400, "INVALID_CLAIM_STATE", `Cannot finish claim as '${state}'`);
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE issue_claim_queue
      SET state = ?, finished_at = ?, last_error = ?, updated_at = ?
      WHERE task_id = ?
    `).run(state, timestamp, error, timestamp, taskId);
    return this.getClaimQueueItem(taskId);
  }

  recoverInterruptedClaims() {
    const timestamp = now();
    const taskIds = this.database.prepare(`
      SELECT task_id FROM issue_claim_queue WHERE state = 'running'
      ORDER BY started_at, task_id
    `).all().map((row) => row.task_id);
    this.database.prepare(`
      UPDATE issue_claim_attempts
      SET status = 'interrupted', error = COALESCE(error, 'Panel service restarted'),
          finished_at = COALESCE(finished_at, ?)
      WHERE status = 'running'
    `).run(timestamp);
    this.database.prepare(`
      UPDATE issue_claim_queue
      SET state = 'queued', source = 'resume', available_at = ?,
          finished_at = NULL,
          last_error = 'Panel service restarted', updated_at = ?
      WHERE state = 'running'
    `).run(timestamp, timestamp);
    return taskIds;
  }

  suggestedExecutionThreadId(taskId) {
    return this.getClaimQueueItem(taskId)?.threadId
      ?? this.database.prepare(`
        SELECT thread_id FROM jira_simple_start_items WHERE task_id = ? LIMIT 1
      `).get(taskId)?.thread_id
      ?? this.database.prepare(`
        SELECT id FROM ai_chat_threads
        WHERE origin_issue_id = ? AND archived_at IS NULL
        ORDER BY created_at, id
        LIMIT 1
      `).get(taskId)?.id
      ?? null;
  }

  #archiveCompletedJiraThreads(timestamp, jiraTaskId = null, manual = false) {
    if (!manual && !this.getJiraSettings().autoArchiveEnabled) return;
    const candidates = jiraTaskId
      ? [{ id: jiraTaskId }]
      : this.database.prepare(`
        SELECT id FROM tasks
        WHERE external_source = 'jira' AND status = 'done'
      `).all();
    const archive = this.database.prepare(`
      UPDATE ai_chat_threads
      SET archived_at = ?, updated_at = ?
      WHERE archived_at IS NULL
        AND id IN (
          SELECT thread_id FROM jira_plan_threads WHERE jira_task_id = ?
          UNION
          SELECT items.thread_id
          FROM jira_simple_start_operations AS operations
          JOIN jira_simple_start_items AS items ON items.operation_id = operations.id
          WHERE operations.jira_task_id = ?
          UNION
          SELECT queue.thread_id
          FROM jira_task_links AS links
          JOIN issue_claim_queue AS queue ON queue.task_id = links.task_id
          WHERE links.jira_task_id = ? AND queue.thread_id IS NOT NULL
          UNION
          SELECT attempts.thread_id
          FROM jira_task_links AS links
          JOIN issue_claim_attempts AS attempts ON attempts.task_id = links.task_id
          WHERE links.jira_task_id = ?
          UNION
          SELECT thread_id FROM jira_rework_items WHERE jira_task_id = ?
        )
    `);
    for (const candidate of candidates) {
      if (!this.getJiraConversationArchive(candidate.id).eligible) continue;
      archive.run(timestamp, timestamp, ...Array(5).fill(candidate.id));
    }
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Panel service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.database.prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return rows.map((row) => attachTaskActivity(
      this.#taskWithRelations(row),
      commentsByTask.get(row.id) ?? [],
      activitiesByTask.get(row.id) ?? [],
      previewImagesByTask.get(row.id) ?? null,
    ));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    return attachTaskActivity(task, comments, activities, previewImage);
  }

  getTaskTree(id, direction, depth) {
    const root = this.database.prepare(
      "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
    ).get(id, id);
    if (!root) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);

    const nodes = [taskTreeNode(root, null, 0, [root.id])];
    const seen = new Set([root.id]);
    let frontier = [nodes[0]];
    const relationJoin = direction === "descendants"
      ? `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.target_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.source_task_id IN (%PLACEHOLDERS%)
      `
      : `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.source_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.target_task_id IN (%PLACEHOLDERS%)
      `;
    const parentColumn = direction === "descendants"
      ? "task_relations.source_task_id"
      : "task_relations.target_task_id";

    for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
      const placeholders = frontier.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT tasks.*, ${parentColumn} AS tree_parent_id
        ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      `).all(...frontier.map((node) => node.id));
      const rowsByParent = new Map();
      for (const row of rows) {
        const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
        siblings.push(row);
        rowsByParent.set(row.tree_parent_id, siblings);
      }
      const next = [];
      for (const parent of frontier) {
        for (const row of rowsByParent.get(parent.id) ?? []) {
          if (seen.has(row.id)) continue;
          if (nodes.length >= TASK_TREE_MAX_NODES) {
            throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
          }
          const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
          nodes.push(node);
          next.push(node);
          seen.add(row.id);
        }
      }
      frontier = next;
    }

    return {
      rootId: root.id,
      direction,
      depth,
      nodeCount: nodes.length,
      nodes,
    };
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT
          projects.id,
          projects.name,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = projectPrefix(project);
      const maximum = this.database.prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = input.id ?? randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `).run(
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate ?? null,
        input.dueDate ?? null,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    this.#assertJiraMutationUnlocked(current.id);
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      this.#assertJiraPlanAllowsExecution(current.id, changes.status);
    }
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.database.prepare("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      const jiraLink = this.database.prepare(`
        SELECT jira_task_id
        FROM jira_task_links
        WHERE task_id = ?
      `).get(current.id);
      if (jiraLink) {
        const projectAllowed = this.database.prepare(`
          SELECT 1
          FROM jira_task_projects
          WHERE jira_task_id = ? AND project_id = ?
        `).get(jiraLink.jira_task_id, targetProject.id);
        if (!projectAllowed) {
          throw new ApiError(
            409,
            "JIRA_PROJECT_MOVE_BLOCKED",
            "This issue can only move to a project linked to its Jira issue",
          );
        }
      }
      if (current.developmentContext) {
        throw new ApiError(
          409,
          "DEVELOPMENT_CONTEXT_PROJECT_MOVE_BLOCKED",
          "Clear the issue development context before moving it to another project",
        );
      }
      const relation = this.database.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    if (storedBinding && !Object.hasOwn(changes, "projectId")) {
      assignments.push(
        "thread_id = ?",
        "thread_codex_project_id = ?",
        "thread_codex_project_kind = ?",
        "thread_codex_host_id = ?",
        "thread_workspace_path = ?",
      );
      values.push(...storedBinding);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (current.source === "jira" && Object.hasOwn(changes, "status") && changes.status !== current.status) {
        this.#syncJiraLifecycle(current, changes.status, timestamp);
      }
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.database.prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = this.database.prepare(`
        SELECT labels FROM projects WHERE id = ?
      `).get(destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      if (changes.status === "done") {
        const jiraTaskId = current.source === "jira"
          ? current.id
          : this.database.prepare(`
            SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
          `).get(current.id)?.jira_task_id;
        if (jiraTaskId) this.#archiveCompletedJiraThreads(timestamp, jiraTaskId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    this.#assertJiraMutationUnlocked(current.id);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status) {
      this.#assertJiraPlanAllowsExecution(current.id, status);
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (current.source === "jira" && status !== current.status) {
        this.#syncJiraLifecycle(current, status, timestamp);
      }
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      if (status === "done") {
        const jiraTaskId = current.source === "jira"
          ? current.id
          : this.database.prepare(`
            SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
          `).get(current.id)?.jira_task_id;
        if (jiraTaskId) this.#archiveCompletedJiraThreads(timestamp, jiraTaskId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    this.#assertJiraMutationUnlocked(current.id);
    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    this.#assertJiraMutationUnlocked(current.id);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      const link = this.database.prepare(`
        SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
      `).get(current.id);
      if (link) this.#archiveCompletedJiraThreads(timestamp, link.jira_task_id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      this.#assertJiraMutationUnlocked(current.id);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const jiraLink = this.database.prepare(`
        SELECT jira_task_id FROM jira_task_links WHERE task_id = ?
      `).get(current.id);
      if (jiraLink) {
        throw new ApiError(
          409,
          "JIRA_LINK_DELETE_BLOCKED",
          "Unlink the Jira issue before permanently deleting this issue",
        );
      }
      const attachmentIds = this.database.prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const result = this.database.prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin = "manual") {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, origin, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, origin, timestamp);
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const relation = this.database.prepare(`
        SELECT origin
        FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).get(relationType, sourceTaskId, targetTaskId);
      if (!relation) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      if (origin && relation.origin !== origin) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      let deleted;
      if (origin === "mention" && relationType === "related") {
        const taskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: relatedTask.identifier,
        })})`;
        const relatedTaskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: task.identifier,
        })})`;
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
            AND origin = 'mention'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks
              WHERE (id = ? AND instr(description, ?) > 0)
                OR (id = ? AND instr(description, ?) > 0)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM comments
              WHERE (task_id = ? AND instr(body, ?) > 0)
                OR (task_id = ? AND instr(body, ?) > 0)
            )
        `).run(
          relationType,
          sourceTaskId,
          targetTaskId,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
        );
      } else {
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).run(relationType, sourceTaskId, targetTaskId);
      }
      if (origin === "mention" && relationType === "related" && deleted.changes === 0) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  listCommentsAfter(taskId, after) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).all(task.id, after.revision)
      .map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const id = randomUUID();
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, threadBinding) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireComment(id);
      this.#requireCommentVersion(current, version);
      const changeRevision = this.#nextCommentAttachmentRevision();
      const result = this.database.prepare(`
        UPDATE comments
        SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?,
          change_revision = ?
        WHERE id = ? AND version = ?
      `).run(body, ...(storedBinding ?? []), now(), changeRevision, id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId, after = null) {
    const task = this.#requireTask(taskId);
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE task_id = ? AND comment_id IS NULL
          AND change_revision > ?
        ORDER BY change_revision
      `).all(task.id, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        task.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId, after = null) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId, after);
  }

  createCommentAttachment(commentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const comment = this.#requireComment(commentId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        comment.taskId,
        comment.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT attachments.*
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        WHERE attachments.task_id IN (${placeholders})
          AND attachments.comment_id IS NULL
          AND attachments.content_type LIKE 'image/%'
          AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
        ORDER BY attachments.task_id, attachments.created_at, attachments.id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId, after = null) {
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE comment_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `).all(commentId, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #nextCommentAttachmentRevision() {
    return this.database.prepare(`
      UPDATE comment_attachment_revision
      SET value = value + 1
      WHERE id = 1
      RETURNING value
    `).get().value;
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    task.claim = this.getClaimQueueItem(task.id);
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, threadBinding, timestamp) {
    const current = this.#requireTask(id);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.database.prepare(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(...(storedBinding ?? []), timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
