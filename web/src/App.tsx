import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProjectLabel as createProjectLabelRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  createComment,
  configureJiraConnection,
  deleteArchivedTask as deleteArchivedTaskRequest,
  deleteProjectLabel as deleteProjectLabelRequest,
  deleteProject as deleteProjectRequest,
  getAiChatCatalog,
  getCodexThreadProgress,
  getHostRuntime,
  getJiraConnection,
  getTask,
  getPanelRevision,
  getPanelMetadata,
  getProjectAutomationPolicy,
  listArchivedTasks,
  listComments,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  publishHostRuntime,
  removeTaskRelation,
  resolvePanelUrl,
  resolvePanelWebSocketUrl,
  restoreTask as restoreTaskRequest,
  setApiText,
  setCurrentUserActor,
  syncJiraConnection,
  saveJiraSettings,
  uploadAttachment,
  updateTask as updateTaskRequest,
  saveProjectAutomationPolicy,
} from "./api";
import {
  actorKey,
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn } from "./components/BoardColumn";
import type { AiChatOpenThreadRequest } from "./components/AiChat";
import {
  BoardCardDisplayMenu,
  DEFAULT_BOARD_DISPLAY_SETTINGS,
  type BoardDisplaySettings,
} from "./components/BoardCardDisplayMenu";
import { DashboardView } from "./components/DashboardView";
import { ProjectReadmeView } from "./components/ProjectReadmeView";
import { IssueListView } from "./components/IssueListView";
import { JiraConnectionDialog } from "./components/JiraConnectionDialog";
import { ArchivedTasksColumn, OtherTasksPanel } from "./components/OtherTasksPanel";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import {
  DeleteIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  RelationIcon,
} from "./components/SemanticIcons";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { PanelIcon } from "./components/PanelIcon";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import {
  TaskEditor,
  type NewTaskCreateOptions,
  type NewTaskEditorDraft,
} from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { panelStorage } from "./storage";
import {
  installEmbeddedExternalLinkHandler,
  postEmbeddedHostMessage,
  setEmbeddedFrameChallenge,
} from "./embeddedHost.mjs";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import {
  getTaskboardI18n,
  resolveTaskboardLanguage,
  taskStatusLabel,
  TaskboardLanguageProvider,
} from "./i18n";
import {
  MAIN_STATUSES,
  type OtherTaskTab,
} from "./issueBoardStatuses";
import {
  normalizeCodexThreadId,
  taskCardPresentation,
  type TaskCardPresentation,
  type TaskConversationItem,
} from "./taskConversations";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatThread,
  type CodexProjectIdentity,
  type CodexThreadBinding,
  type Comment,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationOrigin,
  type IssueRelationType,
  type JiraConnection,
  type Project,
  type ProjectAutomationOptions,
  type ProjectAutomationPolicy,
  type Task,
  type PanelMetadata,
  type TaskDraft,
  type TaskStatus,
  type TaskUpdate,
} from "./types";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, createRevisionWebSocketClient, getRevisionPollingInterval, getRevisionWebSocketConfig } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "readme" | "dashboard" | "issues" | "list" | "gantt";
type ListLayout = "horizontal" | "vertical";
type ListCollapseMode = "always-expanded" | "remember" | "always-collapsed";
type ListCollapseModes = Record<TaskStatus, ListCollapseMode>;
type DetailSourceScroll =
  | { projectId: string; view: "issues"; status: TaskStatus; scrollTop: number }
  | { projectId: string; view: "list"; scrollLeft: number; scrollTop: number };
type GanttZoom = "day" | "week" | "month";
type ActionError = string | readonly [string, string];
type ProjectLoadError = {
  source: "projects";
  operation: "initial" | "refresh";
  requestId: number;
  message: string;
};
type TasksLoadError = {
  source: "tasks";
  requestId: number;
  message: string;
};
type LoadError = ProjectLoadError | TasksLoadError;
const GANTT_ZOOM_OPTIONS: GanttZoom[] = ["day", "week", "month"];
const AI_CHAT_HANDOFF_COMMENT_MARKER = "<!-- codex-panel:ai-chat-handoff:v1 -->";
const NATIVE_HANDOFF_CONTEXT_LIMIT = 12_000;

