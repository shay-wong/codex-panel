import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { panelStorage } from "../storage";
import {
  ApiError,
  addJiraTaskLink,
  archiveJiraConversations,
  attachmentDownloadUrl,
  claimTask,
  createComment,
  deleteComment,
  getJiraTaskContext,
  getTask,
  listAttachments,
  listComments,
  listTaskActivities,
  removeJiraTaskLink,
  resolveJiraAutoCompletion,
  resolveJiraLifecycle,
  resolvePanelUrl,
  saveJiraTaskProjects,
  startJiraPlanning,
  startSimpleJiraTask,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import { TASK_PRIORITIES, TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  AiChatSkill,
  AiChatThread,
  Attachment,
  Comment,
  CodexThreadBinding,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationOrigin,
  IssueRelationType,
  JiraTaskContext,
  Project,
  Recurrence,
  Task,
  TaskChangeActivity,
  TaskDraft,
  TaskPriority,
  TaskRelationSummary,
  TaskUpdate,
  TaskStatus,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon } from "./LinearIcon";
import { ProjectSelectionMenu } from "./ProjectSelectionMenu";
import {
  AttachmentIcon,
  BlockingRelationIcon,
  BranchIcon,
  CodexResumeIcon,
  ConversationIcon,
  DeleteIcon,
  DueDateIcon,
  EditIcon,
  LabelIcon,
  MoreIcon,
  NewConversationIcon,
  PriorityIcon,
  ProjectIcon,
  RecurrenceIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaFiles,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineAttachmentMarkdown,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import {
  IssueParentLink,
  IssueRelationSidebar,
  IssueSubIssues,
  type RelationMutationResult,
} from "./IssueRelations";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { buildIssueUrl } from "../issueRoute";
import { normalizeCodexThreadId } from "../taskConversations";
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";
import { DescriptionDocument } from "./DescriptionDocument";

type TaskDetailError = string | readonly [string, string];

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  referenceTasks: Task[];
  projects: Project[];
  jiraRepositoryProjects: Array<{
    id: string;
    name: string;
    workspacePath: string;
    persisted: boolean;
  }>;
  currentUser: ActorIdentity;
  jiraAvailable: boolean;
  availableLabels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  onCreateLabel: (label: string) => Promise<void>;
  onDeleteLabel: (label: string) => Promise<void>;
  onUpdate: (task: Task, changes: Partial<TaskUpdate>) => Promise<Task>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (binding: CodexThreadBinding) => void;
  onOpenLegacyLocalThread: (threadId: string) => void;
  aiChatThreads: AiChatThread[];
  onAiChatThreadsRefresh: () => void;
  onOpenAiChatThread: (
    threadId: string,
    composer?: { text: string; skillIds: string[] },
  ) => void;
  onOpenInThread: (task: Task) => void;
  onOpenJiraPlanning: (
    task: Task,
    projectId: string | null,
    composer: {
      text: string;
      skills: Array<Pick<AiChatSkill, "id" | "label" | "path">>;
      replanLifecycleVersion?: number;
    },
  ) => Promise<void>;
  onExecutionStarted: (taskId: string) => void;
  onCopy: (text: string, announcement: string) => void;
  onEnsureJiraProjects: (projectIds: string[]) => Promise<void>;
  openingThread: boolean;
  onError: (message: TaskDetailError | null) => void;
}

function messageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return ["操作未完成，请重试。", "The action could not be completed. Try again."];
}

function issueMessageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
    return [
      "该议题已在其他位置更新，请刷新后重试。",
      "This issue changed elsewhere. Refresh and try again.",
    ];
  }
  return messageFor(error);
}

function exactTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string, locale: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

