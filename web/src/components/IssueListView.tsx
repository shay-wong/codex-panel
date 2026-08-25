import {
  useEffect,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { assigneeTargetForActor } from "../actors";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { labelPresentation } from "../labels";
import type { TaskCardPresentation } from "../taskConversations";
import { TASK_PRIORITIES, TASK_STATUSES, type ActorIdentity, type Task, type TaskDraft, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import { DueDateIcon, PriorityIcon, StatusIcon } from "./SemanticIcons";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskPropertyPicker } from "./TaskPropertyPicker";

type ListCollapseMode = "always-expanded" | "remember" | "always-collapsed";

interface IssueListViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  layout: "horizontal" | "vertical";
  collapseModes: Readonly<Record<TaskStatus, ListCollapseMode>>;
  collapsedStatuses: ReadonlySet<TaskStatus>;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  hasActiveFilters: boolean;
  dropTarget: TaskStatus | null;
  draggedTaskId: string | null;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskCardPresentation["conversations"][number]) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onCollapseModeChange: (status: TaskStatus, mode: ListCollapseMode) => void;
  onToggleStatus: (status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
}

function createdDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function calendarDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function IssueListView({
  scrollRef,
  layout,
  collapseModes,
  collapsedStatuses,
  tasks,
  presentations,
  currentUser,
  hasActiveFilters,
  dropTarget,
  draggedTaskId,
  movingTaskId,
  settlingTaskId,
  onOpenTask,
  onOpenConversation,
  onUpdate,
  onCollapseModeChange,
  onToggleStatus,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
}: IssueListViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [priorityMenuTaskId, setPriorityMenuTaskId] = useState<string | null>(null);
  const [collapseMenuStatus, setCollapseMenuStatus] = useState<TaskStatus | null>(null);
  const [dropPosition, setDropPosition] = useState<{
    status: TaskStatus;
    beforeTaskId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!draggedTaskId) setDropPosition(null);
  }, [draggedTaskId]);

  useEffect(() => {
    if (!collapseMenuStatus) return;
    function closeCollapseMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-list-collapse-menu]")) setCollapseMenuStatus(null);
    }
    function closeCollapseMenuWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setCollapseMenuStatus(null);
    }
    document.addEventListener("pointerdown", closeCollapseMenu);
    window.addEventListener("keydown", closeCollapseMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeCollapseMenu);
      window.removeEventListener("keydown", closeCollapseMenuWithEscape);
    };
  }, [collapseMenuStatus]);

  function stopRow(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation();
  }

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".issue-list-row[data-task-id]"))
      .filter((row) => row.dataset.taskId !== draggedTaskId);
    return rows.find((row) => clientY < row.getBoundingClientRect().top + row.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function handleDrop(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/x-panel-task")
      || event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    setDropPosition(null);
  }

  return (
    <div className={`issue-list-view layout-${layout}`} ref={scrollRef}>
      <div className="issue-list-groups">
        {TASK_STATUSES.map((status) => {
          const statusTasks = tasks.filter((task) => task.status === status);
          const isCollapsed = collapsedStatuses.has(status);
          const isDropTarget = dropTarget === status;
          const statusLabel = taskStatusLabel(language, status);
          const dropBeforeTaskId = dropPosition?.status === status
            ? dropPosition.beforeTaskId
            : undefined;
          return (
            <section
              className={`issue-list-group status-${status}${isDropTarget ? " is-drop-target" : ""}`}
              key={status}
              onDragEnter={() => onDragEnter(status)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onDragEnter(status);
                setDropPosition({
                  status,
                  beforeTaskId: findDropBefore(event.currentTarget, event.clientY),
                });
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropPosition((current) => current?.status === status ? null : current);
                }
              }}
              onDrop={(event) => handleDrop(event, status)}
            >
              <header className="issue-list-group-header">
                <button
                  className="issue-list-group-toggle"
                  type="button"
                  onClick={() => onToggleStatus(status)}
                  aria-expanded={!isCollapsed}
                >
                  <LinearIcon name={isCollapsed ? "chevronRight" : "chevronDown"} />
                  <span className="issue-list-status-icon"><StatusIcon status={status} color="currentColor" size={14} /></span>
                  <strong>{statusLabel}</strong>
                  <span>{statusTasks.length}</span>
                </button>
                <div
                  className={`issue-list-collapse-menu-wrap${collapseMenuStatus === status ? " is-open" : ""}`}
                  data-list-collapse-menu
                >
                  <button
                    className="issue-list-collapse-menu-trigger"
                    type="button"
                  aria-label={text(`${statusLabel}折叠方式`, `${statusLabel} collapse behavior`)}
                    aria-haspopup="menu"
                    aria-expanded={collapseMenuStatus === status}
                  title={text(`${statusLabel}折叠方式`, `${statusLabel} collapse behavior`)}
                    onClick={() => setCollapseMenuStatus((current) => current === status ? null : status)}
                  >
                    <LinearIcon name="displayOptions" />
                  </button>
                  {collapseMenuStatus === status && (
                    <div
                      className="issue-list-collapse-menu"
                      role="menu"
                      aria-label={text(`${statusLabel}折叠方式`, `${statusLabel} collapse behavior`)}
                    >
                      {([
                        ["always-expanded", "总是展开"],
                        ["remember", "记住上次状态"],
                        ["always-collapsed", "始终折叠"],
                      ] as const).map(([mode, label]) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={collapseModes[status] === mode}
                          className={collapseModes[status] === mode ? "active" : ""}
                          onClick={() => {
                            onCollapseModeChange(status, mode);
                            setCollapseMenuStatus(null);
                          }}
                          key={mode}
                        >
                          <span>{label}</span>
                          {collapseModes[status] === mode && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </header>
              {!isCollapsed && (
                <div className={`issue-list-rows${isDropTarget && dropBeforeTaskId === null ? " is-drop-at-end" : ""}`}>
                  {statusTasks.length ? statusTasks.map((task) => {
                    const assigneeTarget = assigneeTargetForActor(task.assignee, currentUser) ?? "current-user";
                    const displayIdentifier = task.externalKey ?? task.identifier;
                    const isMoving = movingTaskId === task.id;
                    return (
                      <div
                        className={`issue-list-row${presentations[task.id]?.unread ? " is-unread" : ""}${draggedTaskId === task.id ? " is-dragging" : ""}${isMoving ? " is-moving" : ""}${settlingTaskId === task.id ? " is-settling" : ""}${isDropTarget && dropBeforeTaskId === task.id ? " is-drop-before" : ""}`}
                        role="button"
                        tabIndex={0}
                        key={task.id}
                        data-task-id={task.id}
                        draggable={!isMoving}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", task.id);
                          event.dataTransfer.setData("application/x-panel-task", task.id);
                          onDragStart(task, event.currentTarget.offsetHeight);
                        }}
                        onDragEnd={() => {
                          setDropPosition(null);
                          onDragEnd();
                        }}
                        onClick={() => onOpenTask(task)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") onOpenTask(task);
                        }}
                      >
                        <span className="issue-list-drag-handle" aria-hidden="true">
                          <LinearIcon name="dragHandle" />
                        </span>
                        <span className="issue-list-title-cell">
                          <small>{displayIdentifier}</small>
                          <strong>{task.title}</strong>
                          {presentations[task.id]?.unread && <span className="task-unread-dot" aria-label="有未读更新" />}
                        </span>
                        <span className="issue-list-metadata" aria-label="议题属性">
                          <span className="issue-list-priority-control" onClick={stopRow} onKeyDown={stopRow}>
                            <TaskPropertyPicker
                              value={task.priority}
                              options={TASK_PRIORITIES.map((priority) => ({
                                value: priority,
                                label: taskPriorityLabel(language, priority),
                                icon: <PriorityIcon priority={priority} size={14} />,
                                className: `priority-${priority}`,
                              }))}
                              open={priorityMenuTaskId === task.id}
                              className="issue-list-property-picker"
                              triggerClassName={`issue-list-priority priority-${task.priority}`}
                              ariaLabel={`${displayIdentifier} 优先级`}
                              onOpenChange={(open) => setPriorityMenuTaskId(open ? task.id : null)}
                              onChange={(priority) => void onUpdate(task, { priority }).catch(() => {})}
                            />
                          </span>
                          <span className="issue-list-labels">
                            {task.labels.slice(0, 2).map((label) => {
                              const presentation = labelPresentation(label, language);
                              return (
                                <i className={presentation.tone ? `tone-${presentation.tone}` : ""} key={label}>
                                  {presentation.tone && <span aria-hidden="true" />}
                                  <b>{presentation.name}</b>
                                </i>
                              );
                            })}
                            {task.labels.length > 2 && <b>+{task.labels.length - 2}</b>}
                          </span>
                          {task.dueDate && (
                            <label className="issue-list-date" onClick={stopRow}>
                              <DueDateIcon color="currentColor" size={12} />
                              <span>{calendarDate(task.dueDate, locale)}</span>
                              <input
                                type="date"
                                aria-label={`${displayIdentifier} 截止日期`}
                                value={task.dueDate}
                                onChange={(event) => void onUpdate(task, {
                                  dueDate: event.target.value || null,
                                  ...(event.target.value ? {} : { recurrence: null }),
                                }).catch(() => {})}
                              />
                            </label>
                          )}
                          <TaskConversationMenu
                            conversations={presentations[task.id]?.conversations ?? []}
                            onOpenConversation={onOpenConversation}
                          />
                          <label className="issue-list-assignee" title={task.assignee.name} onClick={stopRow}>
                            <ActorAvatar actor={task.assignee} />
                            <select
                              aria-label={`${displayIdentifier} 负责人`}
                              value={assigneeTarget}
                              disabled={task.source === "jira"}
                              onChange={(event) => void onUpdate(task, { assigneeTarget: event.target.value as "current-user" | "codex-agent" }).catch(() => {})}
                            >
                              <option value="current-user">{currentUser.name}</option>
                              <option value="codex-agent">Codex Agent</option>
                            </select>
                          </label>
                        </span>
                        <time dateTime={task.createdAt} title={`创建于 ${new Date(task.createdAt).toLocaleString("zh-CN")}`}>
                          {createdDate(task.createdAt, locale)}
                        </time>
                      </div>
                    );
                  }) : (
                    <div className="issue-list-empty">
                      {hasActiveFilters
                        ? text("当前筛选下没有匹配议题", "No issues match the current filters")
                        : text(`没有${statusLabel}议题`, `No ${statusLabel.toLowerCase()} issues`)}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
