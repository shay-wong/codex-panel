export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";
export type IssueRelationOrigin = "manual" | "mention";

export type ClaimState =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "completed"
  | "canceled";

export interface IssueClaim {
  taskId: string;
  projectId: string;
  threadId: string | null;
  source: "manual" | "resume" | "jira" | "scan";
  state: ClaimState;
  resumeRequested: boolean;
  attemptCount: number;
  availableAt: string;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface ProjectAutomationOptions {
  enabledByUser: boolean;
  paused: boolean;
  intervalMinutes: 5 | 10 | 15 | 30 | 60;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  defaultParallelism: number;
  parallelismOverride: number | null;
}

export interface ProjectAutomationPolicy extends ProjectAutomationOptions {
  projectId: string;
  status: "ACTIVE" | "PAUSED";
  parallelism: number;
  nextScanAt: string | null;
  queue: {
    queued: number;
    running: number;
    blocked: number;
    failed: number;
  };
  updatedAt: string | null;
}

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface PanelMetadata {
  managePanelSkillPath?: string;
  capabilities?: PanelCapabilities;
  mode?: "local" | "cloud";
  realtime?:
    | { transport: "poll"; intervalMs: number }
    | { transport: "websocket"; endpoint: string };
  localCapabilities?: {
    available: boolean;
  };
}

export interface PanelCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface AiChatModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export const COMPOSER_CONTRACT_VERSION = "composer.v1" as const;

export type ComposerTrigger = "@" | "/";
export type ComposerSurface = "ai-chat" | "issue-description" | "comment";

export type ComposerSourceKind =
  | "skills"
  | "slash"
  | "apps"
  | "files"
  | "agents"
  | "plugins"
  | "customPrompts";

export type ComposerSourceReasonCode =
  | "SOURCE_UNAVAILABLE"
  | "NO_STABLE_CATALOG"
  | "ACTION_UNVERIFIED"
  | "INVOCATION_NAME_UNAVAILABLE"
  | "ENCODER_UNSUPPORTED"
  | "EXPERIMENTAL_SOURCE_NOT_ALLOWED";

export interface ComposerSourceState {
  kind: ComposerSourceKind;
  state: "available" | "unavailable" | "unsupported";
  reasonCode: ComposerSourceReasonCode | null;
}

interface ComposerCandidateBase {
  candidateRef: string;
  label: string;
  description: string | null;
  group: string;
  groupOrder: number;
  itemOrder: number;
  selectable: true;
  insertionText?: string;
}

export interface ComposerReferencePersistence {
  format: "taskboard.composer-reference.v1";
  kind: "skill" | "agent";
  referenceKey: string;
  markdown: string;
}

export interface ComposerInsertTextSelection {
  type: "insertText";
  text: string;
}

export interface ComposerSkillCandidate extends ComposerCandidateBase {
  kind: "skill";
  trigger: "@" | "/";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerAgentCandidate extends ComposerCandidateBase {
  kind: "agent";
  trigger: "@";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerSlashActionCandidate extends ComposerCandidateBase {
  kind: "slashAction";
  trigger: "/";
  command: string;
  dispatch: {
    type: "client" | "server";
    handlerId: string;
  };
  selection?: ComposerInsertTextSelection;
}

export type ComposerCandidate =
  | ComposerSkillCandidate
  | ComposerAgentCandidate
  | ComposerSlashActionCandidate;

export interface ComposerCandidatesQuery {
  projectId?: string;
  threadId?: string;
  surface?: ComposerSurface;
  trigger: ComposerTrigger;
  query: string;
}

export interface ComposerCandidatesResponse {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  candidates: ComposerCandidate[];
  sources: ComposerSourceState[];
}

export interface ComposerTextNode {
  type: "text";
  text: string;
}

export interface ComposerSkillNode {
  type: "skill";
  candidateRef: string;
  label: string;
}

export interface ComposerAgentNode {
  type: "agent";
  candidateRef: string;
  label: string;
}

export type ComposerNode = ComposerTextNode | ComposerSkillNode | ComposerAgentNode;

export interface ComposerPersistedReferenceNode {
  type: "persistedReference";
  referenceKind: "skill" | "agent";
  referenceKey: string;
  label: string;
}

export interface ComposerUnsupportedReferenceNode {
  type: "unsupportedReference";
  referenceUri: string;
  label: string;
}

export interface ComposerPersistedDocument {
  version: 1;
  nodes: Array<ComposerTextNode | ComposerPersistedReferenceNode | ComposerUnsupportedReferenceNode>;
}

export interface ComposerDocument {
  version: 1;
  nodes: ComposerNode[];
}

export interface ComposerRebindRequest {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  projectId: string;
  threadId?: string;
  document: ComposerPersistedDocument;
}

export interface ComposerRebindBinding {
  nodeIndex: number;
  status: "resolved" | "unavailable";
  referenceKind: "skill" | "agent" | "unsupported";
  label?: string;
  reasonCode?:
    | "SOURCE_UNAVAILABLE"
    | "REFERENCE_NOT_FOUND"
    | "REFERENCE_AMBIGUOUS"
    | "REFERENCE_KIND_UNSUPPORTED"
    | "REFERENCE_FORMAT_UNSUPPORTED";
}

export type ComposerRebindResponse = {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  bindings: ComposerRebindBinding[];
  sources: ComposerSourceState[];
  diagnostics: unknown[];
} & (
  | { ready: true; document: ComposerDocument }
  | { ready: false; document?: never }
);

export interface ComposerTurnInput {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  document: ComposerDocument;
  dangerFullAccessConfirmed?: boolean;
  attachments?: AiChatAttachmentInput[];
}

export interface AiChatCatalog {
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatTodoProgress {
  completed: number;
  total: number;
  eventId: string;
  updatedAt: string;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
  latestTodo?: AiChatTodoProgress | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface CodexProjectIdentity {
  codexProjectId: string;
  codexProjectKind: "local" | "remote";
  codexHostId: string;
  workspacePath: string;
}

export interface CodexThreadBinding extends CodexProjectIdentity {
  threadId: string;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  source: "local" | "jira";
  labels: string[];
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  projectId: string;
  summary: string | null;
  updatedAt: string | null;
  refreshing: boolean;
  error: string | null;
}

export interface ProjectReadme {
  projectId: string;
  content: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectReadmeAttachment {
  id: string;
  projectId: string;
  kind: "inline";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  externalKey?: string | null;
  projectId: string;
  title: string;
  status: TaskStatus;
  externalUrl?: string | null;
  externalStatus?: string | null;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
  version: number;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

interface TaskConversationRefBase {
  source: "task" | "comment";
  sourceId: string;
  title: string;
  updatedAt: string;
}

export type TaskConversationRef = TaskConversationRefBase & (
  | (CodexThreadBinding & { legacyLocal?: false })
  | { threadId: string; legacyLocal: true }
);

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
  conversationRefs: TaskConversationRef[];
  participants: ActorIdentity[];
  previewImage: Attachment | null;
  activityKey: string;
  activityUpdatedAt: string;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  source: "local" | "jira";
  externalOrigin?: string | null;
  externalKey?: string | null;
  externalUrl: string | null;
  externalStatus?: string | null;
  externalUpdatedAt?: string | null;
  externalSyncedAt?: string | null;
  externalSyncError?: string | null;
  archivedAt: string | null;
  claim: IssueClaim | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface JiraTaskContext {
  jira: Task | null;
  projects: Project[];
  issues: TaskRelationSummary[];
  availableIssues: TaskRelationSummary[];
  availableJira: TaskRelationSummary[];
  simpleStart: JiraSimpleStartOperation | null;
  plan: JiraPlan | null;
  lifecycle: JiraLifecycle | null;
  autoCompletion: JiraAutoCompletion | null;
  conversationArchive: JiraConversationArchive | null;
}

export interface JiraConversationArchive {
  eligible: boolean;
  reason:
    | "jira_not_done"
    | "no_linked_issues"
    | "linked_issues_incomplete"
    | "no_related_conversations"
    | "already_archived"
    | null;
  relatedThreadCount: number;
  unarchivedThreadCount: number;
}

export interface JiraAutoCompletion {
  state: "queued" | "running" | "retry_wait" | "conflict" | "failed" | "completed" | "dismissed";
  expectedUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  remoteStatus: string | null;
  remoteTaskStatus: TaskStatus | null;
  attemptCount: number;
  availableAt: string;
  error: { code: string; message: string } | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface JiraLifecycle {
  pending: {
    kind: "waiting" | "ended" | "reopened" | "duplicate";
    fromStatus: TaskStatus | null;
    toStatus: TaskStatus | null;
    suggestedAction: "pause" | "rework" | "migrate";
    createdAt: string;
  } | null;
  pausedIssueIds: string[];
  reopened: boolean;
  duplicateOf: {
    externalKey: string | null;
    jiraTaskId: string | null;
    accessible: boolean;
  } | null;
  version: number;
}

export interface JiraPlan {
  threadId: string | null;
  status: "planning" | "review" | "publishing" | "published";
  spec: string;
  needsReview: boolean;
  promptedAt: string | null;
  publication: number;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: JiraPlanItem[];
}

export interface JiraPlanItem {
  key: string;
  publication: number;
  projectId: string;
  taskId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  blockedBy: string[];
  task: TaskRelationSummary | null;
}

export interface JiraSimpleStartOperation {
  id: string;
  status: "creating" | "complete";
  transitionedAt: string | null;
  projectCount: number;
  readyCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JiraConnection {
  configured: boolean;
  baseUrl: string | null;
  authMethod: "basic" | "bearer";
  username: string | null;
  displayName: string | null;
  projects: string[];
  projectId: string;
  lastSyncedAt: string | null;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  syncedIssueCount: number;
  unknownIssueCount: number;
  syncError: { code: string; message: string } | null;
  autoCompleteEnabled: boolean;
  autoArchiveEnabled: boolean;
  insecureHttp: boolean;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface TaskChangeActivity {
  id: string;
  taskId: string;
  actorType: ActorType;
  actorId: string;
  actorName: string;
  actorAvatarUrl: string | null;
  changes: TaskActivityChange[];
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  kind: "inline" | "attachment";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  language?: string;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{
    id: string;
    name: string;
    projectKind?: "local" | "remote";
    workspacePath?: string;
    hostId?: string;
  }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
  threadRunning?: boolean;
  threadTodoProgress?: {
    completed: number;
    total: number;
  };
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export type TaskUpdate = TaskDraft & { projectId?: string };

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
import type {
  AutomationModel,
  AutomationReasoningEffort,
} from "../../shared/panel-automation-options.mjs";