async function downloadAttachmentFile(attachment: Attachment) {
  const host = new URL(document.baseURI).searchParams.get("host");
  if (host === "codex" && window.parent !== window) {
    postEmbeddedHostMessage({
      type: "panel:open-attachment",
      payload: {
        attachmentId: attachment.id,
        filename: attachment.filename,
      },
    });
    return;
  }

  const response = await fetch(resolvePanelUrl(attachmentDownloadUrl(attachment)));
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => ({})));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(
  context: DevelopmentContext,
  text: (chinese: string, english: string) => string,
): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? text("分离 HEAD", "detached")} · ${folder}`;
}

const ACTIVITY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  projectId: ["项目", "project"],
  title: ["标题", "title"],
  description: ["描述", "description"],
  status: ["状态", "status"],
  priority: ["优先级", "priority"],
  labels: ["标签", "labels"],
  assignee: ["负责人", "assignee"],
  developmentContext: ["开发上下文", "development context"],
  startDate: ["开始日期", "start date"],
  dueDate: ["截止日期", "due date"],
  recurrence: ["重复", "recurrence"],
  archivedAt: ["归档状态", "archive status"],
  relation: ["关系", "relation"],
  jiraProjects: ["Jira 仓库", "Jira repositories"],
  jiraIssue: ["Jira 关联", "Jira link"],
};

const RELATION_LABELS: Record<IssueRelationType, readonly [string, string]> = {
  parent: ["父议题", "Parent issue"],
  blocks: ["阻塞", "Blocks"],
  blocked_by: ["阻塞于", "Blocked by"],
  related: ["相关议题", "Related issue"],
};

function activityValue(
  field: string,
  value: unknown,
  language: TaskboardLanguage,
  locale: string,
  text: (chinese: string, english: string) => string,
  projects: Project[],
): string {
  if (field === "archivedAt") {
    return typeof value === "string"
      ? text(`已归档（${exactTime(value, locale)}）`, `Archived (${exactTime(value, locale)})`)
      : text("未归档", "Not archived");
  }
  if (value === null || value === "") return text("未设置", "Not set");
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return taskStatusLabel(language, value as TaskStatus);
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return taskPriorityLabel(language, value as TaskPriority);
  }
  if (field === "labels" && Array.isArray(value)) {
    return value.length > 0
      ? value.join(language === "zh" ? "、" : ", ")
      : text("无标签", "No labels");
  }
  if (field === "projectId" && typeof value === "string") {
    return projects.find((project) => project.id === value)?.name ?? value;
  }
  if (field === "jiraProjects" && Array.isArray(value)) {
    return value.length > 0
      ? value.map((projectId) => (
          typeof projectId === "string"
            ? projects.find((project) => project.id === projectId)?.name ?? projectId
            : String(projectId)
        )).join(language === "zh" ? "、" : ", ")
      : text("未设置", "Not set");
  }
  if (field === "assignee" && typeof value === "object") {
    const actor = value as ActorIdentity;
    return `${actor.name} @${actor.id}`;
  }
  if (field === "developmentContext" && typeof value === "object") {
    const context = value as { type: string; branch?: string | null; path?: string | null };
    if (context.type === "branch") return context.branch ?? text("未设置", "Not set");
    const folder = context.path?.split(/[\\/]/).filter(Boolean).at(-1);
    return `${context.branch ?? text("分离 HEAD", "detached")}${folder ? ` · ${folder}` : ""}`;
  }
  if (field === "recurrence" && typeof value === "object") {
    const recurrence = value as Recurrence;
    const units: Record<Recurrence["unit"], readonly [string, string]> = {
      day: ["天", "day"],
      week: ["周", "week"],
      month: ["月", "month"],
      year: ["年", "year"],
    };
    const [chineseUnit, englishUnit] = units[recurrence.unit];
    return text(
      recurrence.interval === 1 ? `每${chineseUnit}` : `每 ${recurrence.interval} ${chineseUnit}`,
      `Every ${recurrence.interval === 1 ? "" : `${recurrence.interval} `}${englishUnit}${recurrence.interval === 1 ? "" : "s"}`,
    );
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as {
      type: IssueRelationType;
      identifier: string;
      externalKey?: string | null;
      title: string;
    };
    const [chineseLabel, englishLabel] = RELATION_LABELS[relation.type];
    return `${text(chineseLabel, englishLabel)} ${relation.externalKey ?? relation.identifier} · ${relation.title}`;
  }
  if (field === "jiraIssue" && typeof value === "object") {
    const issue = value as { externalKey?: string | null; identifier: string; title: string };
    return `${issue.externalKey ?? issue.identifier} · ${issue.title}`;
  }
  if (Array.isArray(value)) return value.join(language === "zh" ? "、" : ", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ActivityChangeIcon({ field, before, after }: {
  field: string;
  before: unknown;
  after: unknown;
}) {
  const value = after ?? before;
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return <StatusIcon status={value as TaskStatus} color="currentColor" size={14} />;
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return <PriorityIcon priority={value as TaskPriority} color="currentColor" size={14} />;
  }
  if ((field === "relation" || field === "jiraIssue") && typeof value === "object") {
    const relation = value as { type?: IssueRelationType };
    if (relation.type === "blocked_by" || relation.type === "blocks") {
      return <BlockingRelationIcon type={relation.type} color="currentColor" size={14} />;
    }
    return <RelationIcon color="currentColor" size={14} />;
  }
  if (field === "projectId" || field === "workflowId" || field === "jiraProjects") {
    return <ProjectIcon color="currentColor" size={14} />;
  }
  if (field === "labels") return <LabelIcon color="currentColor" size={14} />;
  if (field === "assignee") return <LinearIcon name="myIssues" />;
  if (field === "developmentContext") return <BranchIcon color="currentColor" size={14} />;
  if (field === "startDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "dueDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "recurrence") return <RecurrenceIcon color="currentColor" size={14} />;
  if (field === "archivedAt") return <DeleteIcon color="currentColor" size={14} />;
  return <EditIcon color="currentColor" size={14} />;
}

function ConversationLink({
  threadId,
  onOpen,
  onCopy,
}: {
  threadId: string;
  onOpen: () => void;
  onCopy: (text: string, announcement: string) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-conversation-actions">
      <button
        className="issue-conversation-link"
        type="button"
        title={text("查看对话", "View conversation")}
        onClick={onOpen}
      >
        <ConversationIcon color="currentColor" size={16} />
        <strong>{text("查看对话", "View conversation")}</strong>
      </button>
      <button
        className="issue-conversation-copy"
        type="button"
        title={text("复制终端命令", "Copy terminal command")}
        onClick={() => onCopy(
          `codex resume ${threadId}`,
          text("Codex 恢复命令已复制。", "Codex resume command copied."),
        )}
      >
        <CodexResumeIcon />
        <span>{text("复制终端命令", "Copy terminal command")}</span>
      </button>
    </div>
  );
}

function AiConversationActivity({
  thread,
  onOpen,
  native = false,
  roleLabel,
}: {
  thread: AiChatThread;
  onOpen: () => void;
  native?: boolean;
  roleLabel?: readonly [string, string];
}) {
  const { locale, text } = useTaskboardI18n();
  const statusLabel = {
    idle: text("空闲", "Idle"),
    running: text("运行中", "Running"),
    failed: text("失败", "Failed"),
  }[thread.status];

  return (
    <div className="activity-entry activity-ai-conversation">
      <span className="activity-rail-icon activity-conversation-icon" aria-hidden="true">
        <ConversationIcon />
      </span>
      <button
        className="activity-conversation-link"
        type="button"
        title={native
          ? text(`打开 Codex 对话 ${thread.title}`, `Open Codex conversation ${thread.title}`)
          : text(`打开临时对话 ${thread.title}`, `Open temporary conversation ${thread.title}`)}
        aria-label={text(
          `打开内嵌对话：${thread.title}，${statusLabel}`,
          `Open embedded conversation: ${thread.title}, ${statusLabel}`,
        )}
        onClick={onOpen}
      >
        <span className="activity-conversation-copy">
          <strong>{thread.title}</strong>
          <small>
            <span className={`activity-conversation-state is-${thread.status}`} aria-hidden="true" />
            <span>{roleLabel
              ? `${text(...roleLabel)} · ${statusLabel}`
              : native
              ? text(`Codex 对话 · ${statusLabel}`, `Codex conversation · ${statusLabel}`)
              : text(`临时 AI 对话 · ${statusLabel}`, `Temporary AI conversation · ${statusLabel}`)}</span>
            <time title={exactTime(thread.updatedAt, locale)}>{relativeTime(thread.updatedAt, locale)}</time>
          </small>
        </span>
        <LinearIcon name="chevronRight" />
      </button>
    </div>
  );
}

export function TaskDetail({
  task,
  tasks,
  referenceTasks,
  projects,
  jiraRepositoryProjects,
  currentUser,
  jiraAvailable,
  availableLabels,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  onCreateLabel,
  onDeleteLabel,
  onUpdate,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenLegacyLocalThread,
  aiChatThreads,
  onAiChatThreadsRefresh,
  onOpenAiChatThread,
  onOpenInThread,
  onOpenJiraPlanning,
  onExecutionStarted,
  onCopy,
  onEnsureJiraProjects,
  openingThread,
  onError,
}: TaskDetailProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(task.description, referenceTasks),
  );
  const [editingDescription, setEditingDescription] = useState(false);
  const [propertyMenu, setPropertyMenu] = useState<
    "project" | "status" | "priority" | "assignee" | "labels" | "development" | "recurrence" | null
  >(null);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [jiraContext, setJiraContext] = useState<JiraTaskContext | null>(null);
  const [jiraContextLoading, setJiraContextLoading] = useState(jiraAvailable);
  const [jiraProjectIds, setJiraProjectIds] = useState<string[]>([]);
  const [jiraProjectSearch, setJiraProjectSearch] = useState("");
  const [jiraLinkSavingId, setJiraLinkSavingId] = useState<string | null>(null);
  const [jiraManagerOpen, setJiraManagerOpen] = useState(false);
  const [jiraPlanningProjectAction, setJiraPlanningProjectAction] = useState<"planning" | "replan" | null>(null);
  const [jiraPlanningProjectSearch, setJiraPlanningProjectSearch] = useState("");
  const [jiraSimpleStartSaving, setJiraSimpleStartSaving] = useState(false);
  const [jiraPlanningSaving, setJiraPlanningSaving] = useState(false);
  const [jiraLifecycleSaving, setJiraLifecycleSaving] = useState<
    "pause" | "keep" | "rework" | "replan" | "migrate" | null
  >(null);
  const [jiraAutoCompletionSaving, setJiraAutoCompletionSaving] = useState<
    "retry" | "accept_remote" | null
  >(null);
  const [jiraArchiveSaving, setJiraArchiveSaving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsError, setAttachmentsError] = useState<TaskDetailError | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [taskActivities, setTaskActivities] = useState<TaskChangeActivity[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<TaskDetailError | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      panelStorage.getItem(`panel.comment-draft.${task.id}`) ?? "",
      referenceTasks,
    ),
  );
  const [changeStatusToTodo, setChangeStatusToTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSegments, setEditingSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(),
  );
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const descriptionScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const descriptionCaretRef = useRef<{ text: string; offset: number; occurrence: number } | null>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const editingComposerRef = useRef<InlineMediaComposerHandle>(null);
  const editingCommentScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editCommentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editingUploadedAttachmentsRef = useRef<Map<string, Attachment>>(new Map());
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);
  const commentInlineFiles = inlineMediaFiles(commentSegments);
  const editingDraft = serializeInlineMedia(editingSegments);
  const displayIdentifier = currentTask.externalKey ?? currentTask.identifier;
  const editingInlineImages = inlineMediaImages(editingSegments);
  const editingInlineFiles = inlineMediaFiles(editingSegments);

  useEffect(() => {
    const taskChanged = currentTask.id !== task.id;
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (taskChanged || !editingDescription) {
      setDescription(task.description);
      setDescriptionSegments(createInlineMediaSegments(task.description, referenceTasks));
    }
    if (taskChanged) {
      setEditingDescription(false);
      setChangeStatusToTodo(false);
    }
  }, [task]);

  useEffect(() => {
    if (!jiraAvailable) {
      setJiraContext(null);
      setJiraProjectIds([]);
      setJiraContextLoading(false);
      setJiraManagerOpen(false);
      return;
    }
    const controller = new AbortController();
    setJiraContextLoading(true);
    void getJiraTaskContext(task.id, controller.signal).then(
      (context) => {
        setJiraContext(context);
        setJiraProjectIds(context.projects.map((project) => project.id));
        setJiraContextLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        onError(messageFor(error));
        setJiraContextLoading(false);
      },
    );
    return () => controller.abort();
  }, [jiraAvailable, task.id, task.version]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
  }, [title]);

  useLayoutEffect(() => {
    if (!editingDescription) return;
    const position = descriptionScrollPositionRef.current;
    descriptionScrollPositionRef.current = null;
    const caret = descriptionCaretRef.current;
    descriptionCaretRef.current = null;
    if (caret) {
      descriptionComposerRef.current?.focusAtText(caret.text, caret.offset, caret.occurrence);
    } else {
      descriptionComposerRef.current?.focus();
    }
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingDescription]);

  useLayoutEffect(() => {
    if (!editingId) return;
    const position = editingCommentScrollPositionRef.current;
    editingCommentScrollPositionRef.current = null;
    editingComposerRef.current?.focus();
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingId]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsError(null);
    void Promise.all([
      listComments(task.id, controller.signal),
      listTaskActivities(task.id, controller.signal),
    ]).then(
      ([nextComments, nextActivities]) => {
        setComments(nextComments);
        setTaskActivities(nextActivities);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.activityKey, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    function receiveAttachmentOpenError(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      if (event.data.type !== "panel:attachment-open-error") return;
      setAttachmentsError(typeof event.data.payload?.error === "string"
        ? event.data.payload.error
        : ["无法打开附件，请重试。", "Could not open the attachment. Try again."]);
    }
    window.addEventListener("message", receiveAttachmentOpenError);
    return () => window.removeEventListener("message", receiveAttachmentOpenError);
  }, []);

  useEffect(() => {
    const key = `panel.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) panelStorage.setItem(key, text);
    else panelStorage.removeItem(key);
  }, [commentSegments, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  async function saveTask(changes: Partial<TaskUpdate>, property: string) {
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      return saved;
    } catch (error) {
      onError(issueMessageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  function openDatePicker(
    field: "startDate" | "dueDate",
    event: MouseEvent<HTMLLabelElement>,
  ) {
    const input = event.currentTarget.querySelector("input");
    if (!input || input.disabled) return;
    event.preventDefault();
    if (new URL(document.baseURI).searchParams.get("host") !== "codex" || window.parent === window) {
      input.showPicker();
      return;
    }

    const requestId = crypto.randomUUID();
    const rect = input.getBoundingClientRect();
    function receiveDate(event: MessageEvent) {
      if (event.source !== window.parent || event.data?.type !== "taskboard:date-picker-response") return;
      const payload = event.data.payload;
      if (payload?.requestId !== requestId || typeof payload.value !== "string") return;
      window.removeEventListener("message", receiveDate);
      const value = payload.value || null;
      void saveTask(
        field === "startDate"
          ? { startDate: value }
          : { dueDate: value, ...(value ? {} : { recurrence: null }) },
        field,
      );
    }
    window.addEventListener("message", receiveDate);
    postEmbeddedHostMessage({
      type: "taskboard:date-picker-request",
      payload: {
        requestId,
        value: input.value,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
    });
  }

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
    onError(null);
    try {
      const result = await mutation();
      const nextCurrent = result.task.id === currentTask.id
        ? result.task
        : result.relatedTask.id === currentTask.id
          ? result.relatedTask
          : null;
      if (nextCurrent) setCurrentTask(nextCurrent);
      return result;
    } catch (error) {
      onError(issueMessageFor(error));
      throw error;
    }
  }

  async function saveJiraProjects() {
    if (!jiraContext?.jira || savingProperty === "jiraProjects") return;
    setSavingProperty("jiraProjects");
    onError(null);
    try {
      await onEnsureJiraProjects(jiraProjectIds);
      const latest = await getJiraTaskContext(currentTask.id);
      if (!latest.jira) {
        setJiraContext(latest);
        return;
      }
      const context = await saveJiraTaskProjects(latest.jira, jiraProjectIds);
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
    } catch (error) {
      onError(issueMessageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function addJiraLink(
    taskId: string,
    jiraTask: Pick<Task, "id" | "version"> | null = jiraContext?.jira ?? null,
  ) {
    if (!jiraTask || jiraLinkSavingId) return;
    setJiraLinkSavingId(taskId);
    onError(null);
    try {
      const latest = await getJiraTaskContext(currentTask.id);
      const latestJira = latest.jira?.id === jiraTask.id
        ? latest.jira
        : latest.availableJira.find((item) => item.id === jiraTask.id);
      if (!latestJira) {
        setJiraContext(latest);
        return;
      }
      const context = await addJiraTaskLink(latestJira, taskId);
      if (currentTask.source === "jira") {
        setJiraContext(context);
        if (context.jira) setCurrentTask(context.jira);
      } else {
        setJiraContext(await getJiraTaskContext(currentTask.id));
      }
    } catch (error) {
      onError(issueMessageFor(error));
    } finally {
      setJiraLinkSavingId(null);
    }
  }

  async function removeJiraLink(taskId: string) {
    if (!jiraContext?.jira || jiraLinkSavingId) return;
    setJiraLinkSavingId(taskId);
    onError(null);
    try {
      const latest = await getJiraTaskContext(currentTask.id);
      if (!latest.jira) {
        setJiraContext(latest);
        return;
      }
      const context = await removeJiraTaskLink(latest.jira, taskId);
      if (currentTask.source === "jira") {
        setJiraContext(context);
        if (context.jira) setCurrentTask(context.jira);
      } else {
        setJiraContext(await getJiraTaskContext(currentTask.id));
      }
    } catch (error) {
      onError(issueMessageFor(error));
    } finally {
      setJiraLinkSavingId(null);
    }
  }

  async function createAndStartSimpleJira() {
    if (jiraSimpleStartSaving) return;
    setJiraSimpleStartSaving(true);
    onError(null);
    try {
      const latest = await getJiraTaskContext(currentTask.id);
      if (!latest.jira) {
        setJiraContext(latest);
        return;
      }
      const context = await startSimpleJiraTask(latest.jira);
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
    } catch (error) {
      onError(issueMessageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      onAiChatThreadsRefresh();
      setJiraSimpleStartSaving(false);
    }
  }

  function openExistingJiraPlanning(): boolean {
    const threadId = jiraContext?.plan?.threadId;
    if (!threadId) return false;
    if (currentTask.threadBinding?.threadId === threadId) {
      onOpenThread(currentTask.threadBinding);
      return true;
    }
    if (currentTask.legacyLocalThreadId === threadId) {
      onOpenLegacyLocalThread(threadId);
      return true;
    }
    const aiThread = aiChatThreads.find((thread) => thread.id === threadId);
    if (aiThread?.purpose === "formal" && aiThread.codexThreadId) {
      onOpenLegacyLocalThread(aiThread.codexThreadId);
      return true;
    }
    return false;
  }

  function requestJiraPlanning() {
    if (jiraPlanningSaving || openingThread) return;
    if (jiraContext?.plan && !jiraContext.plan.needsReview && openExistingJiraPlanning()) return;
    const linkedProjects = jiraContext?.projects ?? [];
    if (linkedProjects.length > 1) {
      setJiraPlanningProjectSearch("");
      setJiraPlanningProjectAction("planning");
      return;
    }
    void createOrContinueJiraPlanning(linkedProjects[0]?.id ?? null);
  }

  async function createOrContinueJiraPlanning(projectId: string | null) {
    if (jiraPlanningSaving) return;
    setJiraPlanningSaving(true);
    setJiraPlanningProjectAction(null);
    onError(null);
    try {
      const latest = await getJiraTaskContext(currentTask.id);
      if (!latest.jira) {
        setJiraContext(latest);
        return;
      }
      const result = await startJiraPlanning(latest.jira);
      const { context } = result;
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
      if (result.composerText && result.skills && context.jira) {
        await onOpenJiraPlanning(context.jira, projectId, {
          text: result.composerText,
          skills: result.skills,
        });
      }
    } catch (error) {
      onError(messageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      setJiraPlanningSaving(false);
    }
  }

  function requestJiraReplanning() {
    if (jiraLifecycleSaving || openingThread) return;
    const linkedProjects = jiraContext?.projects ?? [];
    if (linkedProjects.length > 1) {
      setJiraPlanningProjectSearch("");
      setJiraPlanningProjectAction("replan");
      return;
    }
    void createJiraReplanning(linkedProjects[0]?.id ?? null);
  }

  async function createJiraReplanning(projectId: string | null) {
    const lifecycle = jiraContext?.lifecycle;
    if (!jiraContext?.jira || lifecycle?.pending?.kind !== "reopened" || jiraLifecycleSaving) return;
    setJiraLifecycleSaving("replan");
    setJiraPlanningProjectAction(null);
    onError(null);
    try {
      const result = await resolveJiraLifecycle(jiraContext.jira.id, lifecycle.version, "replan");
      setJiraContext(result.context);
      if (result.context.jira) setCurrentTask(result.context.jira);
      if (result.composerText && result.skills && result.context.jira) {
        await onOpenJiraPlanning(result.context.jira, projectId, {
          text: result.composerText,
          skills: result.skills,
          replanLifecycleVersion: lifecycle.version,
        });
      }
    } catch (error) {
      onError(issueMessageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      setJiraLifecycleSaving(null);
    }
  }

  async function executeNow() {
    if (claiming) return;
    setClaiming(true);
    onError(null);
    try {
      const claimed = await claimTask(currentTask.id);
      setCurrentTask(claimed);
      onExecutionStarted(claimed.id);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setClaiming(false);
    }
  }

  async function applyJiraLifecycle(action: "pause" | "keep" | "rework" | "replan" | "migrate") {
    const lifecycle = jiraContext?.lifecycle;
    if (!jiraContext?.jira || !lifecycle?.pending || jiraLifecycleSaving) return;
    setJiraLifecycleSaving(action);
    onError(null);
    try {
      const result = await resolveJiraLifecycle(jiraContext.jira.id, lifecycle.version, action);
      const { context } = result;
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
    } catch (error) {
      onError(issueMessageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      onAiChatThreadsRefresh();
      setJiraLifecycleSaving(null);
    }
  }

  async function applyJiraAutoCompletion(action: "retry" | "accept_remote") {
    if (!jiraContext?.jira || jiraAutoCompletionSaving) return;
    setJiraAutoCompletionSaving(action);
    onError(null);
    try {
      const context = await resolveJiraAutoCompletion(jiraContext.jira.id, action);
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
    } catch (error) {
      onError(issueMessageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      setJiraAutoCompletionSaving(null);
    }
  }

  async function archiveConversations() {
    if (!jiraContext?.jira || !jiraContext.conversationArchive?.eligible || jiraArchiveSaving) return;
    setJiraArchiveSaving(true);
    onError(null);
    try {
      const context = await archiveJiraConversations(jiraContext.jira);
      setJiraContext(context);
      if (context.jira) setCurrentTask(context.jira);
    } catch (error) {
      onError(issueMessageFor(error));
      setJiraContext(await getJiraTaskContext(currentTask.id).catch(() => jiraContext));
    } finally {
      onAiChatThreadsRefresh();
      setJiraArchiveSaving(false);
    }
  }

  async function addMentionRelations(
    anchor: Task,
    segments: InlineMediaSegment[],
  ): Promise<Task> {
    let current = anchor;
    const relatedIds = new Set(current.relations.related.map((relation) => relation.id));
    for (const segment of segments) {
      if (segment.type !== "issue-reference" || !segment.taskId) continue;
      const relatedTaskId = segment.taskId;
      if (
        relatedTaskId === current.id
        || segment.projectId !== current.projectId
        || relatedIds.has(relatedTaskId)
      ) continue;
      const result = await applyRelationMutation(
        () => onAddRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
      relatedIds.add(relatedTaskId);
    }
    return current;
  }

  function mentionTaskIds(segments: InlineMediaSegment[]): Set<string> {
    return new Set(segments.flatMap((segment) => (
      segment.type === "issue-reference" && segment.taskId ? [segment.taskId] : []
    )));
  }

  function removedMentionTaskIds(
    previous: InlineMediaSegment[],
    next: InlineMediaSegment[],
  ): Set<string> {
    const nextIds = mentionTaskIds(next);
    return new Set([...mentionTaskIds(previous)].filter((taskId) => !nextIds.has(taskId)));
  }

  async function removeUnreferencedMentionRelations(
    anchor: Task,
    candidates: Set<string>,
  ): Promise<Task> {
    if (candidates.size === 0) return anchor;
    const savedComments = await listComments(anchor.id);
    const referencedIds = mentionTaskIds(createInlineMediaSegments(anchor.description, referenceTasks));
    for (const comment of savedComments) {
      for (const taskId of mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks))) {
        referencedIds.add(taskId);
      }
    }

    let current = anchor;
    for (const relatedTaskId of candidates) {
      if (
        referencedIds.has(relatedTaskId)
        || !current.relations.related.some((relation) => relation.id === relatedTaskId)
      ) continue;
      const relatedTask = await getTask(relatedTaskId);
      if (
        mentionTaskIds(createInlineMediaSegments(relatedTask.description, referenceTasks))
          .has(anchor.id)
      ) continue;
      const relatedComments = await listComments(relatedTaskId);
      if (relatedComments.some((comment) => (
        mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks)).has(anchor.id)
      ))) continue;
      const result = await applyRelationMutation(
        () => onRemoveRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
    }
    return current;
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError(["议题标题不能为空。", "Issue title cannot be empty."]);
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    if (savingProperty === "description") return;
    const draftDescription = serializeInlineMedia(descriptionSegments).trim();
    const inlineImages = inlineMediaImages(descriptionSegments);
    const inlineFiles = inlineMediaFiles(descriptionSegments);
    if (
      draftDescription === currentTask.description
      && inlineImages.length === 0
      && inlineFiles.length === 0
    ) {
      setEditingDescription(false);
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(currentTask.description, referenceTasks),
      descriptionSegments,
    );

    setSavingProperty("description");
    onError(null);
    try {
      const uploadedImages = await Promise.all(
        inlineImages.map((image) => uploadAttachment(currentTask.id, image.file, "inline")),
      );
      const uploadedFiles = await Promise.all(
        inlineFiles.map((file) => uploadAttachment(currentTask.id, file.file, "attachment")),
      );
      const resolvedDescription = resolveInlineAttachmentMarkdown(
        resolveInlineMediaMarkdown(
          draftDescription,
          inlineImages,
          uploadedImages,
        ),
        inlineFiles,
        uploadedFiles,
      ).trim();
      const saved = await onUpdate(currentTask, { description: resolvedDescription }).catch((error) => {
        onError(issueMessageFor(error));
        return null;
      });
      if (!saved) return;
      const savedWithAddedRelations = await addMentionRelations(saved, descriptionSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      setDescription(savedWithRelations.description);
      const nextAttachments = [
        ...attachments,
        ...[...uploadedImages, ...uploadedFiles].filter((attachment) => (
          !attachments.some((item) => item.id === attachment.id)
        )),
      ];
      setDescriptionSegments(createInlineMediaSegments(
        savedWithRelations.description,
        referenceTasks,
        nextAttachments,
      ));
      setAttachments(nextAttachments);
      setEditingDescription(false);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && commentInlineImages.length === 0 && commentInlineFiles.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [inlineAttachments, fileAttachments] = await Promise.all([
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file, "inline")),
        ),
        Promise.all(
          commentInlineFiles.map((file) => uploadCommentAttachment(comment.id, file.file, "attachment")),
        ),
      ]);
      const nextComment = commentInlineImages.length > 0 || commentInlineFiles.length > 0
        ? await updateComment(
            comment,
            resolveInlineAttachmentMarkdown(
              resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
              commentInlineFiles,
              fileAttachments,
            ),
          )
        : comment;
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      let relationAnchor = await getTask(currentTask.id);
      if (changeStatusToTodo) {
        const saved = await onUpdate(relationAnchor, { status: "todo" });
        setCurrentTask(saved);
        relationAnchor = saved;
        setChangeStatusToTodo(false);
      }
      const savedWithRelations = await addMentionRelations(relationAnchor, commentSegments);
      setCurrentTask(savedWithRelations);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function beginEdit(comment: Comment, source: HTMLElement) {
    if (savingCommentId !== null) return;
    const scrollContainer = source.closest<HTMLElement>(".issue-detail-scroll");
    editingCommentScrollPositionRef.current = scrollContainer
      ? { element: scrollContainer, top: scrollContainer.scrollTop }
      : null;
    editingUploadedAttachmentsRef.current.clear();
    setEditingId(comment.id);
    setEditingSegments(createInlineMediaSegments(comment.body, referenceTasks, comment.attachments));
    setActiveMenuId(null);
  }

  function endCommentEdit() {
    setEditingId(null);
    editingUploadedAttachmentsRef.current.clear();
  }

  async function saveComment(comment: Comment) {
    const body = editingDraft.trim();
    if (!body || (
      body === comment.body
      && editingInlineImages.length === 0
      && editingInlineFiles.length === 0
    )) {
      if (body === comment.body) endCommentEdit();
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(comment.body, referenceTasks),
      editingSegments,
    );
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const uploadedImages: Attachment[] = [];
      for (const image of editingInlineImages) {
        let attachment = editingUploadedAttachmentsRef.current.get(image.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, image.file, "inline");
          editingUploadedAttachmentsRef.current.set(image.id, attachment);
        }
        uploadedImages.push(attachment);
      }
      const uploadedFiles: Attachment[] = [];
      for (const file of editingInlineFiles) {
        let attachment = editingUploadedAttachmentsRef.current.get(file.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, file.file, "attachment");
          editingUploadedAttachmentsRef.current.set(file.id, attachment);
        }
        uploadedFiles.push(attachment);
      }
      const updated = await updateComment(
        comment,
        resolveInlineAttachmentMarkdown(
          resolveInlineMediaMarkdown(body, editingInlineImages, uploadedImages),
          editingInlineFiles,
          uploadedFiles,
        ).trim(),
      );
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      const relationAnchor = await getTask(currentTask.id);
      const savedWithAddedRelations = await addMentionRelations(relationAnchor, editingSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      endCommentEdit();
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    const removedMentionIds = mentionTaskIds(
      createInlineMediaSegments(pendingDelete.body, referenceTasks),
    );
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        currentTask,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  const handleAttachmentDownload = useCallback((
    event: MouseEvent<HTMLAnchorElement>,
    attachment: Attachment,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentsError(null);
    void downloadAttachmentFile(attachment).catch((error) => {
      setAttachmentsError(messageFor(error));
    });
  }, []);

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }
  const assigneeOptions = [currentTask.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  const linkedAiChatThreads = aiChatThreads.filter((thread) => (
    thread.origin.projectId === currentTask.projectId
    && thread.origin.issueId === currentTask.id
  ));
  const jiraPlanningThread = jiraContext?.plan?.threadId
    ? aiChatThreads.find((thread) => thread.id === jiraContext.plan?.threadId) ?? null
    : null;
  const conversationActivities = new Map<string, {
    thread: AiChatThread;
    roleLabel?: readonly [string, string];
  }>();
  for (const thread of linkedAiChatThreads) {
    const threadId = normalizeCodexThreadId(thread.codexThreadId);
    conversationActivities.set(threadId ? `codex:${threadId}` : `ai:${thread.id}`, {
      thread,
      roleLabel: currentTask.source === "jira" ? ["关联会话", "Linked conversation"] : undefined,
    });
  }
  if (jiraPlanningThread) {
    const threadId = normalizeCodexThreadId(jiraPlanningThread.codexThreadId);
    conversationActivities.set(threadId ? `codex:${threadId}` : `ai:${jiraPlanningThread.id}`, {
      thread: jiraPlanningThread,
      roleLabel: ["Jira 规划会话", "Jira planning conversation"],
    });
  }
  for (const ref of currentTask.conversationRefs) {
    const threadId = normalizeCodexThreadId(ref.threadId);
    if (!threadId || conversationActivities.has(`codex:${threadId}`)) continue;
    conversationActivities.set(`codex:${threadId}`, {
      thread: {
        id: `task-binding:${threadId}`,
        title: ref.title || currentTask.title,
        status: "idle",
        purpose: "formal",
        origin: {
          projectId: currentTask.projectId,
          projectName: "",
          workspacePath: "workspacePath" in ref ? ref.workspacePath : "",
          issueId: currentTask.id,
          issueIdentifier: currentTask.identifier,
        },
        codexThreadId: ref.threadId,
        model: "",
        reasoningEffort: "",
        sandbox: "workspace-write",
        archivedAt: null,
        createdAt: ref.updatedAt,
        updatedAt: ref.updatedAt,
      },
      roleLabel: currentTask.source === "jira" ? ["关联会话", "Linked conversation"] : undefined,
    });
  }
  const linkedJiraProjectIds = new Set(jiraContext?.projects.map((project) => project.id) ?? []);
  const selectedJiraProjectIds = new Set(jiraProjectIds);
  const linkedJiraProjectNames = jiraContext?.projects.map((project) => project.name).join(" · ") ?? "";
  const linkedJiraProjectSummary = jiraContext?.projects[0]?.name
    ?? text("尚未绑定仓库", "No repository linked");
  const additionalJiraProjectCount = Math.max((jiraContext?.projects.length ?? 0) - 1, 0);
  const selectedJiraProjects = jiraProjectIds.flatMap((projectId) => {
    const project = jiraRepositoryProjects.find((candidate) => candidate.id === projectId)
      ?? jiraContext?.projects.find((candidate) => candidate.id === projectId);
    return project ? [project] : [];
  });
  const addedJiraProjects = jiraRepositoryProjects.filter((project) => (
    selectedJiraProjectIds.has(project.id) && !linkedJiraProjectIds.has(project.id)
  ));
  const removedJiraProjects = jiraContext?.projects.filter((project) => (
    !selectedJiraProjectIds.has(project.id)
  )) ?? [];
  const jiraProjectsChanged = addedJiraProjects.length > 0 || removedJiraProjects.length > 0;
  const jiraSimpleStartCreating = jiraContext?.simpleStart?.status === "creating";
  const jiraSimpleStartComplete = jiraContext?.simpleStart?.status === "complete";
  const jiraLifecyclePending = jiraContext?.lifecycle?.pending ?? null;
  const jiraSimpleStartEnabled = jiraSimpleStartCreating || (
    currentTask.status === "todo"
    && (jiraContext?.projects.length ?? 0) > 0
    && !jiraProjectsChanged
    && !jiraContext?.plan
    && !jiraContext?.lifecycle?.duplicateOf
    && !jiraLifecyclePending
  );
  const jiraSimpleStartLabel = jiraSimpleStartSaving
    ? text("创建中…", "Creating…")
    : jiraSimpleStartComplete
      ? text("已创建并开始", "Created and started")
      : jiraSimpleStartCreating
        ? text("继续创建", "Continue creating")
      : jiraProjectsChanged
          ? text("先保存仓库变更", "Save repository changes first")
        : jiraLifecyclePending
          ? text("先处理生命周期提醒", "Resolve lifecycle notice first")
        : jiraContext?.plan
            ? text("已选择 AI 规划", "AI planning selected")
          : currentTask.status !== "todo"
            ? text("仅待认领可开始", "Only waiting Jira can start")
            : (jiraContext?.projects.length ?? 0) === 0
              ? text("先关联仓库", "Link a repository first")
              : text("创建并开始", "Create and start");
  const jiraPlanStatusLabel = !jiraContext?.plan
    ? text("尚未规划", "Not planned")
    : jiraContext.plan.needsReview
      ? text("需要复核", "Review required")
      : jiraContext.plan.status === "planning"
        ? text("规划中", "Planning")
        : jiraContext.plan.status === "review"
          ? text("待确认发布", "Awaiting publication")
          : jiraContext.plan.status === "publishing"
            ? text("发布未完成", "Publication interrupted")
            : text(
              `已发布 ${jiraContext.plan.items.length} 个 Issue`,
              `${jiraContext.plan.items.length} issues published`,
            );
  const jiraPlanningLabel = jiraPlanningSaving || openingThread
    ? text("正在打开…", "Opening…")
    : jiraContext?.simpleStart
      ? text("已选择一键执行", "Simple execution selected")
    : jiraContext?.plan?.needsReview
      ? text("重新复核", "Review again")
      : jiraContext?.plan
        ? text("继续规划", "Continue planning")
        : text("AI 规划", "Plan with AI");
  const jiraArchiveTitle = jiraContext?.conversationArchive?.reason === "jira_not_done"
    ? text("Jira 完成后才能归档对话", "Complete Jira before archiving conversations")
    : jiraContext?.conversationArchive?.reason === "no_linked_issues"
      ? text("至少关联一个 Issue 后才能归档", "Link at least one issue before archiving")
      : jiraContext?.conversationArchive?.reason === "linked_issues_incomplete"
        ? text("所有关联 Issue 均完成且未归档后才能归档对话", "Every linked issue must be done and unarchived")
        : jiraContext?.conversationArchive?.reason === "no_related_conversations"
          ? text("没有可归档的相关对话", "There are no related conversations to archive")
          : jiraContext?.conversationArchive?.reason === "already_archived"
            ? text("相关对话已归档", "Related conversations are already archived")
            : text("归档相关对话", "Archive related conversations");
  const claimState = currentTask.claim?.state;
  const claimActive = claimState === "queued" || claimState === "retry_wait" || claimState === "running";
  const claimEnabled = currentTask.source === "local" && currentTask.status === "todo" && !claimActive;
  const claimLabel = claiming
    ? text("正在加入队列…", "Adding to queue…")
    : claimState === "running"
      ? text("自动执行中", "Running automatically")
      : claimState === "queued"
        ? text("等待执行槽位", "Waiting for an execution slot")
        : claimState === "retry_wait"
          ? text("等待自动重试", "Waiting to retry")
          : claimState === "blocked"
            ? text("等待你的回复", "Waiting for your reply")
            : claimState === "failed"
              ? text("自动执行已停止", "Automatic execution stopped")
              : claimState === "completed"
                ? text("自动执行已完成", "Automatic execution completed")
                : currentTask.status === "todo"
                  ? text("立即执行", "Run now")
                  : text("仅待认领可执行", "Available only while waiting");
  const activityTimeline = [
    ...taskActivities.flatMap((activity) => activity.changes.map((change, index) => ({
      kind: "change" as const,
      id: `${activity.id}-${index}`,
      createdAt: activity.createdAt,
      activity,
      change,
    }))),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      id: comment.id,
      createdAt: comment.createdAt,
      comment,
    })),
    ...[...conversationActivities.values()].map(({ thread, roleLabel }) => ({
      kind: "ai-conversation" as const,
      id: thread.id,
      createdAt: thread.updatedAt,
      thread,
      roleLabel,
    })),
  ].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));

  return (
    <section
      className="issue-detail"
      aria-label={text(`${displayIdentifier} 议题详情`, `${displayIdentifier} issue details`)}
    >
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label={text("议题内容", "Issue content")}>
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label={text("议题标题", "Issue title")}
                  disabled={savingProperty === "title"}
                  onChange={(event) => {
                    setTitle(event.target.value.replace(/\n/g, ""));
                    resizeTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={() => void saveTitle()}
                />
                <IssueParentLink
                  task={currentTask}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onAddRelation(anchor, type, relatedTaskId),
                  )}
                  onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onRemoveRelation(anchor, type, relatedTaskId),
                  )}
                />
                {editingDescription ? (
                  <div
                    className="issue-description-composer"
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      void saveDescription();
                    }}
                  >
                    <InlineMediaComposer
                      ref={descriptionComposerRef}
                      segments={descriptionSegments}
                      mentionTasks={tasks}
                      referenceTasks={referenceTasks}
                      completionContext={{
                        projectId: currentTask.projectId,
                        surface: "issue-description",
                      }}
                      placeholder={text("添加描述…", "Add description…")}
                      ariaLabel={text("议题描述", "Issue description")}
                      disabled={savingProperty === "description"}
                      allowAttachments
                      onChange={setDescriptionSegments}
                      onError={onError}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setDescriptionSegments(createInlineMediaSegments(
                            currentTask.description,
                            referenceTasks,
                            attachments,
                          ));
                          setEditingDescription(false);
                        }
                      }}
                    />
                    <button
                      className="comment-attach-button issue-description-attach-button"
                      type="button"
                      disabled={savingProperty === "description"}
                      aria-label={text("添加描述附件", "Add description attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          descriptionComposerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label={text("编辑议题描述", "Edit issue description")}
                    onClick={(event) => {
                      if (event.target instanceof Element && event.target.closest("video")) return;
                      if (window.getSelection()?.isCollapsed === false) return;
                      descriptionCaretRef.current = null;
                      const range = event.currentTarget.ownerDocument.caretRangeFromPoint(
                        event.clientX,
                        event.clientY,
                      );
                      const node = range?.startContainer;
                      if (range && node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node)) {
                        const value = node.textContent ?? "";
                        const walker = event.currentTarget.ownerDocument.createTreeWalker(
                          event.currentTarget,
                          NodeFilter.SHOW_TEXT,
                        );
                        let occurrence = 0;
                        while (walker.nextNode() && walker.currentNode !== node) {
                          if (walker.currentNode.textContent === value) occurrence += 1;
                        }
                        descriptionCaretRef.current = {
                          text: value,
                          offset: range.startOffset,
                          occurrence,
                        };
                      }
                      const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                      descriptionScrollPositionRef.current = scrollContainer
                        ? { element: scrollContainer, top: scrollContainer.scrollTop }
                        : null;
                      setDescriptionSegments(createInlineMediaSegments(
                        description,
                        referenceTasks,
                        attachments,
                      ));
                      setEditingDescription(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        descriptionCaretRef.current = null;
                        const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                        descriptionScrollPositionRef.current = scrollContainer
                          ? { element: scrollContainer, top: scrollContainer.scrollTop }
                          : null;
                        setDescriptionSegments(createInlineMediaSegments(
                          description,
                          referenceTasks,
                          attachments,
                        ));
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description
                      ? <DescriptionDocument
                          value={description}
                          referenceTasks={referenceTasks}
                          onOpenTask={onOpenTask}
                          attachments={attachments}
                          enableImagePreview
                          onOpenAttachment={handleAttachmentDownload}
                        />
                      : text("添加描述…", "Add description…")}
                  </div>
                )}
              </div>
              {attachmentsError && (
                <div className="attachments-error" role="alert">
                  {typeof attachmentsError === "string"
                    ? attachmentsError
                    : text(attachmentsError[0], attachmentsError[1])}
                </div>
              )}
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">{text("活动", "Activity")}</h2>
                <span>{activityTimeline.length}</span>
              </header>

              <div className="activity-stream">
                <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
                  <span className="activity-rail-icon activity-creator-icon" aria-hidden="true">
                    <ActorAvatar
                      className="comment-avatar"
                      actor={{
                        type: currentTask.creatorType,
                        id: currentTask.creatorId,
                        name: currentTask.creatorName,
                        avatarUrl: currentTask.creatorAvatarUrl,
                      }}
                    />
                  </span>
                  <p>
                    <strong>{currentTask.creatorName}</strong>
                    {text(" 创建了此议题", " created this issue")}
                    <time title={exactTime(currentTask.createdAt, locale)}>{relativeTime(currentTask.createdAt, locale)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label={text("正在加载活动", "Loading activity")} aria-busy="true"><i /><i /></div>
                ) : activityTimeline.map((item) => {
                  if (item.kind === "ai-conversation") {
                    const formalThread = item.thread.purpose === "formal";
                    return (
                      <AiConversationActivity
                        key={`ai-conversation-${item.id}`}
                        thread={item.thread}
                        native={formalThread}
                        roleLabel={item.roleLabel}
                        onOpen={() => formalThread
                          ? item.thread.codexThreadId
                            ? onOpenLegacyLocalThread(item.thread.codexThreadId)
                            : onExecutionStarted(currentTask.id)
                          : onOpenAiChatThread(item.thread.id)}
                      />
                    );
                  }
                  if (item.kind === "change") {
                    const { activity, change } = item;
                    const fieldLabels = ACTIVITY_FIELD_LABELS[change.field];
                    const fieldLabel = fieldLabels
                      ? text(fieldLabels[0], fieldLabels[1])
                      : change.field;
                    const beforeValue = activityValue(
                      change.field,
                      change.before,
                      language,
                      locale,
                      text,
                      projects,
                    );
                    const afterValue = activityValue(
                      change.field,
                      change.after,
                      language,
                      locale,
                      text,
                      projects,
                    );
                    return (
                      <article
                        className={`activity-entry activity-change is-${activity.actorType}`}
                        key={item.id}
                      >
                        <span className="activity-rail-icon" aria-hidden="true">
                          <ActivityChangeIcon
                            field={change.field}
                            before={change.before}
                            after={change.after}
                          />
                        </span>
                        <p>
                          <strong>{activity.actorName}</strong>
                          {" "}
                          {change.field === "description" ? (
                            <>{text("更新了描述", "updated the description")}</>
                          ) : change.field === "relation" && change.before === null ? (
                            <>{text("添加了 ", "added ")}<span className="activity-change-value">{afterValue}</span></>
                          ) : change.field === "relation" && change.after === null ? (
                            <>{text("移除了 ", "removed ")}<span className="activity-change-value">{beforeValue}</span></>
                          ) : language === "zh" ? (
                            <>
                              将{fieldLabel}从
                              <span className="activity-change-value">{beforeValue}</span>
                              改为
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          ) : (
                            <>
                              {`changed ${fieldLabel} from `}
                              <span className="activity-change-value">{beforeValue}</span>
                              {" to "}
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          )}
                          <time title={exactTime(activity.createdAt, locale)}>{relativeTime(activity.createdAt, locale)}</time>
                        </p>
                      </article>
                    );
                  }
                  const comment = item.comment;
                  return (
                  <article
                    className={`comment-entry is-${comment.authorType}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
                    <div className="comment-card">
                      <header className="comment-header">
                        <ActorAvatar
                          className="comment-avatar"
                          actor={{
                            type: comment.authorType,
                            id: comment.authorId,
                            name: comment.authorName,
                            avatarUrl: comment.authorAvatarUrl,
                          }}
                        />
                        <strong>{comment.authorName}</strong>
                        <time title={exactTime(comment.createdAt, locale)}>{relativeTime(comment.createdAt, locale)}</time>
                        {comment.version > 1 && (
                          <span
                            className="comment-edited"
                            title={text(
                              `编辑于 ${exactTime(comment.updatedAt, locale)}`,
                              `Edited ${exactTime(comment.updatedAt, locale)}`,
                            )}
                          >
                            {text("已编辑", "Edited")}
                          </span>
                        )}
                        {editingId !== comment.id && (
                          <div className="comment-actions" data-comment-menu-root={comment.id}>
                            <button
                              type="button"
                              className="comment-menu-trigger"
                              aria-label={text("评论操作", "Comment actions")}
                              aria-haspopup="menu"
                              aria-expanded={activeMenuId === comment.id}
                              onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                            >
                              <MoreIcon color="currentColor" />
                            </button>
                            {activeMenuId === comment.id && (
                              <div className="comment-action-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={savingCommentId !== null}
                                  onClick={(event) => beginEdit(comment, event.currentTarget)}
                                >
                                  <EditIcon color="currentColor" />
                                  {text("编辑评论", "Edit comment")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                                >
                                  <DeleteIcon color="currentColor" />
                                  {text("删除评论", "Delete comment")}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <InlineMediaComposer
                            ref={editingComposerRef}
                            className="comment-inline-media"
                            segments={editingSegments}
                            mentionTasks={tasks}
                            referenceTasks={referenceTasks}
                            completionContext={{
                              projectId: currentTask.projectId,
                              surface: "comment",
                            }}
                            placeholder={text("编辑评论", "Edit comment")}
                            ariaLabel={text("编辑评论", "Edit comment")}
                            disabled={savingCommentId === comment.id}
                            allowAttachments
                            onChange={setEditingSegments}
                            onError={setCommentsError}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                endCommentEdit();
                                return;
                              }
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div className="comment-edit-actions">
                            <div className="composer-footer-leading">
                              <button
                                className="comment-attach-button"
                                type="button"
                                disabled={savingCommentId === comment.id}
                                aria-label={text("添加评论附件", "Add comment attachments")}
                                title={text("添加附件", "Add attachments")}
                                onClick={() => editCommentAttachmentInputRef.current?.click()}
                              >
                                <AttachmentIcon color="currentColor" />
                              </button>
                              <input
                                ref={editCommentAttachmentInputRef}
                                type="file"
                                multiple
                                hidden
                                onChange={(event) => {
                                  if (event.currentTarget.files) {
                                    editingComposerRef.current?.addFiles(event.currentTarget.files);
                                  }
                                  event.currentTarget.value = "";
                                }}
                              />
                            </div>
                            <div>
                              <button
                                className="button secondary"
                                type="button"
                                disabled={savingCommentId === comment.id}
                                onClick={endCommentEdit}
                              >
                                {text("取消", "Cancel")}
                              </button>
                              <button
                                className="button primary"
                                type="button"
                                disabled={!editingDraft.trim() || savingCommentId === comment.id}
                                onClick={() => void saveComment(comment)}
                              >
                                {savingCommentId === comment.id
                                  ? text("保存中…", "Saving…")
                                  : text("保存", "Save")}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        comment.body && (
                          <div className="comment-body">
                            <DescriptionDocument
                              value={comment.body}
                              referenceTasks={referenceTasks}
                              onOpenTask={onOpenTask}
                              attachments={comment.attachments}
                              enableImagePreview
                              onOpenAttachment={handleAttachmentDownload}
                            />
                          </div>
                        )
                      )}
                      {(comment.threadBinding || comment.legacyLocalThreadId) && (
                        <div className="comment-conversation-link">
                          <ConversationLink
                            threadId={comment.threadBinding?.threadId ?? comment.legacyLocalThreadId!}
                            onOpen={() => comment.threadBinding
                              ? onOpenThread(comment.threadBinding)
                              : onOpenLegacyLocalThread(comment.legacyLocalThreadId!)}
                            onCopy={onCopy}
                          />
                        </div>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>

              {commentsError && (
                <div className="comments-error" role="alert">
                  {typeof commentsError === "string"
                    ? commentsError
                    : text(commentsError[0], commentsError[1])}
                </div>
              )}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
                <div className="composer-author">
                  <ActorAvatar
                    className="comment-avatar"
                    actor={currentUser}
                  />
                  <strong>{currentUser.name}</strong>
                </div>
                <InlineMediaComposer
                  ref={composerRef}
                  className="comment-inline-media"
                  segments={commentSegments}
                  mentionTasks={tasks}
                  referenceTasks={referenceTasks}
                  completionContext={{
                    projectId: currentTask.projectId,
                    surface: "comment",
                  }}
                  placeholder={text("留下评论…", "Leave a comment…")}
                  ariaLabel={text("留下评论", "Leave a comment")}
                  allowAttachments
                  onChange={setCommentSegments}
                  onError={setCommentsError}
                  onKeyDown={handleSubmitShortcut}
                />
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={submitting}
                      aria-label={text("添加评论附件", "Add comment attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          composerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                  <div>
                    <div className="comment-status-action">
                      <span>{text("改变状态为-等待认领", "Change status to Todo")}</span>
                      <button
                        type="button"
                        className={`board-setting-switch${changeStatusToTodo ? " is-on" : ""}`}
                        role="switch"
                        aria-checked={changeStatusToTodo}
                        disabled={submitting}
                        onClick={() => setChangeStatusToTodo((current) => !current)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && commentInlineImages.length === 0
                        && commentInlineFiles.length === 0
                      ) || submitting}
                    >
                      {submitting ? text("发布中…", "Posting…") : text("评论", "Comment")}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label={text("议题属性", "Issue properties")}>
            <div className="detail-primary-actions">
              {currentTask.source === "local" && (
                <button
                  className="detail-run-action"
                  type="button"
                  disabled={!claimEnabled || claiming}
                  aria-busy={claiming || claimState === "running"}
                  onClick={() => void executeNow()}
                >
                  {claiming || claimState === "running"
                    ? <span className="ai-chat-spinner" aria-hidden="true" />
                    : <LinearIcon name={claimState === "completed" ? "check" : "play"} />}
                  <span>{claimLabel}</span>
                </button>
              )}
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                onClick={() => onOpenInThread(currentTask)}
              >
                <NewConversationIcon color="currentColor" />
                <span>{openingThread
                  ? text("正在打开…", "Opening…")
                  : text("在新对话打开", "Open in new conversation")}</span>
              </button>
              {currentTask.externalUrl && (
                <a
                  className="detail-copy-action detail-external-action"
                  href={currentTask.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="detail-copy-action-icon" aria-hidden="true">
                    <LinearIcon name="openExternal" />
                  </span>
                  <span className="detail-copy-action-label">{text("打开 Jira", "Open Jira")}</span>
                </a>
              )}
              <button
                className="detail-copy-action"
                type="button"
                title={text(
                  `复制议题 ID ${displayIdentifier}`,
                  `Copy issue ID ${displayIdentifier}`,
                )}
                onClick={() => onCopy(
                  displayIdentifier,
                  text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copied.`),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制 ID", "Copy ID")}</span>
                <span className="detail-copy-identifier">{displayIdentifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(
                    document.baseURI,
                    currentTask.projectId,
                    currentTask.identifier,
                  ).href,
                  text("议题链接已复制。", "Issue link copied."),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制链接", "Copy link")}</span>
              </button>
            </div>
            <h2>{text("属性", "Properties")}</h2>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("项目", "Project")}</span>
              <TaskPropertyPicker
                value={currentTask.projectId}
                options={projects.map((project) => ({
                  value: project.id,
                  label: project.name,
                  icon: <ProjectIcon />,
                }))}
                open={propertyMenu === "project"}
                disabled={currentTask.source === "jira" || savingProperty === "projectId" || projects.length < 2}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("项目", "Project")}
                onOpenChange={(open) => setPropertyMenu(open ? "project" : null)}
                onChange={(projectId) => void saveTask({ projectId }, "projectId")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("状态", "Status")}</span>
              <TaskPropertyPicker
                value={currentTask.status}
                options={TASK_STATUSES.map((status) => ({
                  value: status,
                  label: taskStatusLabel(language, status),
                  icon: <StatusIcon status={status} color="currentColor" size={14} />,
                }))}
                open={propertyMenu === "status"}
                disabled={savingProperty === "status"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                triggerContent={(
                  <>
                    <span className="task-property-trigger-icon">
                      <StatusIcon status={currentTask.status} color="currentColor" size={14} />
                    </span>
                    <span className="task-property-trigger-label">
                      {taskStatusLabel(language, currentTask.status)}
                    </span>
                  </>
                )}
                ariaLabel={text("状态", "Status")}
                onOpenChange={(open) => setPropertyMenu(open ? "status" : null)}
                onChange={(status) => void saveTask({ status }, "status")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("优先级", "Priority")}</span>
              <TaskPropertyPicker
                value={currentTask.priority}
                options={TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: taskPriorityLabel(language, priority),
                  icon: <PriorityIcon priority={priority} size={14} />,
                  className: `priority-${priority}`,
                }))}
                open={propertyMenu === "priority"}
                disabled={savingProperty === "priority"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("优先级", "Priority")}
                onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <span className="detail-property-label">{text("负责人", "Assignee")}</span>
              <TaskPropertyPicker
                value={actorKey(currentTask.assignee)}
                options={assigneeOptions.map((actor) => ({
                  value: actorKey(actor),
                  label: actor.id === currentUser.id
                    ? `${actor.name}${text("（我）", " (me)")}`
                    : actor.name,
                  icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
                }))}
                open={propertyMenu === "assignee"}
                disabled={currentTask.source === "jira" || savingProperty === "assignee"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("负责人", "Assignee")}
                onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
                onChange={(value) => {
                  const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget }, "assignee");
                }}
              />
            </div>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LabelIcon color="currentColor" size={14} />
              </span>
              <span className="detail-property-label">{text("标签", "Labels")}</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={propertyMenu === "labels"}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                showSelectedAsChips
                placeholder={text("添加标签…", "Add labels…")}
                onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
                onCreateLabel={onCreateLabel}
                onDeleteLabel={currentTask.source === "jira" ? undefined : onDeleteLabel}
              />
            </div>
            <div className="detail-property-row development-property">
              <span className="detail-property-label">{text("开发上下文", "Development context")}</span>
              <TaskPropertyPicker
                value={contextValue(currentTask.developmentContext)}
                options={[
                  {
                    value: "",
                    label: developmentScanLoading
                      ? text("正在扫描 Git…", "Scanning Git…")
                      : text("未绑定", "Not linked"),
                    icon: <BranchIcon color="currentColor" size={14} />,
                  },
                  ...developmentOptions.map((context) => ({
                    value: contextValue(context),
                    label: contextLabel(context, text),
                    icon: context.type === "branch"
                      ? <BranchIcon color="currentColor" size={14} />
                      : <LinearIcon name="folder" />,
                  })),
                ]}
                open={propertyMenu === "development"}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                className="detail-property-picker"
                popoverClassName="development-context-popover"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("开发上下文", "Development context")}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onOpenChange={(open) => setPropertyMenu(open ? "development" : null)}
                onChange={(value) => void saveTask({
                  developmentContext: value ? JSON.parse(value) as DevelopmentContext : null,
                }, "developmentContext")}
              />
            </div>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("startDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("开始日期", "Start date")}</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("dueDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("截止日期", "Due date")}</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value ? {} : { recurrence: null }),
                }, "dueDate")}
              />
            </label>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("重复", "Recurrence")}</span>
              <TaskPropertyPicker
                value={currentTask.recurrence?.unit ?? ""}
                options={[
                  { value: "", label: text("不重复", "Does not repeat"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "day", label: text("每天", "Daily"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "week", label: text("每周", "Weekly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "month", label: text("每月", "Monthly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "year", label: text("每年", "Yearly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                ]}
                open={propertyMenu === "recurrence"}
                disabled={savingProperty === "recurrence"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("重复", "Recurrence")}
                onOpenChange={(open) => setPropertyMenu(open ? "recurrence" : null)}
                onChange={(value) => {
                  const unit = value as Recurrence["unit"] | "";
                  const changes: Partial<TaskDraft> = {
                    recurrence: unit ? { interval: 1, unit } : null,
                  };
                  if (unit && !currentTask.dueDate) {
                    const dueDate = new Date();
                    dueDate.setDate(dueDate.getDate() + 7);
                    changes.dueDate = new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60_000)
                      .toISOString().slice(0, 10);
                  }
                  void saveTask(changes, "recurrence");
                }}
              />
            </div>
            {jiraAvailable && (currentTask.source === "jira" ? (
              <section className="jira-context-section jira-context-overview" aria-label={text("Jira 关联", "Jira links")}>
                <h2>Jira</h2>
                <button className="jira-context-manage" type="button" onClick={() => {
                  setJiraProjectSearch("");
                  setJiraManagerOpen(true);
                }}>
                  <LinearIcon name="link" />
                  <span>
                    <strong>{currentTask.externalStatus ?? text("未知状态", "Unknown status")}</strong>
                    <small className="jira-context-repositories" title={linkedJiraProjectNames}>
                      <span>{jiraContextLoading
                        ? text("加载仓库…", "Loading repositories…")
                        : linkedJiraProjectSummary}</span>
                      {!jiraContextLoading && additionalJiraProjectCount > 0 && (
                        <em>+{additionalJiraProjectCount}</em>
                      )}
                    </small>
                    <small>{text(
                      `${jiraContext?.issues.length ?? 0} 个 Issue · ${jiraPlanStatusLabel}`,
                      `${jiraContext?.issues.length ?? 0} issues · ${jiraPlanStatusLabel}`,
                    )}</small>
                  </span>
                  <b>{text("管理关联", "Manage")}</b>
                  <LinearIcon name="chevronRight" />
                </button>
                {jiraLifecyclePending && (
                  <div className="jira-lifecycle-alert" role="alert">
                    <p>{jiraLifecyclePending.kind === "waiting"
                      ? text("Jira 已回到待认领。建议暂停关联 Issue，等待再次授权。", "Jira returned to waiting. Pause linked issues until it is authorized again.")
                      : jiraLifecyclePending.kind === "ended"
                        ? text("Jira 已提前结束，但仍有关联 Issue 未完成。建议暂停并保留现有成果。", "Jira ended before its linked issues. Pause them and keep the existing work.")
                        : jiraLifecyclePending.kind === "reopened"
                          ? text("Jira 已重新打开。旧 Issue 和对话会保留为历史，请创建新的返工 Issue。", "Jira reopened. Keep the old issues and conversations as history, then create new rework issues.")
                          : jiraContext?.lifecycle?.duplicateOf?.externalKey
                            ? text(`此 Jira 是 ${jiraContext.lifecycle.duplicateOf.externalKey} 的重复任务。`, `This Jira duplicates ${jiraContext.lifecycle.duplicateOf.externalKey}.`)
                            : text("Jira 标记为重复任务，但 canonical Jira 不可用。原关联会保持不变。", "Jira is marked duplicate, but its canonical issue is unavailable. Existing links will stay unchanged.")}</p>
                    <div>
                      {(jiraLifecyclePending.kind !== "reopened" || jiraContext?.plan) && (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={jiraLifecycleSaving !== null}
                          onClick={() => void applyJiraLifecycle(
                            jiraLifecyclePending.kind === "reopened" ? "rework" : "keep"
                          )}
                        >{jiraLifecycleSaving === (jiraLifecyclePending.kind === "reopened" ? "rework" : "keep")
                            ? text("处理中…", "Applying…")
                            : jiraLifecyclePending.kind === "reopened"
                              ? text("创建返工 Issue", "Create rework issues")
                            : jiraLifecyclePending.kind === "duplicate"
                              ? text("保留原关联", "Keep existing links")
                              : text("保持现状", "Keep current state")}</button>
                      )}
                      <button
                        className="button primary"
                        type="button"
                        disabled={jiraLifecycleSaving !== null || (
                          jiraLifecyclePending.kind === "duplicate"
                          && !jiraContext?.lifecycle?.duplicateOf?.accessible
                        )}
                        aria-busy={jiraLifecycleSaving !== null}
                        onClick={() => jiraLifecyclePending.kind === "reopened" && jiraContext?.plan
                          ? requestJiraReplanning()
                          : void applyJiraLifecycle(
                              jiraLifecyclePending.kind === "reopened"
                                ? "rework"
                                : jiraLifecyclePending.kind === "duplicate"
                                  ? "migrate"
                                  : "pause",
                            )}
                      >{jiraLifecycleSaving
                          ? <><span className="ai-chat-spinner" aria-hidden="true" />{text("处理中…", "Applying…")}</>
                          : jiraLifecyclePending.kind === "reopened"
                            ? jiraContext?.plan
                              ? text("重新规划", "Plan again")
                              : text("创建返工 Issue", "Create rework issues")
                            : jiraLifecyclePending.kind === "duplicate"
                              ? text("迁移到 canonical Jira", "Move to canonical Jira")
                              : text("暂停关联 Issue", "Pause linked issues")}</button>
                    </div>
                  </div>
                )}
                {jiraContext?.autoCompletion && jiraContext.autoCompletion.state !== "dismissed" && (
                  <div className={`jira-auto-completion is-${jiraContext.autoCompletion.state}`} role="status">
                    <div>
                      <strong>{jiraContext.autoCompletion.state === "completed"
                        ? text("Jira 已自动完成", "Jira completed automatically")
                        : jiraContext.autoCompletion.state === "conflict"
                          ? text("Jira 已在远端变化", "Jira changed remotely")
                          : jiraContext.autoCompletion.state === "failed"
                            ? text("Jira 自动完成失败", "Jira automatic completion failed")
                            : jiraContext.autoCompletion.state === "retry_wait"
                              ? text("等待重试 Jira", "Waiting to retry Jira")
                              : text("正在完成 Jira", "Completing Jira")}</strong>
                      <small>{jiraContext.autoCompletion.state === "conflict"
                        ? <>{text(
                            `远端当前为“${jiraContext.autoCompletion.remoteStatus ?? "未知"}”。`,
                            `The remote status is “${jiraContext.autoCompletion.remoteStatus ?? "Unknown"}”.`,
                          )}<br />{text(
                            `Panel 版本：${jiraContext.autoCompletion.expectedUpdatedAt
                              ? exactTime(jiraContext.autoCompletion.expectedUpdatedAt, locale)
                              : "未知"} → Jira 版本：${jiraContext.autoCompletion.remoteUpdatedAt
                              ? exactTime(jiraContext.autoCompletion.remoteUpdatedAt, locale)
                              : "未知"}。请选择接受远端或仍然完成。`,
                            `Panel version: ${jiraContext.autoCompletion.expectedUpdatedAt
                              ? exactTime(jiraContext.autoCompletion.expectedUpdatedAt, locale)
                              : "Unknown"} → Jira version: ${jiraContext.autoCompletion.remoteUpdatedAt
                              ? exactTime(jiraContext.autoCompletion.remoteUpdatedAt, locale)
                              : "Unknown"}. Accept it or complete Jira anyway.`,
                          )}</>
                        : jiraContext.autoCompletion.error?.message
                          ?? text(
                            "所有关联 Issue 均已完成，Panel 正在通过 Jira REST API 确认结果。",
                            "Every linked issue is done. Panel is confirming the result through the Jira REST API.",
                          )}</small>
                    </div>
                    {(jiraContext.autoCompletion.state === "conflict" || jiraContext.autoCompletion.state === "failed") && (
                      <div>
                        {jiraContext.autoCompletion.state === "conflict" && (
                          <button
                            className="button secondary"
                            type="button"
                            disabled={jiraAutoCompletionSaving !== null}
                            onClick={() => void applyJiraAutoCompletion("accept_remote")}
                          >{jiraAutoCompletionSaving === "accept_remote"
                              ? text("处理中…", "Applying…")
                              : text("接受远端", "Accept remote")}</button>
                        )}
                        <button
                          className="button primary"
                          type="button"
                          disabled={jiraAutoCompletionSaving !== null}
                          aria-busy={jiraAutoCompletionSaving === "retry"}
                          onClick={() => void applyJiraAutoCompletion("retry")}
                        >{jiraAutoCompletionSaving === "retry"
                            ? <><span className="ai-chat-spinner" aria-hidden="true" />{text("重试中…", "Retrying…")}</>
                            : jiraContext.autoCompletion.state === "conflict"
                              ? text("仍然完成", "Complete anyway")
                              : text("重试", "Retry")}</button>
                      </div>
                    )}
                  </div>
                )}
                <div className="jira-context-actions">
                  <button
                    className={`jira-planning-button${jiraContext?.plan?.needsReview ? " needs-review" : ""}`}
                    type="button"
                    disabled={
                      jiraContextLoading
                      || jiraPlanningSaving
                      || openingThread
                      || Boolean(jiraContext?.simpleStart)
                      || Boolean(jiraContext?.lifecycle?.duplicateOf)
                      || Boolean(jiraLifecyclePending)
                    }
                    aria-busy={jiraPlanningSaving || openingThread}
                    onClick={requestJiraPlanning}
                  >
                    {jiraPlanningSaving || openingThread
                      ? <span className="ai-chat-spinner" aria-hidden="true" />
                      : <ConversationIcon />}
                    <span>{jiraPlanningLabel}</span>
                  </button>
                  <button
                    className={`jira-simple-start-button${jiraSimpleStartComplete ? " is-complete" : ""}`}
                    type="button"
                    disabled={jiraContextLoading || jiraSimpleStartSaving || jiraSimpleStartComplete || !jiraSimpleStartEnabled}
                    aria-busy={jiraSimpleStartSaving}
                    onClick={() => void createAndStartSimpleJira()}
                  >
                    {jiraSimpleStartSaving
                      ? <span className="ai-chat-spinner" aria-hidden="true" />
                      : <LinearIcon name={jiraSimpleStartComplete ? "check" : "play"} />}
                    <span>{jiraSimpleStartLabel}</span>
                  </button>
                  <button
                    className={`jira-archive-button${jiraContext?.conversationArchive?.reason === "already_archived" ? " is-complete" : ""}`}
                    type="button"
                    title={jiraArchiveTitle}
                    aria-describedby={
                      jiraContext?.conversationArchive && !jiraContext.conversationArchive.eligible
                        ? "jira-archive-status"
                        : undefined
                    }
                    disabled={
                      jiraContextLoading
                      || jiraArchiveSaving
                      || !jiraContext?.conversationArchive?.eligible
                    }
                    aria-busy={jiraArchiveSaving}
                    onClick={() => void archiveConversations()}
                  >
                    {jiraArchiveSaving
                      ? <span className="ai-chat-spinner" aria-hidden="true" />
                      : jiraContext?.conversationArchive?.reason === "already_archived"
                        ? <LinearIcon name="check" />
                        : <ConversationIcon />}
                    <span>{jiraArchiveSaving
                      ? text("归档中…", "Archiving…")
                      : jiraContext?.conversationArchive?.reason === "already_archived"
                        ? text("对话已归档", "Conversations archived")
                        : text("归档对话", "Archive conversations")}</span>
                  </button>
                  {jiraContext?.conversationArchive && !jiraContext.conversationArchive.eligible && (
                    <small id="jira-archive-status" className="jira-archive-status">
                      {jiraArchiveTitle}
                    </small>
                  )}
                </div>
              </section>
            ) : jiraContext?.jira ? (
              <section className="jira-context-section jira-context-summary" aria-label={text("关联 Jira", "Linked Jira")}>
                <h2>{text("关联 Jira", "Linked Jira")}</h2>
                <a href={buildIssueUrl(
                  window.location.href,
                  jiraContext.jira.projectId,
                  jiraContext.jira.identifier,
                ).toString()}>
                  <LinearIcon name="link" />
                  <span>
                    <strong>{jiraContext.jira.externalKey ?? jiraContext.jira.identifier}</strong>
                    <small>{jiraContext.jira.title}</small>
                  </span>
                  <b>{jiraContext.jira.externalStatus ?? taskStatusLabel(language, jiraContext.jira.status)}</b>
                  <LinearIcon name="chevronRight" />
                </a>
                {jiraContext.plan?.needsReview && <p className="jira-project-diff">{text(
                  ["in_progress", "in_review", "blocked", "done"].includes(currentTask.status)
                    ? "Jira 规划需要复核；此 Issue 已开始，不会自动取消。"
                    : "Jira 规划需要复核；此 Issue 已暂停进入执行。",
                  ["in_progress", "in_review", "blocked", "done"].includes(currentTask.status)
                    ? "The Jira plan requires review. This started issue will not be canceled automatically."
                    : "The Jira plan requires review. This issue is paused from execution.",
                )}</p>}
                <button
                  type="button"
                  disabled={jiraLinkSavingId !== null}
                  onClick={() => void removeJiraLink(currentTask.id)}
                >
                  {jiraLinkSavingId ? text("解除中…", "Unlinking…") : text("解除关联", "Unlink")}
                </button>
              </section>
            ) : (jiraContext?.availableJira.length ?? 0) > 0 ? (
              <section className="jira-context-section jira-context-summary" aria-label={text("关联 Jira", "Link Jira")}>
                <h2>{text("关联 Jira", "Link Jira")}</h2>
                <select
                  value=""
                  disabled={jiraLinkSavingId !== null}
                  onChange={(event) => {
                    const jira = jiraContext?.availableJira.find((item) => item.id === event.target.value);
                    if (jira) void addJiraLink(currentTask.id, jira);
                  }}
                >
                  <option value="">{text("选择 Jira…", "Choose Jira…")}</option>
                  {jiraContext?.availableJira.map((jira) => (
                    <option value={jira.id} key={jira.id}>
                      {jira.externalKey ?? jira.identifier} · {jira.title}
                    </option>
                  ))}
                </select>
              </section>
            ) : null)}
            <IssueRelationSidebar
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />
            <div className="detail-timestamps">
              <span>{text(
                `创建于 ${exactTime(currentTask.createdAt, locale)}`,
                `Created ${exactTime(currentTask.createdAt, locale)}`,
              )}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>{text(
                `更新于 ${exactTime(currentTask.updatedAt, locale)}`,
                `Updated ${exactTime(currentTask.updatedAt, locale)}`,
              )}</span>}
            </div>
          </aside>
        </div>
      </div>

      {jiraPlanningProjectAction && currentTask.source === "jira" && (
        <div className="delete-backdrop jira-manager-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !jiraPlanningSaving) {
            setJiraPlanningProjectAction(null);
          }
        }}>
          <div
            className="jira-manager-dialog jira-planning-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="jira-planning-project-title"
          >
            <header>
              <div>
                <h2 id="jira-planning-project-title">{text("选择规划仓库", "Choose planning repository")}</h2>
                <p>{text("新对话会在所选项目下创建", "The new conversation will be created in this project")}</p>
              </div>
              <button
                type="button"
                aria-label={text("关闭", "Close")}
                disabled={jiraPlanningSaving}
                onClick={() => setJiraPlanningProjectAction(null)}
              ><LinearIcon name="close" /></button>
            </header>
            <div className="jira-planning-project-body">
              <ProjectSelectionMenu
                ariaLabel={text("选择规划仓库", "Choose planning repository")}
                items={jiraContext?.projects ?? []}
                selectedIds={new Set<string>()}
                searchValue={jiraPlanningProjectSearch}
                searchLabel={text("按名称筛选仓库", "Filter repositories by name")}
                searchPlaceholder={text("筛选仓库…", "Filter repositories…")}
                clearSearchLabel={text("清除仓库筛选", "Clear repository filter")}
                emptyMessage={text("没有匹配仓库", "No matching repositories")}
                disabled={jiraPlanningSaving}
                onSearchChange={setJiraPlanningProjectSearch}
                onSelect={(project) => void (jiraPlanningProjectAction === "replan"
                  ? createJiraReplanning(project.id)
                  : createOrContinueJiraPlanning(project.id))}
              />
            </div>
            <footer>
              <span>{text("只影响这次规划对话", "This only affects this planning conversation")}</span>
              <button
                className="button secondary"
                type="button"
                disabled={jiraPlanningSaving}
                onClick={() => setJiraPlanningProjectAction(null)}
              >{text("取消", "Cancel")}</button>
            </footer>
          </div>
        </div>
      )}

      {jiraAvailable && jiraManagerOpen && currentTask.source === "jira" && (
        <div className="delete-backdrop jira-manager-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && savingProperty !== "jiraProjects") {
            setJiraProjectIds(jiraContext?.projects.map((project) => project.id) ?? []);
            setJiraProjectSearch("");
            setJiraManagerOpen(false);
          }
        }}>
          <div className="jira-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="jira-manager-title">
            <header>
              <div>
                <h2 id="jira-manager-title">{text("管理 Jira 关联", "Manage Jira links")}</h2>
                <p>{currentTask.externalKey} · {currentTask.title}</p>
              </div>
              <button
                type="button"
                aria-label={text("关闭", "Close")}
                disabled={savingProperty === "jiraProjects"}
                onClick={() => {
                  setJiraProjectIds(jiraContext?.projects.map((project) => project.id) ?? []);
                  setJiraProjectSearch("");
                  setJiraManagerOpen(false);
                }}
              ><LinearIcon name="close" /></button>
            </header>
            <div className="jira-manager-body">
              <section>
                <h3>{text("仓库", "Repositories")}</h3>
                {jiraContextLoading ? (
                  <p className="jira-context-empty">{text("加载中…", "Loading…")}</p>
                ) : jiraRepositoryProjects.length > 0 ? (
                  <>
                    <div className="jira-selected-projects" aria-live="polite">
                      <strong>{jiraProjectsChanged
                        ? text("当前选择", "Current selection")
                        : text("已绑定", "Linked")}</strong>
                      {selectedJiraProjects.length > 0 ? (
                        <div>
                          {selectedJiraProjects.map((project) => (
                            <span className="jira-selected-project" key={project.id} title={project.name}>
                              <LinearIcon name="folder" />
                              <span>{project.name}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <small>{text("尚未选择仓库", "No repository selected")}</small>
                      )}
                    </div>
                    <ProjectSelectionMenu
                      className="jira-project-picker"
                      ariaLabel={text("关联仓库", "Linked repositories")}
                      items={jiraRepositoryProjects}
                      selectedIds={selectedJiraProjectIds}
                      searchValue={jiraProjectSearch}
                      searchLabel={text("按名称筛选仓库", "Filter repositories by name")}
                      searchPlaceholder={text("筛选仓库…", "Filter repositories…")}
                      clearSearchLabel={text("清除仓库筛选", "Clear repository filter")}
                      emptyMessage={text("没有匹配仓库", "No matching repositories")}
                      disabled={savingProperty === "jiraProjects"}
                      multiple
                      onSearchChange={setJiraProjectSearch}
                      onSelect={(project) => setJiraProjectIds((current) => (
                        current.includes(project.id)
                          ? current.filter((projectId) => projectId !== project.id)
                          : [...current, project.id]
                      ))}
                    />
                  </>
                ) : (
                  <p className="jira-context-empty">{text("暂无已连接本地仓库", "No local repositories connected")}</p>
                )}
                {jiraProjectsChanged && (
                  <p className="jira-project-diff">
                    {[
                      ...addedJiraProjects.map((project) => text(`新增 ${project.name}`, `Add ${project.name}`)),
                      ...removedJiraProjects.map((project) => text(`移除 ${project.name}`, `Remove ${project.name}`)),
                    ].join(" · ")}
                  </p>
                )}
                <div className={`jira-sync-health${currentTask.externalSyncError ? " is-error" : ""}`}>
                  <span>{text("Jira 状态", "Jira status")}</span>
                  <strong>{currentTask.externalStatus ?? text("未知", "Unknown")}</strong>
                  <span>{text("同步", "Sync")}</span>
                  <strong>{currentTask.externalSyncError
                    ? text("失败", "Failed")
                    : currentTask.externalSyncedAt
                      ? exactTime(currentTask.externalSyncedAt, locale)
                      : text("尚未同步", "Not synced")}</strong>
                  {currentTask.externalSyncError && <small>{currentTask.externalSyncError}</small>}
                </div>
                {jiraContext?.plan && (
                  <div className={`jira-plan-summary${jiraContext.plan.needsReview ? " needs-review" : ""}`}>
                    <div>
                      <span>{text("规划", "Planning")}</span>
                      <strong>{jiraPlanStatusLabel}</strong>
                      <button type="button" onClick={requestJiraPlanning}>
                        {text("打开对话", "Open conversation")}
                      </button>
                    </div>
                    {jiraContext.plan.needsReview && <p>{text(
                      "Jira 内容或关联仓库已变化；未开始 Issue 已暂停进入执行，已开始成果只告警且不会自动取消。",
                      "Jira content or linked repositories changed. Unstarted issues are paused; started work is warned and will not be canceled automatically.",
                    )}</p>}
                    {jiraContext.plan.spec && (
                      <details>
                        <summary>Spec</summary>
                        <div className="jira-plan-spec">
                          <DescriptionDocument
                            value={jiraContext.plan.spec}
                            referenceTasks={referenceTasks}
                            onOpenTask={onOpenTask}
                          />
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </section>
              <section>
                <h3>{text("执行 Issue", "Execution issues")}</h3>
                <div className="jira-linked-issues">
                  {jiraContext?.issues.map((issue) => (
                    <div className="jira-linked-row" key={issue.id}>
                      <button type="button" onClick={() => onOpenTask(issue)}>
                        <StatusIcon status={issue.status} />
                        <span>{issue.identifier}</span>
                        <strong>{projects.find((project) => project.id === issue.projectId)?.name ?? issue.projectId} · {issue.title}</strong>
                      </button>
                      <button
                        className="jira-link-remove"
                        type="button"
                        disabled={jiraLinkSavingId !== null}
                        title={text("解除 Jira 关联", "Unlink Jira")}
                        aria-label={text(`解除 ${issue.identifier} 的 Jira 关联`, `Unlink Jira from ${issue.identifier}`)}
                        onClick={() => void removeJiraLink(issue.id)}
                      ><LinearIcon name="close" /></button>
                    </div>
                  ))}
                  {jiraContext?.issues.length === 0 && (
                    <p className="jira-context-empty">{text("尚未关联执行 Issue", "No execution issues linked")}</p>
                  )}
                </div>
                {(jiraContext?.availableIssues.length ?? 0) > 0 && (
                  <label className="jira-issue-link-select">
                    <span>{text("关联已有 Issue", "Link existing issue")}</span>
                    <select
                      value=""
                      disabled={jiraLinkSavingId !== null}
                      onChange={(event) => {
                        if (event.target.value) void addJiraLink(event.target.value);
                      }}
                    >
                      <option value="">{text("选择 Issue…", "Choose issue…")}</option>
                      {jiraContext?.availableIssues.map((issue) => (
                        <option value={issue.id} key={issue.id}>{issue.identifier} · {issue.title}</option>
                      ))}
                    </select>
                  </label>
                )}
              </section>
            </div>
            <footer>
              <span>{jiraProjectsChanged
                ? text("仓库变更仅在保存后生效", "Repository changes apply only after saving")
                : text("不会自动创建、迁移或删除 Issue", "Issues are never created, moved, or deleted automatically")}</span>
              <div>
                <button className="button secondary" type="button" onClick={() => {
                  setJiraProjectIds(jiraContext?.projects.map((project) => project.id) ?? []);
                  setJiraProjectSearch("");
                  setJiraManagerOpen(false);
                }}>{text("关闭", "Close")}</button>
                <button
                  className="button primary"
                  type="button"
                  disabled={!jiraProjectsChanged || savingProperty === "jiraProjects"}
                  onClick={() => void saveJiraProjects()}
                >{savingProperty === "jiraProjects" ? text("保存中…", "Saving…") : text("保存仓库变更", "Save repositories")}</button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">{text("删除这条评论？", "Delete this comment?")}</h2>
            <p>{text("此操作无法撤销。", "This action cannot be undone.")}</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>{text("取消", "Cancel")}</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? text("删除中…", "Deleting…") : text("删除评论", "Delete comment")}</button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}