const AiChat = lazy(() => import("./components/AiChat").then((module) => ({
  default: module.AiChat,
})));
const GanttView = lazy(() => import("./components/GanttView").then((module) => ({
  default: module.GanttView,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
  projectId?: string | null;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  codexIdentity: CodexProjectIdentity | null;
}

interface ProjectContextMenuState {
  project: ProjectChoice;
  x: number;
  y: number;
}

interface UndoOperation {
  id: number;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

interface PendingRemoteThreadClaim {
  identity: CodexProjectIdentity;
  projectId: string;
  developmentContext: string;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const GLOBAL_PROJECT_ID = "local";
const JIRA_PROJECT_ID = "jira-my-tasks";
const ALL_PROJECTS_ID = "__all_projects__";
const RECENT_PROJECT_IDS_KEY = "panel.recentProjectIds.v1";
const PROJECT_VIEW_KEY_PREFIX = "panel.project-view.v1.";
const PROJECT_LIST_LAYOUT_KEY_PREFIX = "panel.project-list-layout.v1.";
const PROJECT_LIST_COLLAPSE_MODES_KEY_PREFIX = "panel.project-list-collapse-modes.v2.";
const PROJECT_LIST_COLLAPSED_STATUSES_KEY_PREFIX = "panel.project-list-collapsed-statuses.v1.";
const DEVICE_WORKSPACE_PATHS_KEY = "panel.deviceWorkspacePaths.v1";
const PROJECT_CODEX_IDENTITIES_KEY = "panel.projectCodexIdentities.v1";
const LEGACY_PROJECT_AUTOMATIONS_KEY = "panel.projectAutomations.v1";
const PROJECT_BOARD_DISPLAY_SETTINGS_KEY = "panel.project-board-display-settings.v3";
const ISSUE_READ_KEY_PREFIX = "panel.issue-read.v1";
const FIRST_USE_COMPLETE_KEY = "panel.first-use-complete.v1";
function readIssueActivityKeys(storageKey: string): Record<string, string> {
  try {
    const value = JSON.parse(panelStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[0] === "string" && typeof entry[1] === "string"
    )));
  } catch {
    return {};
  }
}

function readProjectBoardView(projectId: string): BoardView {
  const view = panelStorage.getItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`);
  return view === "readme" || view === "dashboard" || view === "list" || view === "gantt" || view === "issues"
    ? view
    : "issues";
}

function readProjectListLayout(projectId: string): ListLayout {
  return panelStorage.getItem(`${PROJECT_LIST_LAYOUT_KEY_PREFIX}${projectId}`) === "vertical"
    ? "vertical"
    : "horizontal";
}

function defaultListCollapseModes(): ListCollapseModes {
  return Object.fromEntries(
    TASK_STATUSES.map((status) => [status, "remember"]),
  ) as ListCollapseModes;
}

function isListCollapseMode(value: unknown): value is ListCollapseMode {
  return value === "always-expanded" || value === "remember" || value === "always-collapsed";
}

function readProjectListCollapseModes(projectId: string): ListCollapseModes {
  const modes = defaultListCollapseModes();
  try {
    const value = JSON.parse(
      panelStorage.getItem(`${PROJECT_LIST_COLLAPSE_MODES_KEY_PREFIX}${projectId}`) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return modes;
    for (const status of TASK_STATUSES) {
      if (isListCollapseMode(value[status])) modes[status] = value[status];
    }
  } catch {}
  return modes;
}

function writeProjectListCollapseModes(projectId: string, modes: ListCollapseModes) {
  panelStorage.setItem(
    `${PROJECT_LIST_COLLAPSE_MODES_KEY_PREFIX}${projectId}`,
    JSON.stringify(modes),
  );
}

function readProjectListCollapsedStatuses(projectId: string): TaskStatus[] {
  try {
    const value = JSON.parse(
      panelStorage.getItem(`${PROJECT_LIST_COLLAPSED_STATUSES_KEY_PREFIX}${projectId}`) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return TASK_STATUSES.filter((status) => value.includes(status));
  } catch {
    return [];
  }
}

function writeProjectListCollapsedStatuses(projectId: string, statuses: ReadonlySet<TaskStatus>) {
  panelStorage.setItem(
    `${PROJECT_LIST_COLLAPSED_STATUSES_KEY_PREFIX}${projectId}`,
    JSON.stringify(TASK_STATUSES.filter((status) => statuses.has(status))),
  );
}

function initialProjectListCollapsedStatuses(
  projectId: string,
  modes: ListCollapseModes,
): Set<TaskStatus> {
  const rememberedStatuses = new Set(readProjectListCollapsedStatuses(projectId));
  return new Set(TASK_STATUSES.filter((status) => (
    modes[status] === "always-collapsed"
    || (modes[status] === "remember" && rememberedStatuses.has(status))
  )));
}

function readProjectBoardDisplaySettings(): Record<string, BoardDisplaySettings> {
  try {
    const value = JSON.parse(panelStorage.getItem(PROJECT_BOARD_DISPLAY_SETTINGS_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readRecentProjectIds(): string[] {
  try {
    const value = JSON.parse(panelStorage.getItem(RECENT_PROJECT_IDS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((projectId): projectId is string => typeof projectId === "string" && projectId.length > 0)
      : [];
  } catch {
    return [];
  }
}

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.deleted",
  "task.relation.updated",
  "task.jira.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "project.labels.updated",
  "claim.updated",
  "automation.updated",
  "project.readme.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const query = new URL(document.baseURI).searchParams;
  const host = query.get("host");
  if (
    window.parent !== window
    && (host === "codex" || host === "workbuddy" || host === "deepseek-harness")
  ) {
    const fromQuery = query.get("theme");
    if (isTheme(fromQuery)) return fromQuery;
    const stored = panelStorage.getItem("panel.theme");
    if (isTheme(stored)) return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(panelStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectCodexIdentities(): Record<string, CodexProjectIdentity> {
  try {
    const value = JSON.parse(panelStorage.getItem(PROJECT_CODEX_IDENTITIES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, CodexProjectIdentity] => {
      const identity = entry[1] as Partial<CodexProjectIdentity> | null;
      return Boolean(
        identity
        && typeof identity.codexProjectId === "string"
        && (identity.codexProjectKind === "local" || identity.codexProjectKind === "remote")
        && typeof identity.codexHostId === "string"
        && typeof identity.workspacePath === "string",
      );
    }));
  } catch {
    return {};
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    developmentContext: task.developmentContext,
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

function latestAiChatHandoff(
  comments: Comment[],
  text: (chinese: string, english: string) => string,
): string | null {
  const comment = [...comments].reverse().find((candidate) => (
    candidate.body.startsWith(AI_CHAT_HANDOFF_COMMENT_MARKER)
  ));
  if (!comment) return null;
  const body = comment.body.slice(AI_CHAT_HANDOFF_COMMENT_MARKER.length).trim();
  return body.length <= NATIVE_HANDOFF_CONTEXT_LIMIT
    ? body
    : `${body.slice(0, NATIVE_HANDOFF_CONTEXT_LIMIT).trimEnd()}\n\n${text(
      "[交接内容已截断，请使用 panelctl 读取完整评论]",
      "[Conversation handoff truncated; use panelctl to read the full comment]",
    )}`;
}

function issueThreadInstruction(
  task: Task,
  handoff: string | null,
  text: (chinese: string, english: string) => string,
): string {
  return [
    text(
      `处理 Panel 议题 ${task.identifier}：${task.title}`,
      `Continue work on issue ${task.identifier}: ${task.title}`,
    ),
    text(
      `开始前，使用 panelctl 读取 ${task.identifier} 的最新议题内容和全部评论。将最新的“AI 对话交接”评论视为上一段 Codex 对话的交接信息；更新的议题内容或评论优先。`,
      `Before acting, use panelctl to read the latest issue content and every comment for ${task.identifier}. Treat the latest "AI conversation handoff" comment as the handoff from the prior Codex conversation; newer issue content or comments take precedence.`,
    ),
    handoff
      ? text(
          `最新对话交接，供立即参考：\n\n${handoff}`,
          `Latest conversation handoff for immediate context:\n\n${handoff}`,
        )
      : text(
          "当前没有记录对话交接。继续前请直接读取议题和评论。",
          "No conversation handoff is currently recorded. Read the issue and comments directly before proceeding.",
        ),
  ].join("\n\n");
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshAutomation: () => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setAiThreadsRevision: Dispatch<SetStateAction<number>>;
  setReadmeRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshAutomation,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setAiThreadsRevision,
  setReadmeRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource(resolvePanelUrl("/api/events"));
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string; project?: Project } = {};
      try {
        payload = JSON.parse(message.data) as {
          projectId?: string;
          taskId?: string;
          project?: Project;
        };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const eventProjectId = payload.projectId ?? payload.project?.id;
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (
          selectedProjectId === ALL_PROJECTS_ID
          || !eventProjectId
          || eventProjectId === selectedProjectId
        );
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type === "project.labels.updated") {
        setAiThreadsRevision((current) => current + 1);
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (event.type.startsWith("task.")) {
        setAiThreadsRevision((current) => current + 1);
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (event.type === "claim.updated" || event.type === "automation.updated") {
        if (affectsSelectedProject) {
          void refreshAutomation();
          scheduleRefresh({ tasks: event.type === "claim.updated" });
        }
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "project.readme.updated") {
        setReadmeRevision((current) => current + 1);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId && selectedProjectId !== ALL_PROJECTS_ID) {
        setReadmeRevision((current) => current + 1);
      }
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshAutomation,
    refreshTasks,
    selectedProjectId,
    setAttachmentsRevision,
    setAiThreadsRevision,
    setCommentsRevision,
    setConnection,
    setReadmeRevision,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URL(document.baseURI).searchParams, []);
  const host = query.get("host");
  const embedded = host === "codex" || host === "workbuddy" || host === "deepseek-harness";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const language = resolveTaskboardLanguage(
    hostContext?.language ?? query.get("lang") ?? navigator.language,
  );
  const { locale, text } = getTaskboardI18n(language);
  const [embeddedFrameChallenge, setEmbeddedFrameChallengeState] = useState("");
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [managePanelSkillPath, setManagePanelSkillPath] = useState("");
  const [panelMetadata, setPanelMetadata] = useState<PanelMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [aiImportReadyProjectId, setAiImportReadyProjectId] = useState<string | null>(null);
  const [aiThreads, setAiThreads] = useState<AiChatThread[]>([]);
  const [aiThreadsRevision, setAiThreadsRevision] = useState(0);
  const [aiOpenThreadRequest, setAiOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const [readActivityKeys, setReadActivityKeys] = useState<Record<string, string>>({});
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>
  >({});
  const [processingNow, setProcessingNow] = useState(() => Date.now());
  const [recentProjectIds, setRecentProjectIds] = useState(readRecentProjectIds);
  const initialProjectId = query.get("project") ?? recentProjectIds[0] ?? ALL_PROJECTS_ID;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<ProjectLoadError | null>(null);
  const [tasksLoadError, setTasksLoadError] = useState<TasksLoadError | null>(null);
  const loadError: LoadError | null = projectLoadError ?? tasksLoadError;
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const actionErrorText = actionError === null
    ? null
    : typeof actionError === "string"
      ? actionError
      : text(actionError[0], actionError[1]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [boardView, setBoardView] = useState<BoardView>(() => readProjectBoardView(initialProjectId));
  const [listLayout, setListLayout] = useState<ListLayout>(() => readProjectListLayout(initialProjectId));
  const [listCollapseModes, setListCollapseModes] = useState<ListCollapseModes>(
    () => readProjectListCollapseModes(initialProjectId),
  );
  const [listCollapsedStatuses, setListCollapsedStatuses] = useState<Set<TaskStatus>>(
    () => initialProjectListCollapsedStatuses(initialProjectId, listCollapseModes),
  );
  const [projectBoardDisplaySettings, setProjectBoardDisplaySettings] = useState(
    readProjectBoardDisplaySettings,
  );
  const [dashboardSummaryAnimatedProjectId, setDashboardSummaryAnimatedProjectId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = useState(false);
  const [ganttTodayRequest, setGanttTodayRequest] = useState(0);
  const [ganttViewMenuOpen, setGanttViewMenuOpen] = useState(false);
  const [otherTasksOpen, setOtherTasksOpen] = useState(false);
  const [otherTasksMounted, setOtherTasksMounted] = useState(false);
  const [otherTasksVisible, setOtherTasksVisible] = useState(false);
  const [otherTasksTab, setOtherTasksTab] = useState<OtherTaskTab>("backlog");
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [pendingArchivedTaskDelete, setPendingArchivedTaskDelete] = useState<Task | null>(null);
  const [deletingArchivedTaskId, setDeletingArchivedTaskId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [newTaskDraft, setNewTaskDraft] = useState<{
    projectId: string;
    targetProjectId: string | null;
    draft: NewTaskEditorDraft;
  } | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [readmeRevision, setReadmeRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(
    () => panelStorage.getItem(FIRST_USE_COMPLETE_KEY) === null,
  );
  const [projectMenuSearch, setProjectMenuSearch] = useState("");
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [jiraDialogOpen, setJiraDialogOpen] = useState(false);
  const [jiraConnection, setJiraConnection] = useState<JiraConnection | null>(null);
  const [jiraSaving, setJiraSaving] = useState(false);
  const [jiraSyncing, setJiraSyncing] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectChoice | null>(null);
  const [projectDeleteIssueCount, setProjectDeleteIssueCount] = useState<number | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectCodexIdentities, setProjectCodexIdentities] = useState(readProjectCodexIdentities);
  const [selectedProjectAutomation, setSelectedProjectAutomation] = useState<ProjectAutomationPolicy | null>(null);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const projectsRequestRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const boardColumnScrollRefs = useRef<Partial<Record<TaskStatus, HTMLElement | null>>>({});
  const detailSourceProjectIdRef = useRef<string | null>(null);
  const pendingDetailSourceScrollRef = useRef<DetailSourceScroll | null>(null);
  const taskScopeProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
  const taskScopeProjectIdRef = useRef(taskScopeProjectId);
  taskScopeProjectIdRef.current = taskScopeProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(panelMetadata);
  const revisionWebSocketConfig = getRevisionWebSocketConfig(panelMetadata);
  const revisionWebSocketEndpoint = revisionWebSocketConfig?.endpoint ?? null;
  const textRef = useRef(text);
  textRef.current = text;
  setApiText(text);
  function errorMessage(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof Error) return error.message;
    return textRef.current(
      "加载议题时出现问题。",
      "Something went wrong while loading your issues.",
    );
  }
  const pendingRemoteThreadClaimsRef = useRef(new Map<string, PendingRemoteThreadClaim>());
  const legacyAutomationPauseRequestsRef = useRef(new Set<string>());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const markDashboardSummaryAnimationStarted = useCallback((projectId: string) => {
    setDashboardSummaryAnimatedProjectId(projectId);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    if (projectId === GLOBAL_PROJECT_ID) return;
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      panelStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberProjectOpen = useCallback((projectId: string) => {
    setRecentProjectIds((current) => {
      if (current[0] === projectId) return current;
      const next = [projectId, ...current.filter((candidate) => candidate !== projectId)];
      panelStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const isAllProjects = selectedProjectId === ALL_PROJECTS_ID;
  const isJiraProject = selectedProject?.source === "jira";
  const boardDisplaySettings = projectBoardDisplaySettings[selectedProjectId]
    ?? DEFAULT_BOARD_DISPLAY_SETTINGS;
  const aiImportProjectId = hasLoadedTasks
    && tasks.length === 0
    && selectedProject
    && selectedProject.id !== GLOBAL_PROJECT_ID
    && !isJiraProject
    && localAiChatAvailable
      ? selectedProject.id
      : null;
  useEffect(() => {
    setAiImportReadyProjectId(null);
    if (!aiImportProjectId) return;
    const controller = new AbortController();
    void getAiChatCatalog(aiImportProjectId, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setAiImportReadyProjectId(aiImportProjectId);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [aiImportProjectId, selectedProject]);
  useLayoutEffect(() => {
    if (selectedProject) rememberProjectOpen(selectedProject.id);
  }, [rememberProjectOpen, selectedProject]);
  const currentUser = hostContext?.user ?? {
    ...DEFAULT_USER_ACTOR,
    name: text("本地用户", "Local user"),
  };
  const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID || isAllProjects
    ? undefined
    : deviceWorkspacePaths[selectedProjectId];
  const automationUnavailableReason = !selectedProject
    ? text("请先选择项目", "Select a project first")
    : panelMetadata?.mode === "cloud"
      ? text("自动执行仅支持本地任务面板", "Automatic execution is available on the local panel")
      : selectedProject.source === "jira"
        ? text("请在关联仓库项目中设置自动化", "Configure automation in a linked repository project")
        : null;
  const referenceTasks = useMemo(() => [...tasks, ...archivedTasks], [archivedTasks, tasks]);
  const detailTask = detailTaskIdentifier
    ? referenceTasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const contextMenuWorkspacePath = contextMenuTask
    ? deviceWorkspacePaths[contextMenuTask.projectId]
    : undefined;
  const availableLabels = isAllProjects
    ? [...new Set(projects.flatMap((project) => project.labels))]
    : selectedProject?.labels ?? [];
  const projectNames = useMemo(() => Object.fromEntries(projects.map((project) => [
    project.id,
    project.id === GLOBAL_PROJECT_ID ? text("全局", "Global") : project.name,
  ])), [projects, text]);
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("全局", "Global")
          : persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
        codexIdentity: project.workspacePath && project.projectKind && project.hostId
          ? {
              codexProjectId: project.id,
              codexProjectKind: project.projectKind,
              codexHostId: project.hostId,
              workspacePath: project.workspacePath,
            }
          : null,
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("全局", "Global")
          : project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        codexIdentity: projectCodexIdentities[project.id] ?? null,
      });
    }
    const recentOrder = new Map(recentProjectIds.map((projectId, index) => [projectId, index]));
    const sortedChoices = choices.sort((left, right) => (
      (recentOrder.get(left.id) ?? recentProjectIds.length)
      - (recentOrder.get(right.id) ?? recentProjectIds.length)
    ));
    return [
      ...sortedChoices.filter((project) => project.issueCount > 0),
      ...sortedChoices.filter((project) => project.issueCount === 0),
    ];
  }, [hostContext?.projects, projectCodexIdentities, projects, recentProjectIds, text]);
  const projectMenuCandidates = projectChoices.filter(
    (project) => project.id !== GLOBAL_PROJECT_ID || project.issueCount > 0,
  );
  const projectMenuNeedle = projectMenuSearch.trim().toLocaleLowerCase();
  const projectMenuChoices = projectMenuNeedle
    ? projectMenuCandidates.filter((project) => project.name.toLocaleLowerCase().includes(projectMenuNeedle))
    : projectMenuCandidates;
  const firstEmptyProjectId = projectMenuChoices.find((project) => project.issueCount === 0)?.id ?? null;
  const hasProjectsWithIssues = projectMenuChoices.some((project) => project.issueCount > 0);
  const editorProjectId = editor?.task?.projectId
    ?? editor?.projectId
    ?? (newTaskDraft?.projectId === selectedProjectId ? newTaskDraft.targetProjectId : undefined)
    ?? (isAllProjects ? GLOBAL_PROJECT_ID : selectedProjectId);
  const developmentEditorProjectId = isAllProjects && editor ? editorProjectId : null;
  const createTargetProjects = projectChoices.flatMap((choice) => {
    const project = projects.find((candidate) => candidate.id === choice.id);
    return project && project.source !== "jira"
      ? [{ id: choice.id, name: choice.name }]
      : [];
  });
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  function openTaskContextMenu(task: Task, position: { x: number; y: number }) {
    if (
      isAllProjects
      && (!embedded || window.parent === window)
      && task.developmentContext?.type === "worktree"
    ) {
      setDevelopmentScanLoading(true);
    }
    setContextMenu({ taskId: task.id, ...position });
  }
  const issueReadStorageKey = selectedProjectId
    ? `${ISSUE_READ_KEY_PREFIX}:${panelMetadata?.mode ?? "local"}:${selectedProjectId}`
    : null;

  useEffect(() => {
    let mountFrame = 0;
    let showFrame = 0;
    let closeTimer = 0;

    if (otherTasksOpen) {
      setOtherTasksMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        showFrame = window.requestAnimationFrame(() => setOtherTasksVisible(true));
      });
    } else {
      setOtherTasksVisible(false);
      closeTimer = window.setTimeout(() => setOtherTasksMounted(false), 320);
    }

    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(showFrame);
      window.clearTimeout(closeTimer);
    };
  }, [otherTasksOpen]);

  useEffect(() => {
    setReadActivityKeys(issueReadStorageKey ? readIssueActivityKeys(issueReadStorageKey) : {});
  }, [issueReadStorageKey]);

  const markTaskRead = useCallback((task: Task) => {
    if (!issueReadStorageKey || !task.activityKey) return;
    setReadActivityKeys((current) => {
      if (current[task.id] === task.activityKey) return current;
      const next = { ...current, [task.id]: task.activityKey };
      try {
        panelStorage.setItem(issueReadStorageKey, JSON.stringify(next));
      } catch {
        // Read state remains valid for this page even when browser persistence is unavailable.
      }
      return next;
    });
  }, [issueReadStorageKey]);

  useEffect(() => {
    if (detailTask) markTaskRead(detailTask);
  }, [detailTask?.activityKey, detailTask?.id, markTaskRead]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (!selectedProjectId || automationUnavailableReason) {
      setSelectedProjectAutomation(null);
      setAutomationError(null);
      return;
    }
    const projectId = selectedProjectId;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const policy = await getProjectAutomationPolicy(projectId);
      if (selectedProjectIdRef.current === projectId) setSelectedProjectAutomation(policy);
    } catch (error) {
      if (selectedProjectIdRef.current === projectId) {
        setAutomationError(error instanceof Error
          ? error.message
          : text("无法读取自动化状态", "Could not read the automation status."));
      }
    } finally {
      if (selectedProjectIdRef.current === projectId) setAutomationPending(false);
    }
  }, [
    automationUnavailableReason,
    selectedProjectId,
    text,
  ]);

  const saveProjectAutomation = useCallback(async (options: ProjectAutomationOptions) => {
    if (!selectedProject || automationUnavailableReason || automationPending) return;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      setSelectedProjectAutomation(await saveProjectAutomationPolicy(selectedProject.id, options));
    } catch (error) {
      setAutomationError(error instanceof Error
        ? error.message
        : text("无法更新自动化", "Could not update automation."));
    } finally {
      setAutomationPending(false);
    }
  }, [
    automationPending,
    automationUnavailableReason,
    selectedProject,
    text,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    if (task.projectId !== selectedProjectId) {
      setBoardView(readProjectBoardView(task.projectId));
      setListLayout(readProjectListLayout(task.projectId));
      const collapseModes = readProjectListCollapseModes(task.projectId);
      setListCollapseModes(collapseModes);
      setListCollapsedStatuses(initialProjectListCollapsedStatuses(task.projectId, collapseModes));
      setSelectedProjectId(task.projectId);
      setSearch("");
      setFilters(EMPTY_TASK_FILTERS);
      rememberProjectOpen(task.projectId);
      undoStackRef.current = [];
      setUndoNotice(null);
    }
    const fullTask = tasksRef.current.find((candidate) => candidate.identifier === task.identifier);
    if (fullTask) markTaskRead(fullTask);
    const currentIssue = readIssueIdentifier(window.location.search);
    if (!currentIssue) detailSourceProjectIdRef.current = selectedProjectId;
    if (isAllProjects) setSelectedProjectId(task.projectId);
    if (boardView === "list" && issueListRef.current) {
      pendingDetailSourceScrollRef.current = {
        projectId: selectedProjectId,
        view: "list",
        scrollLeft: issueListRef.current.scrollLeft,
        scrollTop: issueListRef.current.scrollTop,
      };
    } else if (boardView === "issues" && fullTask) {
      const scrollContainer = boardColumnScrollRefs.current[fullTask.status];
      if (scrollContainer) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "issues",
          status: fullTask.status,
          scrollTop: scrollContainer.scrollTop,
        };
      }
    }
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const boardUrl = buildIssueUrl(window.location.href, selectedProjectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    const sourceProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    if (sourceProjectId !== selectedProjectId) {
      setSelectedProjectId(sourceProjectId);
      setBoardView(sourceProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(sourceProjectId));
    }
    const url = buildIssueUrl(window.location.href, sourceProjectId, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useLayoutEffect(() => {
    if (detailTaskIdentifier) return;
    const pendingScroll = pendingDetailSourceScrollRef.current;
    if (!pendingScroll) return;
    if (pendingScroll.view !== boardView || pendingScroll.projectId !== selectedProjectId) {
      pendingDetailSourceScrollRef.current = null;
      return;
    }
    const scrollContainer = pendingScroll.view === "list"
      ? issueListRef.current
      : boardColumnScrollRefs.current[pendingScroll.status];
    pendingDetailSourceScrollRef.current = null;
    if (!scrollContainer) return;
    if (pendingScroll.view === "list") scrollContainer.scrollLeft = pendingScroll.scrollLeft;
    scrollContainer.scrollTop = pendingScroll.scrollTop;
  }, [boardView, detailTaskIdentifier, selectedProjectId]);

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? GLOBAL_PROJECT_ID;
      const routeIssueIdentifier = readIssueIdentifier(url.search);
      if (routeIssueIdentifier && boardView === "list" && issueListRef.current) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "list",
          scrollLeft: issueListRef.current.scrollLeft,
          scrollTop: issueListRef.current.scrollTop,
        };
      } else if (routeIssueIdentifier && boardView === "issues") {
        const routeTask = tasksRef.current.find(
          (task) => task.identifier === routeIssueIdentifier,
        );
        const scrollContainer = routeTask
          ? boardColumnScrollRefs.current[routeTask.status]
          : null;
        if (routeTask && scrollContainer) {
          pendingDetailSourceScrollRef.current = {
            projectId: selectedProjectId,
            view: "issues",
            status: routeTask.status,
            scrollTop: scrollContainer.scrollTop,
          };
        }
      }
      if (!routeIssueIdentifier) detailSourceProjectIdRef.current = null;
      setDetailTaskIdentifier(routeIssueIdentifier);
      if (routeProjectId === selectedProjectId) return;
      setBoardView(routeProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(routeProjectId));
      setListLayout(readProjectListLayout(routeProjectId));
      const collapseModes = readProjectListCollapseModes(routeProjectId);
      setListCollapseModes(collapseModes);
      setListCollapsedStatuses(initialProjectListCollapsedStatuses(routeProjectId, collapseModes));
      setSelectedProjectId(routeProjectId);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
  }, [embedded, theme]);

  useEffect(() => {
    if (embedded && window.parent !== window) return;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setTheme(systemTheme.matches ? "dark" : "light");
    syncTheme();
    systemTheme.addEventListener("change", syncTheme);
    return () => systemTheme.removeEventListener("change", syncTheme);
  }, [embedded]);

  useEffect(() => {
    if (selectedProjectId) {
      setBoardView(selectedProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(selectedProjectId));
      setListLayout(readProjectListLayout(selectedProjectId));
      const collapseModes = readProjectListCollapseModes(selectedProjectId);
      setListCollapseModes(collapseModes);
      setListCollapsedStatuses(initialProjectListCollapsedStatuses(selectedProjectId, collapseModes));
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDashboardSummaryAnimatedProjectId(null);
    } else if (boardView !== "dashboard") {
      setDashboardSummaryAnimatedProjectId(selectedProjectId);
    }
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (panelStorage.getItem(FIRST_USE_COMPLETE_KEY) === null) {
      panelStorage.setItem(FIRST_USE_COMPLETE_KEY, "true");
    }
  }, []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!projectContextMenu) return;
    function closeProjectContextMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-context-menu]")) setProjectContextMenu(null);
    }
    function closeProjectContextMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectContextMenu(null);
    }
    document.addEventListener("pointerdown", closeProjectContextMenu);
    window.addEventListener("keydown", closeProjectContextMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectContextMenu);
      window.removeEventListener("keydown", closeProjectContextMenuWithEscape);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    setSelectedProjectAutomation(null);
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || !embeddedFrameChallenge || !managePanelSkillPath) return;
    let records: Record<string, Record<string, unknown>>;
    try {
      const value = JSON.parse(panelStorage.getItem(LEGACY_PROJECT_AUTOMATIONS_KEY) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      records = value;
    } catch {
      return;
    }
    for (const [panelProjectId, record] of Object.entries(records)) {
      if (
        typeof record.automationId !== "string"
        || typeof record.codexProjectId !== "string"
        || (record.codexProjectKind !== "local" && record.codexProjectKind !== "remote")
        || typeof record.codexHostId !== "string"
        || typeof record.workspacePath !== "string"
      ) continue;
      if (legacyAutomationPauseRequestsRef.current.has(record.automationId)) continue;
      legacyAutomationPauseRequestsRef.current.add(record.automationId);
      postEmbeddedHostMessage({
        type: "panel:automation-request",
        payload: {
          requestId: window.crypto.randomUUID(),
          operation: "pause",
          panelProjectId,
          codexProjectId: record.codexProjectId,
          codexProjectKind: record.codexProjectKind,
          codexHostId: record.codexHostId,
          projectName: projects.find((project) => project.id === panelProjectId)?.name ?? panelProjectId,
          workspacePath: record.workspacePath,
          remoteProjects: [],
          skillPath: managePanelSkillPath,
          automationId: record.automationId,
          enabledByUser: false,
          quotaAware: false,
          intervalMinutes: [5, 10, 15, 30, 60].includes(Number(record.intervalMinutes))
            ? record.intervalMinutes
            : 5,
          model: typeof record.model === "string" ? record.model : "gpt-5.5",
          reasoningEffort: typeof record.reasoningEffort === "string"
            ? record.reasoningEffort
            : "high",
        },
      });
    }
  }, [embedded, embeddedFrameChallenge, managePanelSkillPath, projects]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    let acknowledgedFrameChallenge = "";

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "panel:frame-challenge") {
        const challenge = typeof message.payload === "object"
          && message.payload
          && "challenge" in message.payload
          && typeof message.payload.challenge === "string"
          ? message.payload.challenge
          : "";
        if (!challenge || challenge === acknowledgedFrameChallenge) return;
        acknowledgedFrameChallenge = challenge;
        setEmbeddedFrameChallenge(challenge);
        setEmbeddedFrameChallengeState(challenge);
        postEmbeddedHostMessage({ type: "panel:ready" });
        return;
      }

      if (message.type === "panel:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "panel:thread-prepared" && message.payload) {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "panel:thread-created" && message.payload) {
        const payload = message.payload as { taskId?: unknown; threadId?: unknown };
        if (typeof payload.taskId !== "string" || typeof payload.threadId !== "string") return;
        if (pendingRemoteThreadClaimsRef.current.has(payload.taskId)) {
          void bindPreparedRemoteThread(payload.taskId, payload.threadId);
          return;
        }
        const task = tasksRef.current.find((candidate) => candidate.id === payload.taskId);
        const threadId = payload.threadId.trim();
        if (
          !task
          || !threadId
          || task.threadBinding?.threadId === threadId
          || task.legacyLocalThreadId === threadId
        ) return;
        void updateTaskRequest(task, taskToDraft(task), threadId)
          .then((updated) => {
            setTasks((current) => sortTasks(current.map((candidate) => (
              candidate.id === updated.id ? updated : candidate
            ))));
            setAnnouncement(textRef.current(
              `${updated.identifier} 已关联到新 Codex 对话。`,
              `${updated.identifier} is linked to the new Codex conversation.`,
            ));
          })
          .catch((error) => {
            setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
              ? textRef.current(
                "新 Codex 对话已创建，但议题同时发生了变化，未能自动关联。",
                "The Codex conversation was created, but the issue changed concurrently and could not be linked automatically.",
              )
              : textRef.current(
                `新 Codex 对话已创建，但自动关联失败：${errorMessage(error)}`,
                `The Codex conversation was created, but automatic linking failed: ${errorMessage(error)}`,
              ));
          });
        return;
      }

      if (message.type === "panel:thread-create-error" && message.payload) {
        const payload = message.payload as {
          taskId?: unknown;
          error?: unknown;
          threadId?: unknown;
          uncertain?: unknown;
        };
        if (typeof payload.taskId === "string" && pendingRemoteThreadClaimsRef.current.has(payload.taskId)) {
          pendingRemoteThreadClaimsRef.current.delete(payload.taskId);
          setOpeningThreadTaskId(null);
          setActionError(typeof payload.error === "string"
            ? payload.error
            : textRef.current("无法在 Codex 中准备对话草稿。", "Could not prepare the Codex conversation draft."));
        } else {
          setOpeningThreadTaskId(null);
          setActionError(typeof payload.error === "string"
            ? payload.error
            : textRef.current("无法在 Codex 中创建对话。", "Could not create the conversation in Codex."));
        }
        return;
      }

      if (message.type === "panel:thread-open-error" && message.payload) {
        const payload = message.payload as { error?: unknown };
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法打开 Codex 对话。", "Could not open the Codex conversation."));
        return;
      }

      if (message.type !== "panel:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
      if (host === "codex") void publishHostRuntime(payload);
    }

    const removeExternalLinkHandler = installEmbeddedExternalLinkHandler();
    window.addEventListener("message", receiveHostMessage);
    postEmbeddedHostMessage({ type: "panel:frame-awaiting-challenge" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      setEmbeddedFrameChallenge("");
      removeExternalLinkHandler();
    };
  }, [embedded, host]);

  useEffect(() => {
    if (host !== "workbuddy") return;
    let disposed = false;
    const syncRuntime = async () => {
      try {
        const runtime = await getHostRuntime();
        if (!disposed) setHostContext(runtime);
      } catch {}
    };
    void syncRuntime();
    const timer = window.setInterval(syncRuntime, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [host]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      postEmbeddedHostMessage({
        type: "panel:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      postEmbeddedHostMessage({ type: "panel:drag-region", payload: null });
    };
  }, [detailTaskId, embedded, embeddedFrameChallenge, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "initial" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getPanelMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      const [nextJiraConnection, nextTemporaryTasks] = await Promise.all([
        getJiraConnection(signal),
        listTasks(GLOBAL_PROJECT_ID, signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setPanelMetadata((current) => (
        current
        && current.mode === metadata.mode
        && JSON.stringify(current.realtime) === JSON.stringify(metadata.realtime)
        && current.managePanelSkillPath === metadata.managePanelSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManagePanelSkillPath(metadata.managePanelSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        delete next[GLOBAL_PROJECT_ID];
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        panelStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setJiraConnection(nextJiraConnection);
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        if (fromQuery === ALL_PROJECTS_ID) return fromQuery;
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current === ALL_PROJECTS_ID) return current;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        return nextProjects.find((project) => project.id === GLOBAL_PROJECT_ID)?.id
          ?? nextProjects[0]?.id
          ?? GLOBAL_PROJECT_ID;
      });
      setProjectLoadError((current) => (
        current?.operation === "initial" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "initial",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "refresh" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, nextTemporaryTasks] = await Promise.all([
        listProjects(),
        listTasks(GLOBAL_PROJECT_ID),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setProjectLoadError((current) => (
        current?.operation === "refresh" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if (requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "refresh",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setTasksLoadError((current) => (
      current ? { ...current, requestId } : current
    ));
    try {
      const taskProjectId = projectId === ALL_PROJECTS_ID ? undefined : projectId;
      const [nextTasks, nextArchivedTasks] = await Promise.all([
        listTasks(taskProjectId, options.signal),
        listArchivedTasks(taskProjectId, options.signal),
      ]);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setArchivedTasks(sortTasks(nextArchivedTasks));
      setProjects((current) => current.map((project) => {
        if (project.id !== projectId || project.source !== "jira") return project;
        const labels = [...new Set(nextTasks.flatMap((task) => task.labels))];
        return JSON.stringify(labels) === JSON.stringify(project.labels)
          ? project
          : { ...project, labels };
      }));
      setHasLoadedTasks(true);
      setTasksLoadError((current) => (
        current?.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setTasksLoadError({ source: "tasks", requestId, message: errorMessage(error) });
      }
    } finally {
      if (projectId === JIRA_PROJECT_ID) {
        try {
          const connection = await getJiraConnection(options.signal);
          if (requestId === tasksRequestRef.current) setJiraConnection(connection);
        } catch {
          // The task request already exposes the actionable sync failure.
        }
      }
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!taskScopeProjectId) {
      setTasks([]);
      setArchivedTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(taskScopeProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    const isAllProjectTaskScope = taskScopeProjectId === ALL_PROJECTS_ID;
    if ((!isJiraProject && !(isAllProjectTaskScope && jiraConnection?.configured)) || !taskScopeProjectId) return;
    const timer = window.setInterval(() => {
      void refreshTasks(taskScopeProjectId, { quiet: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [isJiraProject, jiraConnection?.configured, refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    const standalone = !embedded || window.parent === window;
    const developmentProjectId = isAllProjects
      ? developmentEditorProjectId ?? (standalone ? contextMenuTask?.projectId : null)
      : selectedProjectId;
    if (!developmentProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      setDevelopmentScanLoading(false);
      return;
    }
    const controller = new AbortController();
    const codexProjectId = developmentProjectId === GLOBAL_PROJECT_ID
      ? hostContext?.projectId
      : developmentProjectId;
    const codexThreadId = hostContext?.threadId
      ?? (isAllProjects ? contextMenuTask?.threadId : detailTask?.threadId)
      ?? undefined;
    const workspacePath = isAllProjects
      ? developmentEditorProjectId
        ? deviceWorkspacePaths[developmentEditorProjectId]
        : contextMenuWorkspacePath
      : selectedDeviceWorkspacePath;
    setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      developmentProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      workspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(developmentProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    contextMenuTask?.projectId,
    contextMenuTask?.threadId,
    contextMenuWorkspacePath,
    detailTask?.threadId,
    deviceWorkspacePaths,
    developmentEditorProjectId,
    embedded,
    hostContext?.projectId,
    hostContext?.threadId,
    isAllProjects,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  const invalidateCloudData = useCallback(() => {
    void refreshProjectList();
    const projectId = taskScopeProjectIdRef.current;
    if (projectId) {
      void refreshTasks(projectId, { quiet: true });
    }
    setReadmeRevision((current) => current + 1);
    setCommentsRevision((current) => current + 1);
    setAttachmentsRevision((current) => current + 1);
  }, [refreshProjectList, refreshTasks]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getPanelRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: invalidateCloudData,
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    invalidateCloudData,
  ]);

  useEffect(() => {
    if (revisionWebSocketEndpoint === null) return;
    const controller = new AbortController();
    const client = createRevisionWebSocketClient({
      url: resolvePanelWebSocketUrl(revisionWebSocketEndpoint),
      fetchRevision: (since: number) => getPanelRevision(since, controller.signal),
      onInvalidate: invalidateCloudData,
      onConnectionChange: setConnection,
    });
    client.start();
    return () => {
      controller.abort();
      client.stop();
    };
  }, [
    invalidateCloudData,
    revisionWebSocketEndpoint,
  ]);

  function pushUndo(message: string | null, undo: () => Promise<void>) {
    const operation = { id: ++undoSequenceRef.current, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    if (!message) return;
    setAnnouncementValue("");
    setUndoNotice({ id: operation.id, message });
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(text(
        `无法撤回这次操作：${errorMessage(error)}`,
        `Could not undo this action: ${errorMessage(error)}`,
      ));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && !isJiraProject
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "todo" });
      }
      if (
        event.key === "/"
        && !detailTaskId
        && selectedProjectId
        && (boardView === "issues" || boardView === "list" || boardView === "gantt")
      ) {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, isJiraProject, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
    );
  }, [filters, language, search, tasks]);

  const filteredArchivedTasks = useMemo(() => archivedTasks.filter(
    (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
  ), [archivedTasks, filters, language, search]);

  const activeFilterCount = taskFilterCount(filters);
  const hasActiveTaskFilters = Boolean(search.trim()) || activeFilterCount > 0;

  const trackedCodexThreadIds = useMemo(() => [...new Set(tasks
    .filter((task) => task.status === "in_progress" && task.threadId)
    .map((task) => normalizeCodexThreadId(task.threadId))
    .filter(Boolean))].sort(), [tasks]);
  const trackedCodexThreadIdsKey = trackedCodexThreadIds.join(",");

  useEffect(() => {
    if (trackedCodexThreadIds.length === 0) {
      setCodexThreadProgress({});
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        const progress = await getCodexThreadProgress(trackedCodexThreadIds);
        if (!disposed) {
          setCodexThreadProgress((current) => (
            JSON.stringify(current) === JSON.stringify(progress) ? current : progress
          ));
        }
      } catch {}
    };
    void sync();
    const timer = window.setInterval(sync, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [trackedCodexThreadIdsKey]);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const mainBoardItems = boardDisplaySettings.mainStatuses;
  const mainColumnCount = Math.max(mainBoardItems.length, 1);
  const mainBoardMinWidth = (mainColumnCount * 300) + ((mainColumnCount - 1) * 24);
  const mainBoardMaxWidth = (mainColumnCount * 400) + ((mainColumnCount - 1) * 24);
  const otherTasksColumnCount = mainColumnCount + 1;
  const otherTasksWidth = `clamp(300px, calc(${100 / otherTasksColumnCount}% - ${(36 + (mainColumnCount * 24)) / otherTasksColumnCount}px), 400px)`;
  const otherTaskTabs = boardDisplaySettings.sidebarStatuses;
  const otherTaskTabsKey = otherTaskTabs.join(",");
  const otherTasksAvailable = otherTaskTabs.length > 0;

  useEffect(() => {
    if (!otherTasksAvailable) {
      setOtherTasksOpen(false);
      return;
    }
    if (otherTaskTabs.includes(otherTasksTab)) return;
    setOtherTasksTab(otherTaskTabs[0]);
  }, [otherTaskTabsKey, otherTasksAvailable, otherTasksTab]);

  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const unread = (task.status === "in_review" || task.status === "blocked")
      && readActivityKeys[task.id] !== task.activityKey;
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    const taskThreadId = normalizeCodexThreadId(task.threadId);
    return [task.id, taskCardPresentation(
      task,
      aiThreads,
      unread,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
      taskThreadId ? codexThreadProgress[taskThreadId] ?? null : undefined,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreads,
    codexThreadProgress,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    readActivityKeys,
    tasks,
  ]);
  const hasRunningTask = useMemo(
    () => Object.values(taskPresentations).some((presentation) => presentation.processing.running),
    [taskPresentations],
  );

  useEffect(() => {
    setProcessingNow(Date.now());
    if (!hasRunningTask) return;
    const timer = window.setInterval(() => setProcessingNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);


  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setGanttViewMenuOpen(false);
    if (detailTaskIdentifier) closeTaskDetail();
    if (view === "list" && boardView !== "list" && selectedProjectId) {
      const collapseModes = readProjectListCollapseModes(selectedProjectId);
      setListCollapseModes(collapseModes);
      setListCollapsedStatuses(initialProjectListCollapsedStatuses(selectedProjectId, collapseModes));
    }
    setBoardView(view);
    if (selectedProjectId) {
      panelStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${selectedProjectId}`, view);
    }
  }

  function selectListLayout(layout: ListLayout) {
    setListLayout(layout);
    if (selectedProjectId) {
      panelStorage.setItem(`${PROJECT_LIST_LAYOUT_KEY_PREFIX}${selectedProjectId}`, layout);
    }
  }

  function selectListCollapseMode(status: TaskStatus, mode: ListCollapseMode) {
    if (!selectedProjectId) return;
    setListCollapseModes((current) => {
      const next = { ...current, [status]: mode };
      writeProjectListCollapseModes(selectedProjectId, next);
      return next;
    });
    setListCollapsedStatuses((current) => {
      const next = new Set(current);
      if (mode === "always-expanded") next.delete(status);
      else if (mode === "always-collapsed") next.add(status);
      else writeProjectListCollapsedStatuses(selectedProjectId, next);
      return next;
    });
  }

  function updateProjectBoardDisplaySettings(value: BoardDisplaySettings) {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current, [selectedProjectId]: value };
      panelStorage.setItem(PROJECT_BOARD_DISPLAY_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function toggleListStatus(status: TaskStatus) {
    setListCollapsedStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      if (listCollapseModes[status] === "remember" && selectedProjectId) {
        writeProjectListCollapsedStatuses(selectedProjectId, next);
      }
      return next;
    });
  }

  function resetProjectBoardDisplaySettings() {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current };
      delete next[selectedProjectId];
      panelStorage.setItem(PROJECT_BOARD_DISPLAY_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) {
    if (!selectedProjectId || !editor) return;
    const targetProjectId = editorProjectId ?? selectedProjectId;
    setActionError(null);
    const creating = editor.task === null;
    let saved: Task;
    try {
      saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(targetProjectId, draft);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(taskScopeProjectId, { quiet: true });
      }
      throw error;
    }
    if (creating) {
      setProjects((current) => current.map((project) => (
        project.id === targetProjectId
          ? { ...project, issueCount: project.issueCount + 1 }
          : project
      )));
    }
    let failedAttachments = 0;
    let postCreateWriteFailed = false;
    if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
      const [results, inlineResults] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file, "attachment")),
          ),
          Promise.allSettled(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file, "inline")),
          ),
      ]);
      failedAttachments = results.filter((result) => result.status === "rejected").length;
      const inlineAttachments = inlineResults.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      if (inlineAttachments.length !== inlineImages.length) {
        postCreateWriteFailed = true;
      } else if (inlineImages.length > 0) {
        try {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        } catch {
          postCreateWriteFailed = true;
        }
      }
    }
    const relationUpdates = new Map<string, Task>();
    const movedSubIssues: Array<{ task: Task; previousParentId: string | null }> = [];
    let addedParentId: string | null = null;
    const addedRelatedIds: string[] = [];
    let relationWriteFailed = false;
    if (creating && createOptions) {
      const { parentId, relatedIds, subIssueIds } = createOptions.relations;
      try {
        if (parentId) {
          const result = await addTaskRelation(saved, "parent", parentId);
          saved = result.task;
          addedParentId = parentId;
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const relatedId of relatedIds) {
          const result = await addTaskRelation(saved, "related", relatedId);
          saved = result.task;
          addedRelatedIds.push(relatedId);
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const subIssueId of subIssueIds) {
          const child = relationUpdates.get(subIssueId)
            ?? tasksRef.current.find((candidate) => candidate.id === subIssueId)!;
          const previousParentId = child.relations.parent?.id ?? null;
          const result = await addTaskRelation(child, "parent", saved.id);
          movedSubIssues.push({ task: result.task, previousParentId });
          relationUpdates.set(result.task.id, result.task);
          saved = result.relatedTask;
        }
      } catch {
        relationWriteFailed = true;
      }
    }
    relationUpdates.set(saved.id, saved);
    setTasks((current) => sortTasks([
      ...current.filter((task) => !relationUpdates.has(task.id)),
      ...relationUpdates.values(),
    ]));
    if (creating) setNewTaskDraft(null);
    const failedWrites = [
      ...(relationWriteFailed ? [{ zh: "关系", en: "relations" }] : []),
      ...(postCreateWriteFailed ? [{ zh: "正文或图片", en: "description or images" }] : []),
      ...(failedAttachments > 0 ? [{
        zh: `${failedAttachments} 个附件`,
        en: `${failedAttachments} attachment${failedAttachments === 1 ? "" : "s"}`,
      }] : []),
    ];
    if (!creating || !createOptions?.keepOpen || failedWrites.length > 0) setEditor(null);
    if (failedWrites.length > 0) {
      setActionError(text(
        `${saved.identifier} 已创建，但以下内容写入失败：${failedWrites.map((failure) => failure.zh).join("、")}。`,
        `${saved.identifier} was created, but these follow-up writes failed: ${failedWrites.map((failure) => failure.en).join(", ")}.`,
      ));
    }
    if (creating) {
      pushUndo(null, async () => {
        const restoredRelations = new Map<string, Task>();
        const candidate = tasksRef.current.find((task) => task.id === saved.id);
        let current = candidate && candidate.version >= saved.version ? candidate : saved;
        if (addedParentId) {
          const result = await removeTaskRelation(current, "parent", addedParentId);
          current = result.task;
          restoredRelations.set(result.relatedTask.id, result.relatedTask);
        }
        for (const relatedId of [...addedRelatedIds].reverse()) {
          const result = await removeTaskRelation(current, "related", relatedId);
          current = result.task;
          restoredRelations.set(result.relatedTask.id, result.relatedTask);
        }
        for (const movedSubIssue of [...movedSubIssues].reverse()) {
          const latestChild = tasksRef.current.find((task) => task.id === movedSubIssue.task.id);
          const child = latestChild && latestChild.version >= movedSubIssue.task.version
            ? latestChild
            : movedSubIssue.task;
          const removed = await removeTaskRelation(child, "parent", saved.id);
          restoredRelations.set(removed.task.id, removed.task);
          current = removed.relatedTask;
          if (movedSubIssue.previousParentId) {
            const restored = await addTaskRelation(
              removed.task,
              "parent",
              movedSubIssue.previousParentId,
            );
            restoredRelations.set(restored.task.id, restored.task);
            restoredRelations.set(restored.relatedTask.id, restored.relatedTask);
          }
        }
        await archiveTaskRequest(current);
        setTasks((tasks) => sortTasks([
          ...tasks.filter((task) => task.id !== saved.id && !restoredRelations.has(task.id)),
          ...[...restoredRelations.values()].filter((task) => task.id !== saved.id),
        ]));
      });
    } else if (editor.task) {
      const previous = editor.task;
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!draft.assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          null,
          () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
        );
      }
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    useDropPosition = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => (
      candidate.projectId === task.projectId
      && candidate.status === status
      && candidate.id !== task.id
    ));
    const statusChanged = task.status !== status;
    const insertionIndex = statusChanged && !useDropPosition
      ? 0
      : beforeTaskId
        ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
        : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status
    ));
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      pushUndo(null, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      });
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function startTaskDrag(task: Task, height: number) {
    setDraggedTaskId(task.id);
    setDraggedTaskHeight(height);
    setDropTarget(task.status);
  }

  function endTaskDrag() {
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskUpdate>): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const projectChanged = typeof changes.projectId === "string"
      && changes.projectId !== task.projectId;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    const optimisticParticipants = assigneeTarget
      && !task.participants.some((participant) => actorKey(participant) === actorKey(optimisticAssignee))
      ? [...task.participants, optimisticAssignee]
      : task.participants;
    setActionError(null);
    if (!projectChanged) {
      setTasks((current) => current.map((candidate) =>
        candidate.id === task.id
          ? { ...candidate, ...taskChanges, assignee: optimisticAssignee, participants: optimisticParticipants }
          : candidate,
      ));
    }

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      if (projectChanged) {
        setTasks([updated]);
        setSelectedProjectId(updated.projectId);
        setBoardView(readProjectBoardView(updated.projectId));
        setListLayout(readProjectListLayout(updated.projectId));
        const collapseModes = readProjectListCollapseModes(updated.projectId);
        setListCollapseModes(collapseModes);
        setListCollapsedStatuses(initialProjectListCollapsedStatuses(updated.projectId, collapseModes));
        setDetailTaskIdentifier(updated.identifier);
        setSearch("");
        setFilters(EMPTY_TASK_FILTERS);
        rememberProjectOpen(updated.projectId);
        undoStackRef.current = [];
        setUndoNotice(null);
        window.history.replaceState(
          window.history.state,
          "",
          buildIssueUrl(window.location.href, updated.projectId, updated.identifier),
        );
        void refreshProjectList();
        return updated;
      }
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          null,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      throw error;
    }
  }

  async function persistProjectLabel(label: string, projectId = selectedProjectId) {
    setActionError(null);
    try {
      const project = await createProjectLabelRequest(projectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function removeProjectLabel(label: string) {
    setActionError(null);
    try {
      const project = await deleteProjectLabelRequest(selectedProjectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
      await refreshTasks(taskScopeProjectId, { quiet: true });
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId, undefined, origin)
        : await removeTaskRelation(task, type, relatedTaskId, undefined, origin);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(text(
        `${duplicated.identifier} 副本已创建。`,
        `${duplicated.identifier} copy was created.`,
      ), async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setArchivedTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== archived.id),
        archived,
      ]));
      pushUndo(text(`${task.identifier} 已归档。`, `${task.identifier} was archived.`), async () => {
        const restored = await restoreTaskRequest(archived);
        setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    }
  }

  async function restoreArchivedTask(task: Task) {
    setActionError(null);
    setRestoringTaskId(task.id);
    try {
      const restored = await restoreTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      setAnnouncement(text(
        `${restored.identifier} 已恢复。`,
        `${restored.identifier} was restored.`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setRestoringTaskId(null);
    }
  }

  async function deletePendingArchivedTask() {
    if (!pendingArchivedTaskDelete || deletingArchivedTaskId) return;
    const task = pendingArchivedTaskDelete;
    setActionError(null);
    setDeletingArchivedTaskId(task.id);
    try {
      await deleteArchivedTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setPendingArchivedTaskDelete(null);
      setAnnouncement(text(
        `${task.identifier} 已永久删除。`,
        `${task.identifier} was permanently deleted.`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setDeletingArchivedTaskId(null);
    }
  }

  async function copyText(content: string, message: string) {
    try {
      await navigator.clipboard.writeText(content);
      setAnnouncement(message);
    } catch {
      setActionError(text("无法写入剪贴板。", "Could not write to the clipboard."));
    }
  }

  function codexProjectContextForTaskProject(panelProjectId: string) {
    const panelProject = projects.find((project) => project.id === panelProjectId);
    const savedIdentity = projectCodexIdentities[panelProjectId];
    if (savedIdentity?.codexProjectKind === "remote") {
      const liveProject = hostContext?.projects?.find(
        (project) => project.id === savedIdentity.codexProjectId,
      );
      return liveProject?.projectKind === "remote"
        && liveProject.hostId === savedIdentity.codexHostId
        && liveProject.workspacePath === savedIdentity.workspacePath
        ? savedIdentity
        : null;
    }
    const effectiveCodexProjectId = panelProjectId === GLOBAL_PROJECT_ID
      ? hostContext?.projectId
      : panelProjectId;
    const directCodexProject = hostContext?.projects?.find(
      (project) => project.id === effectiveCodexProjectId,
    );
    const mappedWorkspacePath = panelProjectId === GLOBAL_PROJECT_ID
      ? directCodexProject?.workspacePath ?? hostContext?.workspacePath
      : deviceWorkspacePaths[panelProjectId]
        ?? panelProject?.workspacePath
        ?? directCodexProject?.workspacePath;
    const codexProject = directCodexProject ?? hostContext?.projects?.find(
      (project) => project.workspacePath === mappedWorkspacePath,
    );
    if (!codexProject) return null;
    return {
      codexProjectId: codexProject.id,
      codexProjectKind: codexProject.projectKind ?? "local" as const,
      codexHostId: codexProject.hostId ?? "local",
      workspacePath: mappedWorkspacePath ?? codexProject.workspacePath,
    };
  }

  function openThread(binding: CodexThreadBinding) {
    const remoteProject = binding.codexProjectKind === "remote"
      ? hostContext?.projects?.find((project) => (
          project.id === binding.codexProjectId
          && project.projectKind === "remote"
          && project.hostId === binding.codexHostId
          && project.workspacePath === binding.workspacePath
        ))
      : null;
    if (binding.codexProjectKind === "remote" && !remoteProject) {
      setActionError(text(
        "该对话绑定的 SSH 远程项目或主机当前不可用。",
        "The SSH remote project or host bound to this conversation is not available.",
      ));
      return;
    }
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "panel:open-thread",
        payload: binding,
      });
      return;
    }

    if (binding.codexProjectKind === "remote") {
      setActionError(text(
        "请在 Codex App 中打开该 SSH 远程对话。",
        "Open this SSH remote conversation in the Codex app.",
      ));
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(binding.threadId.trim())}`);
  }

  function openLegacyLocalThread(threadId: string) {
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "panel:open-thread",
        payload: { threadId, legacyLocal: true },
      });
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      setAiOpenThreadRequest((current) => ({
        threadId: conversation.aiThreadId!,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return;
    }
    if (conversation.threadBinding) {
      openThread(conversation.threadBinding);
    } else if (conversation.legacyLocalThreadId) {
      openLegacyLocalThread(conversation.legacyLocalThreadId);
    }
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    postEmbeddedHostMessage({ type: "panel:expand-sidebar" });
  }

  function remoteIdentityForTask(
    task: Task,
    baseIdentity: CodexProjectIdentity,
  ): CodexProjectIdentity | null {
    if (task.developmentContext?.type === "worktree") {
      const worktreePath = task.developmentContext.path;
      const matches = (hostContext?.projects ?? []).filter((project) => (
        project.projectKind === "remote"
        && project.hostId === baseIdentity.codexHostId
        && project.workspacePath === worktreePath
      ));
      if (matches.length !== 1) return null;
      return {
        codexProjectId: matches[0].id,
        codexProjectKind: "remote",
        codexHostId: matches[0].hostId!,
        workspacePath: matches[0].workspacePath!,
      };
    }
    const liveProject = hostContext?.projects?.find((project) => (
      project.id === baseIdentity.codexProjectId
      && project.projectKind === "remote"
      && project.hostId === baseIdentity.codexHostId
      && project.workspacePath === baseIdentity.workspacePath
    ));
    return liveProject ? baseIdentity : null;
  }

  function remoteTaskInstruction(
    task: Task,
    comments: Comment[],
    text: (chinese: string, english: string) => string,
  ) {
    const commentText = comments.length === 0
      ? text("（无评论）", "(No comments)")
      : comments.map((comment) => (
          `- ${comment.authorName} (${comment.createdAt})\n${comment.body}`
        )).join("\n\n");
    return [
      text(
        `处理 Panel 议题 ${task.identifier}：${task.title}`,
        `Continue work on Panel issue ${task.identifier}: ${task.title}`,
      ),
      text(
        "发送这份草稿后，Panel 才会认领议题并绑定新的 SSH 对话。远程 worker 不得运行 panelctl；请使用下方快照完成实现和必要验证。",
        "Panel claims the issue and binds the new SSH conversation only after this draft is sent. The remote worker must not run panelctl; use the snapshot below to implement and verify the issue.",
      ),
      text("完整描述：", "Full description:")
        + `\n${task.description || text("（无描述）", "(No description)")}`,
      `${text("全部评论：", "All comments:")}\n${commentText}`,
      `${text("开发上下文：", "Development context:")}\n${JSON.stringify(task.developmentContext)}`,
      text(
        "请返回改动、验证结果、执行结果和剩余风险。",
        "Return the changes, verification results, execution outcome, and remaining risks.",
      ),
    ].join("\n");
  }

  function updateTaskFromRemoteThread(task: Task) {
    setTasks((current) => sortTasks(current.map((candidate) => (
      candidate.id === task.id ? task : candidate
    ))));
  }

  async function addRemoteThreadFailureComment(taskId: string, body: string) {
    try {
      await createComment(taskId, body, undefined, null);
      setCommentsRevision((current) => current + 1);
    } catch {}
  }

  async function bindPreparedRemoteThread(taskId: string, rawThreadId: unknown) {
    const pending = pendingRemoteThreadClaimsRef.current.get(taskId);
    if (!pending) return;
    const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
    if (!threadId) {
      pendingRemoteThreadClaimsRef.current.delete(taskId);
      setOpeningThreadTaskId(null);
      setActionError(textRef.current(
        "Codex 没有返回新对话 ID。",
        "Codex did not return the new conversation ID.",
      ));
      return;
    }
    const binding: CodexThreadBinding = { threadId, ...pending.identity };
    try {
      const latestTask = await getTask(taskId);
      if (
        latestTask.status !== "todo"
        || latestTask.archivedAt !== null
        || latestTask.threadId
        || latestTask.threadBinding
        || latestTask.projectId !== pending.projectId
        || JSON.stringify(latestTask.developmentContext) !== pending.developmentContext
      ) {
        throw new Error(textRef.current(
          "SSH 对话已创建，但议题已在其他位置认领或绑定，未覆盖该更新。",
          "The SSH conversation was created, but the issue was claimed or bound elsewhere. That update was not overwritten.",
        ));
      }
      const boundTask = await moveTaskRequest(
        latestTask,
        "in_progress",
        latestTask.sortOrder,
        binding,
      );
      pendingRemoteThreadClaimsRef.current.delete(taskId);
      updateTaskFromRemoteThread(boundTask);
      setOpeningThreadTaskId(null);
      setAnnouncement(textRef.current(
        `${boundTask.identifier} 已绑定到新的 SSH 对话。`,
        `${boundTask.identifier} is bound to the new SSH conversation.`,
      ));
    } catch (error) {
      pendingRemoteThreadClaimsRef.current.delete(taskId);
      setOpeningThreadTaskId(null);
      await addRemoteThreadFailureComment(taskId, textRef.current(
        `已创建 SSH 对话 ${threadId}，但认领或 binding 写入发生冲突或失败；未覆盖其他控制端的更新。`,
        `SSH conversation ${threadId} was created, but claiming the issue or saving its binding conflicted or failed. No other controller update was overwritten.`,
      ));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          `SSH 对话 ${threadId} 已创建，但议题已在其他位置更新，未覆盖该更新。`,
          `SSH conversation ${threadId} was created, but the issue changed elsewhere. That update was not overwritten.`,
        )
        : errorMessage(error));
    }
  }

  async function openRemoteTaskInThread(task: Task, baseIdentity: CodexProjectIdentity) {
    try {
      const [latestTask, comments] = await Promise.all([getTask(task.id), listComments(task.id)]);
      if (latestTask.threadBinding) {
        setOpeningThreadTaskId(null);
        openThread(latestTask.threadBinding);
        return;
      }
      if (latestTask.status !== "todo" || latestTask.archivedAt !== null || latestTask.threadId) {
        throw new Error(textRef.current(
          "该议题已被其他控制器认领或绑定，请刷新后重试。",
          "This issue was claimed or bound by another controller. Refresh and try again.",
        ));
      }
      const identity = remoteIdentityForTask(latestTask, baseIdentity);
      if (!identity) {
        throw new Error(latestTask.developmentContext?.type === "worktree"
          ? textRef.current(
            "目标 SSH worktree 未在保存的主机中添加或映射。",
            "The target SSH worktree is not added or mapped on the saved host.",
          )
          : textRef.current(
            "已保存的 SSH 远程项目或主机当前不可用。",
            "The saved SSH remote project or host is not available.",
          ));
      }
      pendingRemoteThreadClaimsRef.current.set(task.id, {
        identity,
        projectId: latestTask.projectId,
        developmentContext: JSON.stringify(latestTask.developmentContext),
      });
      postEmbeddedHostMessage({
        type: "panel:create-thread",
        payload: {
          taskId: latestTask.id,
          identifier: latestTask.identifier,
          title: latestTask.title,
          instruction: remoteTaskInstruction(latestTask, comments, textRef.current),
          codexProjectId: identity.codexProjectId,
          codexProjectKind: identity.codexProjectKind,
          codexHostId: identity.codexHostId,
          codexProjectWorkspacePath: identity.workspacePath,
          workspacePath: identity.workspacePath,
        },
      });
    } catch (error) {
      setOpeningThreadTaskId(null);
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "该议题已在其他位置更新，未创建重复对话。",
          "This issue changed elsewhere. No duplicate conversation was created.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }
  async function openTaskInThread(task: Task) {
    const taskProject = projects.find((project) => project.id === task.projectId);
    const savedRemoteIdentity = projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      ? projectCodexIdentities[task.projectId]
      : null;
    let codexProjectContext = savedRemoteIdentity
      ?? codexProjectContextForTaskProject(task.projectId);
    if (
      projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      && !codexProjectContext
    ) {
      setActionError(text(
        "已保存的 SSH 远程项目或主机当前不可用。",
        "The saved SSH remote project or host is not available.",
      ));
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : undefined;
    const workspacePath = worktreePath
      ?? codexProjectContext?.workspacePath
      ?? deviceWorkspacePaths[task.projectId]
      ?? taskProject?.workspacePath
      ?? (
        taskProject?.id === GLOBAL_PROJECT_ID
        || hostContext?.projectId === taskProject?.id
          ? hostContext?.workspacePath
          : undefined
      );
    if (codexProjectContext?.codexProjectKind === "remote" && codexProjectContext.workspacePath) {
      if (!embedded || window.parent === window) {
        setActionError(text(
          "请在 Codex App 中打开 SSH 远程议题对话。",
          "Open SSH remote issue conversations in the Codex app.",
        ));
        return;
      }
      if (openingThreadTaskId) return;
      setOpeningThreadTaskId(task.id);
      setActionError(null);
      void openRemoteTaskInThread(task, {
        ...codexProjectContext,
        workspacePath: codexProjectContext.workspacePath,
      });
      return;
    }

    if (!managePanelSkillPath) {
      setActionError(text(
        "任务面板还没有读取到 manage-panel Skill 路径，请刷新后重试。",
        "Panel has not received the manage-panel Skill path. Refresh and try again.",
      ));
      return;
    }
    if (openingThreadTaskId) return;
    setOpeningThreadTaskId(task.id);
    setActionError(null);

    let instruction: string;
    try {
      instruction = issueThreadInstruction(
        task,
        latestAiChatHandoff(await listComments(task.id), text),
        text,
      );
    } catch (error) {
      setOpeningThreadTaskId(null);
      setActionError(text(
        `无法读取议题交接记录：${errorMessage(error)}`,
        `Could not read the issue handoff: ${errorMessage(error)}`,
      ));
      return;
    }
    const prompt = `[$manage-panel](${managePanelSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      setOpeningThreadTaskId(null);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }

    postEmbeddedHostMessage({
      type: "panel:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        instruction,
        skillName: "manage-panel",
        skillDisplayName: "Manage Panel",
        skillPath: managePanelSkillPath,
        projectName: taskProject?.name,
        codexProjectId: codexProjectContext?.codexProjectId ?? (
          taskProject?.id === GLOBAL_PROJECT_ID ? hostContext?.projectId : taskProject?.id
        ),
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath,
      },
    });
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectContextMenu(null);
    setProjectMenuOpen(false);
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    setBoardView(projectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(projectId));
    setListLayout(readProjectListLayout(projectId));
    const collapseModes = readProjectListCollapseModes(projectId);
    setListCollapseModes(collapseModes);
    setListCollapsedStatuses(initialProjectListCollapsedStatuses(projectId, collapseModes));
    if (projectId !== ALL_PROJECTS_ID) rememberProjectOpen(projectId);
    setSelectedProjectId(projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      if (choice.codexIdentity) {
        setProjectCodexIdentities((current) => {
          const next = { ...current, [project!.id]: choice.codexIdentity! };
          panelStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
          return next;
        });
        rememberDeviceWorkspacePath(project.id, choice.codexIdentity.workspacePath);
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function openJiraDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setJiraError(null);
    setJiraDialogOpen(true);
  }

  async function saveJiraConnection(input: {
    baseUrl: string;
    authMethod: "basic" | "bearer";
    username: string;
    password: string;
    projects: string[];
    autoCompleteEnabled: boolean;
    autoArchiveEnabled: boolean;
  }) {
    if (jiraSaving) return;
    setJiraSaving(true);
    setJiraError(null);
    try {
      let connection: JiraConnection;
      try {
        const { autoCompleteEnabled, autoArchiveEnabled, ...connectionInput } = input;
        connection = await configureJiraConnection(connectionInput);
        await saveJiraSettings({ autoCompleteEnabled, autoArchiveEnabled });
        connection = { ...connection, autoCompleteEnabled, autoArchiveEnabled };
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "JIRA_ACCOUNT_CHANGED"
          || !window.confirm(`${error.message}\n\n${text("确认切换账号并继续同步？", "Switch accounts and continue syncing?")}`)
        ) throw error;
        const { autoCompleteEnabled, autoArchiveEnabled, ...connectionInput } = input;
        connection = await configureJiraConnection({ ...connectionInput, acceptAccountChange: true });
        await saveJiraSettings({ autoCompleteEnabled, autoArchiveEnabled });
        connection = { ...connection, autoCompleteEnabled, autoArchiveEnabled };
      }
      const nextProjects = await listProjects();
      setJiraConnection(connection);
      setAiThreadsRevision((revision) => revision + 1);
      setProjects(nextProjects);
      setJiraDialogOpen(false);
      changeProject(connection.projectId);
      await refreshTasks(connection.projectId);
      setAnnouncement(text(
        `已同步 ${connection.displayName ?? connection.username} 的 Jira 任务`,
        `Synced Jira issues for ${connection.displayName ?? connection.username}`,
      ));
    } catch (error) {
      try {
        const connection = await getJiraConnection();
        setJiraConnection(connection);
        if (!connection.syncError) setJiraError(errorMessage(error));
      } catch {
        setJiraError(errorMessage(error));
      }
    } finally {
      setJiraSaving(false);
    }
  }

  async function syncJiraNow() {
    if (jiraSyncing || !selectedProjectId) return;
    setJiraSyncing(true);
    setActionError(null);
    try {
      let connection: JiraConnection;
      try {
        connection = await syncJiraConnection();
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "JIRA_ACCOUNT_CHANGED"
          || !window.confirm(`${error.message}\n\n${text("确认切换账号并继续同步？", "Switch accounts and continue syncing?")}`)
        ) throw error;
        connection = await syncJiraConnection(true);
      }
      setJiraConnection(connection);
      await Promise.all([
        refreshTasks(taskScopeProjectId, { quiet: true }),
        refreshProjectList(),
      ]);
      setAnnouncement(text("Jira 任务已同步", "Jira issues synced"));
    } catch (error) {
      try {
        const connection = await getJiraConnection();
        setJiraConnection(connection);
        if (!connection.syncError) setActionError(errorMessage(error));
      } catch {
        setActionError(errorMessage(error));
      }
    } finally {
      setJiraSyncing(false);
    }
  }

  function openCreateProjectDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectName("");
    setActionError(null);
    setProjectCreateOpen(true);
  }

  function closeCreateProjectDialog() {
    if (openingProjectId) return;
    setProjectCreateOpen(false);
    setActionError(null);
  }

  async function createTemporaryProject() {
    if (openingProjectId) return;
    const name = projectName.trim();
    if (!name) return;
    const projectId = `temp-${window.crypto.randomUUID()}`;
    setOpeningProjectId(projectId);
    setActionError(null);
    try {
      const project = await createProjectRequest({
        id: projectId,
        name,
        workspacePath: null,
      });
      setProjects((current) => [...current, project]);
      setProjectCreateOpen(false);
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function requestProjectDelete(project: ProjectChoice) {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectDeleteIssueCount(null);
    setPendingProjectDelete(project);
  }

  function closeProjectDeleteDialog() {
    if (deletingProjectId) return;
    setPendingProjectDelete(null);
    setProjectDeleteIssueCount(null);
  }

  async function deletePendingProject() {
    if (!pendingProjectDelete || deletingProjectId) return;
    const project = pendingProjectDelete;
    setDeletingProjectId(project.id);
    setActionError(null);
    try {
      await deleteProjectRequest(project.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      setRecentProjectIds((current) => {
        const next = current.filter((candidate) => candidate !== project.id);
        panelStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
        return next;
      });
      setProjectCodexIdentities((current) => {
        const next = { ...current };
        delete next[project.id];
        panelStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
        return next;
      });
      setPendingProjectDelete(null);
      setProjectDeleteIssueCount(null);
      if (selectedProjectId === project.id) changeProject(GLOBAL_PROJECT_ID);
      setAnnouncement(text(
        `已删除项目“${project.name}”`,
        `Deleted project “${project.name}”`,
      ));
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROJECT_NOT_EMPTY") {
        const details = error.details as { issueCount: number };
        setProjectDeleteIssueCount(details.issueCount);
      } else {
        setPendingProjectDelete(null);
        setActionError(errorMessage(error));
      }
    } finally {
      setDeletingProjectId(null);
    }
  }

  const headerProjectName = isAllProjects
    ? text("所有项目", "All projects")
    : selectedProject?.id === GLOBAL_PROJECT_ID
      ? text("全局", "Global")
      : selectedProject?.name ?? text("任务面板", "Panel");
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <TaskboardLanguageProvider language={language}>
      <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {panelMetadata && panelMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={taskScopeProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshAutomation={reconcileProjectAutomation}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setAiThreadsRevision={setAiThreadsRevision}
          setReadmeRevision={setReadmeRevision}
        />
      )}
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label={text("返回议题看板", "Back to issue board")}
                  title={text("返回议题看板 (Esc)", "Back to issue board (Esc)")}
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label={text("展开 Codex 侧边栏", "Expand Codex sidebar")}
                  title={text("展开侧边栏", "Expand sidebar")}
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              <div className="header-project-switcher" data-project-switcher>
                <button
                  className="header-project-button"
                  type="button"
                  aria-label={text("切换项目", "Switch project")}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  onClick={() => {
                    setProjectContextMenu(null);
                    setProjectMenuSearch("");
                    setProjectMenuOpen((current) => !current);
                  }}
                >
                  <span className="project-name">{headerProjectName}</span>
                  <PanelIcon className="project-switcher-chevron" name="dropdown" />
                </button>
                {projectMenuOpen && (
                  <div className="header-project-menu" role="menu" aria-label={text("项目", "Projects")}>
                    <span>{text("切换项目", "Switch project")}</span>
                    <div className="project-menu-search">
                      <label className="sr-only" htmlFor="project-menu-search-input">
                        {text("按名称筛选项目", "Filter projects by name")}
                      </label>
                      <TaskboardIcon name="search" />
                      <input
                        id="project-menu-search-input"
                        autoFocus
                        type="search"
                        value={projectMenuSearch}
                        onChange={(event) => setProjectMenuSearch(event.target.value)}
                        placeholder={text("筛选项目…", "Filter projects…")}
                      />
                      {projectMenuSearch && (
                        <button
                          className="search-clear"
                          type="button"
                          aria-label={text("清除项目筛选", "Clear project filter")}
                          onClick={() => setProjectMenuSearch("")}
                        >
                          <LinearIcon name="close" />
                        </button>
                      )}
                    </div>
                    <div className="project-menu-list">
                      {!projectMenuNeedle && (
                        <>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={isAllProjects}
                            disabled={openingProjectId !== null}
                            onClick={() => {
                              if (isAllProjects) setProjectMenuOpen(false);
                              else changeProject(ALL_PROJECTS_ID);
                            }}
                          >
                            <TaskboardIcon className="project-avatar" name="projectFolder" />
                            <span>{text("所有项目", "All projects")}</span>
                            {isAllProjects && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                          </button>
                          <div className="project-menu-divider" role="separator" />
                        </>
                      )}
                      {projectMenuChoices.map((project) => (
                        <Fragment key={project.id}>
                          {hasProjectsWithIssues && project.id === firstEmptyProjectId && (
                            <div className="project-menu-divider" role="separator" />
                          )}
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={project.id === selectedProjectId}
                            disabled={openingProjectId !== null}
                            onContextMenu={project.id.startsWith("temp-") ? (event) => {
                              event.preventDefault();
                              setProjectContextMenu({
                                project,
                                x: event.clientX,
                                y: event.clientY,
                              });
                            } : undefined}
                            onClick={() => {
                              if (project.id === selectedProjectId) setProjectMenuOpen(false);
                              else void selectProject(project);
                            }}
                          >
                            <TaskboardIcon className="project-avatar" name="projectFolder" />
                            <span>{project.name}</span>
                            {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                          </button>
                        </Fragment>
                      ))}
                      {projectMenuNeedle && projectMenuChoices.length === 0 && (
                        <div className="project-menu-empty">{text("没有匹配项目", "No matching projects")}</div>
                      )}
                    </div>
                    <div className="project-menu-actions">
                      <div className="project-menu-divider" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        disabled={openingProjectId !== null}
                        onClick={openJiraDialog}
                      >
                        <RelationIcon className="project-avatar" color="currentColor" size={16} />
                        <span>
                          {jiraConnection?.configured
                            ? text("Jira 设置", "Jira settings")
                            : text("连接 Jira", "Connect Jira")}
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={openingProjectId !== null}
                        onClick={openCreateProjectDialog}
                      >
                        <PlusIcon className="project-avatar" color="currentColor" size={16} />
                        <span>{text("创建项目", "Create project")}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProject && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationUnavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={saveProjectAutomation}
              />
            )}
            {isJiraProject && (
              <>
                <button
                  className="icon-button"
                  type="button"
                  onClick={openJiraDialog}
                  aria-label={text("Jira 设置", "Jira settings")}
                  title={text("Jira 设置", "Jira settings")}
                >
                  <LinearIcon name="settings" />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  disabled={jiraSyncing}
                  onClick={() => void syncJiraNow()}
                  aria-label={text("同步 Jira", "Sync Jira")}
                  title={text("同步 Jira", "Sync Jira")}
                >
                  <RefreshIcon color="currentColor" />
                </button>
              </>
            )}
            {selectedProjectId && !isJiraProject && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "todo" })}
                aria-label={text("新建议题", "Create issue")}
                title={text("新建议题 (C)", "Create issue (C)")}
              >
                <PlusIcon color="currentColor" size={14} />
              </button>
            )}
          </div>
        </header>

        {selectedProjectId && <div className="board-toolbar">
          <div className="view-tabs" aria-label={text("看板视图", "Board views")}>
            <button
              className={`view-tab${boardView === "dashboard" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "dashboard"}
              onClick={() => selectBoardView("dashboard")}
            >
              {text("仪表盘", "Dashboard")}
            </button>
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              {text("议题看板", "Issue board")}
            </button>
            <button
              className={`view-tab${boardView === "list" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "list"}
              onClick={() => selectBoardView("list")}
            >
              {text("列表视图", "List")}
            </button>
            <button
              className={`view-tab${boardView === "gantt" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "gantt"}
              onClick={() => selectBoardView("gantt")}
            >
              {text("甘特图", "Gantt")}
            </button>
            {!isAllProjects && (
              <button
                className={`view-tab${boardView === "readme" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "readme"}
                onClick={() => selectBoardView("readme")}
              >
                {text("项目文档", "Project Docs")}
              </button>
            )}
          </div>
          {!detailTask && (boardView === "issues" || boardView === "list" || boardView === "gantt") && <div className="toolbar-tools">
            {boardView === "list" && (
              <div className="list-view-options">
                <div className="list-layout-switch" role="group" aria-label={text("列表布局", "List layout")}>
                  <button
                    type="button"
                    className={`list-layout-option${listLayout === "horizontal" ? " is-active" : ""}`}
                    aria-label={text("横向列表", "Horizontal list")}
                    aria-pressed={listLayout === "horizontal"}
                    title={text("横向列表", "Horizontal list")}
                    onClick={() => selectListLayout("horizontal")}
                  >
                    <LinearIcon name="layoutColumns" />
                  </button>
                  <button
                    type="button"
                    className={`list-layout-option${listLayout === "vertical" ? " is-active" : ""}`}
                    aria-label={text("纵向列表", "Vertical list")}
                    aria-pressed={listLayout === "vertical"}
                    title={text("纵向列表", "Vertical list")}
                    onClick={() => selectListLayout("vertical")}
                  >
                    <LinearIcon name="layoutRows" />
                  </button>
                </div>
              </div>
            )}
            <div className={`search-field${search ? " has-value" : ""}`} title={text("搜索议题 (/)", "Search issues (/)")}>
              <PanelIcon className="search-icon" name="search" />
              <input
                id="task-search"
                type="search"
                aria-label={text("搜索议题", "Search issues")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("搜索议题…", "Search issues…")}
              />
              {!search && <kbd>/</kbd>}
              {search && (
                <button
                  className="search-clear"
                  type="button"
                  aria-label={text("清除搜索", "Clear search")}
                  onClick={() => {
                    setSearch("");
                    document.getElementById("task-search")?.focus();
                  }}
                >
                  <LinearIcon name="close" />
                </button>
              )}
            </div>
            {boardView === "gantt" && (
              <div className="gantt-toolbar-controls">
                <label className="gantt-hide-completed">
                  <input type="checkbox" checked={ganttHideCompleted} onChange={(event) => setGanttHideCompleted(event.target.checked)} />
                  <i><LinearIcon name="check" /></i>
                  <span>{text("隐藏已完成", "Hide completed")}</span>
                </label>
                <button type="button" className="gantt-today-button" onClick={() => setGanttTodayRequest((current) => current + 1)}>{text("今天", "Today")}</button>
                <div className="gantt-view-menu-wrap">
                  <button type="button" className="gantt-view-menu-trigger" aria-label={text("时间轴视图选项", "Timeline view options")} aria-expanded={ganttViewMenuOpen} onClick={() => setGanttViewMenuOpen((current) => !current)}>
                    <MoreIcon color="currentColor" />
                  </button>
                  {ganttViewMenuOpen && (
                    <div className="gantt-view-menu" role="menu">
                      {GANTT_ZOOM_OPTIONS.map((value) => (
                        <button type="button" role="menuitemradio" aria-checked={ganttZoom === value} className={ganttZoom === value ? "active" : ""} onClick={() => { setGanttZoom(value); setGanttViewMenuOpen(false); }} key={value}>
                          <span>{language === "zh"
                            ? { day: "日视图", week: "周视图", month: "月视图" }[value]
                            : { day: "Day", week: "Week", month: "Month" }[value]}</span>
                          {ganttZoom === value && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {boardView === "issues" && (isAllProjects || selectedProject) && (
              <BoardCardDisplayMenu
                settings={boardDisplaySettings}
                onChange={updateProjectBoardDisplaySettings}
                onReset={resetProjectBoardDisplaySettings}
              />
            )}
            {boardView === "issues" && otherTasksAvailable && (
              <button
                className={`other-tasks-trigger${otherTasksOpen ? " is-open" : ""}`}
                type="button"
                aria-controls="other-tasks-panel"
                aria-expanded={otherTasksOpen}
                aria-label={otherTasksOpen
                  ? text("关闭其他任务", "Close other issues")
                  : text("打开其他任务", "Open other issues")}
                title={text("其他任务", "Other issues")}
                onClick={() => setOtherTasksOpen((current) => !current)}
              >
                <PanelIcon name="panel" />
              </button>
            )}
          </div>}
        </div>}

        {isJiraProject && jiraConnection?.configured && (
          <div
            className={`jira-sync-status-bar${jiraConnection.syncError ? " is-error" : ""}`}
            role={jiraConnection.syncError ? "alert" : "status"}
          >
            <span aria-hidden="true" />
            <strong>{jiraConnection.syncError
              ? text("Jira 同步失败", "Jira sync failed")
              : text(
                `已同步 ${jiraConnection.syncedIssueCount} 个未完成任务`,
                `${jiraConnection.syncedIssueCount} open issues synced`,
              )}</strong>
            <small>{jiraConnection.syncError?.message ?? text(
              [
                jiraConnection.unknownIssueCount > 0
                  ? `${jiraConnection.unknownIssueCount} 个状态未知`
                  : null,
                jiraConnection.lastSuccessfulAt
                  ? `最后成功 ${new Date(jiraConnection.lastSuccessfulAt).toLocaleString(locale)}`
                  : "尚无成功记录",
              ].filter(Boolean).join(" · "),
              [
                jiraConnection.unknownIssueCount > 0
                  ? `${jiraConnection.unknownIssueCount} unknown`
                  : null,
                jiraConnection.lastSuccessfulAt
                  ? `Last success ${new Date(jiraConnection.lastSuccessfulAt).toLocaleString(locale)}`
                  : "No successful sync yet",
              ].filter(Boolean).join(" · "),
            )}</small>
            <button type="button" onClick={openJiraDialog}>{text("查看详情", "View details")}</button>
          </div>
        )}

        {(loadError || actionErrorText) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>{text("任务面板需要处理", "Panel needs attention")}</strong><p>{actionErrorText ?? loadError?.message}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (loadError?.source === "projects") {
                  if (loadError.operation === "initial") void loadProjectList();
                  else void refreshProjectList();
                } else if (taskScopeProjectId) void refreshTasks(taskScopeProjectId);
                else void loadProjectList();
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            referenceTasks={referenceTasks}
            projects={projects}
            currentUser={currentUser}
            jiraAvailable={panelMetadata !== null && panelMetadata.mode !== "cloud"}
            availableLabels={availableLabels}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onCreateLabel={persistProjectLabel}
            onDeleteLabel={removeProjectLabel}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("add", current, type, relatedTaskId, origin)
            )}
            onRemoveRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("remove", current, type, relatedTaskId, origin)
            )}
            onOpenThread={openThread}
            onOpenLegacyLocalThread={openLegacyLocalThread}
            aiChatThreads={aiThreads}
            onAiChatThreadsRefresh={() => setAiThreadsRevision((revision) => revision + 1)}
            onOpenAiChatThread={(threadId) => setAiOpenThreadRequest((current) => ({
              threadId,
              requestId: (current?.requestId ?? 0) + 1,
            }))}
            onOpenInThread={openTaskInThread}
            onCopy={(text, message) => void copyText(text, message)}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
          />
        ) : boardView !== "readme"
          && hasLoadedTasks
          && tasks.length === 0
          && selectedProject
          && aiImportReadyProjectId === selectedProject.id ? (
          <div className="page-empty">
            <h2>{text("当前项目还没有任务", "This project has no issues yet")}</h2>
            <p>{text(
              "让 Codex 检查当前项目目录对应的对话，并整理任务状态。",
              "Ask Codex to inspect conversations for this project directory and organize their task status.",
            )}</p>
            <div className="page-empty-actions">
              <button
                className="button primary"
                type="button"
                onClick={() => setAiOpenThreadRequest((current) => ({
                  projectId: selectedProject.id,
                  issueId: null,
                  composerText: text(
                    "只检查当前项目目录对应的 Codex 对话。请将其中已完成、处理中和待执行的任务整理并导入当前项目的 Panel。",
                    "Only inspect Codex conversations associated with this project directory. Organize completed, in-progress, and pending tasks, then import them into this project's Panel.",
                  ),
                  requestId: (current?.requestId ?? 0) + 1,
                }))}
              >
                {text("导入当前项目任务状态", "Import current project task status")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setEditor({ task: null, status: "todo" })}
              >
                {text("添加议题", "Add issue")}
              </button>
            </div>
          </div>
        ) : boardView === "readme" && selectedProject ? (
          <ProjectReadmeView
            key={selectedProjectId}
            project={selectedProject}
            tasks={tasks.filter((task) => task.projectId === selectedProject.id)}
            referenceTasks={referenceTasks.filter((task) => task.projectId === selectedProject.id)}
            revision={readmeRevision}
            onOpenTask={openTaskDetail}
            onError={setActionError}
          />
        ) : boardView === "dashboard" && (selectedProject || isAllProjects) ? (
          <DashboardView
            key={selectedProjectId}
            projectId={selectedProjectId}
            projectCreatedAt={selectedProject?.createdAt ?? null}
            isAllProjects={isAllProjects}
            tasks={tasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            animateSummary={dashboardSummaryAnimatedProjectId !== selectedProjectId}
            onSummaryAnimationStart={markDashboardSummaryAnimationStarted}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
          />
        ) : boardView === "list" ? (
          <IssueListView
            scrollRef={issueListRef}
            layout={listLayout}
            collapseModes={listCollapseModes}
            collapsedStatuses={listCollapsedStatuses}
            tasks={filteredTasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            dropTarget={dropTarget}
            draggedTaskId={draggedTaskId}
            movingTaskId={movingTaskId}
            settlingTaskId={settlingTaskId}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
            onCollapseModeChange={selectListCollapseMode}
            onToggleStatus={toggleListStatus}
            onDragStart={startTaskDrag}
            onDragEnd={endTaskDrag}
            onDragEnter={setDropTarget}
            onDrop={finishTaskDrop}
          />
        ) : boardView === "gantt" ? (
          <Suspense fallback={<div className="board-view-loading">{text("正在打开甘特图…", "Opening Gantt…")}</div>}>
            <GanttView
              tasks={filteredTasks}
              presentations={taskPresentations}
              hasActiveFilters={hasActiveTaskFilters}
              zoom={ganttZoom}
              hideCompleted={ganttHideCompleted}
              todayRequest={ganttTodayRequest}
              onOpenTask={openTaskDetail}
              onUpdate={updateTaskProperties}
            />
          </Suspense>
        ) : (
          <div
            className={`issue-board-layout${otherTasksAvailable && otherTasksVisible ? " has-other-tasks" : ""}`}
            data-main-columns={mainBoardItems.length}
            style={{
              "--main-column-count": mainColumnCount,
              "--main-board-min-width": `${mainBoardMinWidth}px`,
              "--main-board-max-width": `${mainBoardMaxWidth}px`,
              "--other-tasks-width": otherTasksWidth,
            } as CSSProperties}
          >
            {tasksLoading && !hasLoadedTasks ? (
              <div className="loading-board" aria-label={text("正在加载议题", "Loading issues")} aria-busy="true">
                {mainBoardItems.map((item) => (
                  <div className="loading-column" key={item}>
                    <span /><div /><div />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="board-scroll" aria-label={text("议题看板", "Issue board")}>
                  <div className="board">
                    {mainBoardItems.map((item) => item === "archived" ? (
                      <ArchivedTasksColumn
                        key={item}
                        tasks={filteredArchivedTasks}
                        hasActiveFilters={hasActiveTaskFilters}
                        restoringTaskId={restoringTaskId}
                        deletingTaskId={deletingArchivedTaskId}
                        onRestore={(task) => void restoreArchivedTask(task)}
                        onDelete={setPendingArchivedTaskDelete}
                      />
                    ) : (
                      <BoardColumn
                        key={item}
                        scrollRef={(element) => {
                          boardColumnScrollRefs.current[item] = element;
                        }}
                        status={item}
                        tasks={tasksByStatus[item]}
                        presentations={taskPresentations}
                        now={processingNow}
                        emptyMessage={hasActiveTaskFilters
                          ? text("当前筛选下无匹配议题", "No issues match the current filters")
                          : text("暂无议题", "No issues")}
                        isDropTarget={dropTarget === item}
                        draggedTaskId={draggedTaskId}
                        draggedTaskHeight={draggedTaskHeight}
                        movingTaskId={movingTaskId}
                        settlingTaskId={settlingTaskId}
                        contextMenuTaskId={contextMenu?.taskId ?? null}
                        availableLabels={availableLabels}
                        projectNames={isAllProjects ? projectNames : undefined}
                        currentUser={currentUser}
                        showCover={boardDisplaySettings.cover}
                        showBody={boardDisplaySettings.body}
                        createEnabled={!isJiraProject}
                        onCreateLabel={persistProjectLabel}
                        onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                        onEdit={openTaskDetail}
                        onUpdate={updateTaskProperties}
                        onComplete={(task) => void moveTask(task, "done")}
                        onContextMenu={openTaskContextMenu}
                        onDragStart={startTaskDrag}
                        onDragEnd={endTaskDrag}
                        onDragEnter={setDropTarget}
                        onDrop={finishTaskDrop}
                        onOpenConversation={openTaskConversation}
                      />
                    ))}
                  </div>
                </div>
                {otherTasksAvailable && otherTasksMounted && (
                  <OtherTasksPanel
                    open={otherTasksVisible}
                    activeTab={otherTasksTab}
                    tabs={otherTaskTabs}
                    tasksByStatus={tasksByStatus}
                    archivedTasks={filteredArchivedTasks}
                    presentations={taskPresentations}
                    now={processingNow}
                    hasActiveFilters={hasActiveTaskFilters}
                    isDropTarget={otherTasksTab !== "archived" && dropTarget === otherTasksTab}
                    draggedTaskId={draggedTaskId}
                    draggedTaskHeight={draggedTaskHeight}
                    movingTaskId={movingTaskId}
                    settlingTaskId={settlingTaskId}
                    contextMenuTaskId={contextMenu?.taskId ?? null}
                    availableLabels={availableLabels}
                    projectNames={isAllProjects ? projectNames : undefined}
                    currentUser={currentUser}
                    showCover={boardDisplaySettings.cover}
                    showBody={boardDisplaySettings.body}
                    onCreateLabel={persistProjectLabel}
                    restoringTaskId={restoringTaskId}
                    deletingTaskId={deletingArchivedTaskId}
                    onTabChange={setOtherTasksTab}
                    onCreate={isJiraProject
                      ? undefined
                      : (initialStatus) => setEditor({ task: null, status: initialStatus })}
                    onRestore={(task) => void restoreArchivedTask(task)}
                    onDelete={setPendingArchivedTaskDelete}
                    onEdit={openTaskDetail}
                    onUpdate={updateTaskProperties}
                    onContextMenu={openTaskContextMenu}
                    onDragStart={startTaskDrag}
                    onDragEnd={endTaskDrag}
                    onDragEnter={setDropTarget}
                    onDrop={finishTaskDrop}
                    onOpenConversation={openTaskConversation}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {projectContextMenu && (
        <div
          className="task-context-menu project-context-menu"
          data-project-context-menu
          role="menu"
          aria-label={text(
            `项目“${projectContextMenu.project.name}”`,
            `Project “${projectContextMenu.project.name}”`,
          )}
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
        >
          <button
            className="context-menu-item is-danger"
            type="button"
            role="menuitem"
            onClick={() => requestProjectDelete(projectContextMenu.project)}
          >
            <span className="context-menu-icon" aria-hidden="true"><DeleteIcon color="currentColor" /></span>
            <span className="context-menu-label">{text("删除项目", "Delete project")}</span>
          </button>
        </div>
      )}

      {jiraDialogOpen && (
        <JiraConnectionDialog
          connection={jiraConnection}
          saving={jiraSaving}
          error={jiraError}
          onClose={() => {
            if (!jiraSaving) setJiraDialogOpen(false);
          }}
          onSave={saveJiraConnection}
        />
      )}

      {projectCreateOpen && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeCreateProjectDialog();
          }}
        >
          <form
            className="delete-dialog project-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createTemporaryProject();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCreateProjectDialog();
            }}
          >
            <h2 id="project-create-title">{text("创建项目", "Create project")}</h2>
            <label>
              <span>{text("项目名称", "Project name")}</span>
              <input
                autoFocus
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            {actionErrorText && <p className="project-dialog-error">{actionErrorText}</p>}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={openingProjectId !== null}
                onClick={closeCreateProjectDialog}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!projectName.trim() || openingProjectId !== null}
              >
                {openingProjectId
                  ? text("创建中…", "Creating…")
                  : text("创建", "Create")}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingProjectDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeProjectDeleteDialog();
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProjectDeleteDialog();
            }}
          >
            {projectDeleteIssueCount === null ? (
              <>
                <h2 id="project-delete-title">{text(
                  `删除项目“${pendingProjectDelete.name}”？`,
                  `Delete project “${pendingProjectDelete.name}”?`,
                )}</h2>
                <p>{text(
                  "仅空项目可以删除。删除后无法恢复。",
                  "Only empty projects can be deleted. This cannot be undone.",
                )}</p>
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={closeProjectDeleteDialog}
                  >
                    {text("取消", "Cancel")}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={() => void deletePendingProject()}
                  >
                    {deletingProjectId
                      ? text("删除中…", "Deleting…")
                      : text("删除项目", "Delete project")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="project-delete-title">{text(
                  `无法删除项目“${pendingProjectDelete.name}”`,
                  `Cannot delete project “${pendingProjectDelete.name}”`,
                )}</h2>
                <p>{text(
                  `该项目还有 ${projectDeleteIssueCount} 个议题（包含已归档议题）。请先移动或删除这些议题。`,
                  `This project still has ${projectDeleteIssueCount} issues, including archived issues. Move or delete them first.`,
                )}</p>
                <div>
                  <button className="button primary" type="button" onClick={closeProjectDeleteDialog}>
                    {text("知道了", "Got it")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingArchivedTaskDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingArchivedTaskId) {
              setPendingArchivedTaskDelete(null);
            }
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="archived-task-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingArchivedTaskId) {
                setPendingArchivedTaskDelete(null);
              }
            }}
          >
            <h2 id="archived-task-delete-title">{text(
              `永久删除 ${pendingArchivedTaskDelete.identifier}？`,
              `Permanently delete ${pendingArchivedTaskDelete.identifier}?`,
            )}</h2>
            <p>{text(
              `“${pendingArchivedTaskDelete.title}”及其评论和附件将被永久删除，此操作无法撤销。`,
              `“${pendingArchivedTaskDelete.title}” and its comments and attachments will be permanently deleted. This cannot be undone.`,
            )}</p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => setPendingArchivedTaskDelete(null)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => void deletePendingArchivedTask()}
              >
                {deletingArchivedTaskId
                  ? text("删除中…", "Deleting…")
                  : text("永久删除", "Delete permanently")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${selectedProjectId}-${editor.status}`}
          projectId={editorProjectId}
          projectOptions={!editor.task && isAllProjects ? createTargetProjects : undefined}
          onProjectChange={(projectId) => setEditor((current) => (
            current ? { ...current, projectId } : current
          ))}
          task={editor.task}
          tasks={tasks.filter((task) => task.projectId === editorProjectId)}
          referenceTasks={referenceTasks.filter((task) => task.projectId === editorProjectId)}
          initialStatus={editor.status}
          initialDraft={editor.task || newTaskDraft?.projectId !== selectedProjectId
            ? null
            : newTaskDraft.draft}
          labels={projects.find((project) => project.id === editorProjectId)?.labels ?? []}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCreateLabel={(label) => persistProjectLabel(label, editorProjectId ?? selectedProjectId)}
          onCancel={(draft) => {
            if (!editor.task) {
              setNewTaskDraft(draft ? {
                projectId: selectedProjectId,
                targetProjectId: editorProjectId,
                draft,
              } : null);
            }
            setEditor(null);
          }}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          openInThreadDisabled={developmentScanLoading}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      {localAiChatAvailable && !isAllProjects && (
        <Suspense fallback={null}>
          <AiChat
            available
            projectId={selectedProjectId || null}
            issueId={detailTaskId}
            threadsRevision={aiThreadsRevision}
            onThreadsChange={setAiThreads}
            openThreadRequest={aiOpenThreadRequest}
          />
        </Suspense>
      )}

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            {text("撤回", "Undo")} <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      </div>
    </TaskboardLanguageProvider>
  );
}
