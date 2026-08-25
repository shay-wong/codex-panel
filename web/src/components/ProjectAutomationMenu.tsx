import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/panel-automation-options.mjs";
import type {
  ProjectAutomationOptions,
  ProjectAutomationPolicy,
} from "../types";
import { LinearIcon } from "./LinearIcon";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

type AutomationOptions = ProjectAutomationOptions & {
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
};

interface ProjectAutomationMenuProps {
  automation: ProjectAutomationPolicy | null;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  paused: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
  defaultParallelism: 3,
  parallelismOverride: null,
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
};

function toAutomationOptions(policy: ProjectAutomationPolicy | null): AutomationOptions {
  const options = policy ?? DEFAULT_OPTIONS;
  return {
    enabledByUser: options.enabledByUser,
    paused: options.paused,
    intervalMinutes: options.intervalMinutes,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    defaultParallelism: options.defaultParallelism,
    parallelismOverride: options.parallelismOverride,
  };
}

export function ProjectAutomationMenu({
  automation,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const status = automation?.status ?? "PAUSED";
  const stateLabel = !automation?.enabledByUser
    ? "已关闭"
    : automation.paused
      ? "项目暂停"
      : "运行中";
  const disabled = pending || Boolean(unavailableReason);
  const parallelismOptions = Array.from({ length: 8 }, (_, index) => String(index + 1));
  const currentParallelismValue = draft.parallelismOverride === null
    ? "default"
    : String(draft.parallelismOverride);
  const currentParallelismLabel = draft.parallelismOverride === null
    ? `跟随默认（${draft.defaultParallelism}）`
    : String(draft.parallelismOverride);
  const modelLabel = getAutomationModel(draft.model).label;

  useEffect(() => {
    if (!open) return;
    setDraft(toAutomationOptions(automation));
  }, [open]);

  useEffect(() => {
    if (!open) setOpenPicker(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft(toAutomationOptions(automation));
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label="自动认领待办设置"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <div className="project-automation-heading-copy">
          <strong>自动化</strong>
          <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
            <i aria-hidden="true" />
            {stateLabel}
          </span>
        </div>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-label="自动认领开关"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <section className="project-automation-section">
        <span className="project-automation-section-heading">执行</span>
        <div className="project-automation-queue" aria-label="自动执行队列状态">
          <div className="project-automation-capacity">
            <span>运行</span>
            <strong>
              {automation?.queue.running ?? 0}
              <small> / {automation?.parallelism ?? draft.defaultParallelism}</small>
            </strong>
          </div>
          <div className="project-automation-queue-breakdown">
            <span><strong>{automation?.queue.queued ?? 0}</strong> 排队</span>
            <span><strong>{automation?.queue.blocked ?? 0}</strong> 阻塞</span>
            <span><strong>{automation?.queue.failed ?? 0}</strong> 失败</span>
          </div>
        </div>
        <label className="project-automation-field">
          <span>当前项目并行数</span>
          <TaskPropertyPicker
            value={currentParallelismValue}
            options={[
              { value: "default", label: `跟随默认（${draft.defaultParallelism}）`, icon: null },
              ...parallelismOptions.map((value) => ({ value, label: value, icon: null })),
            ]}
            open={openPicker === "current-parallelism"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            triggerContent={<><span>{currentParallelismLabel}</span><LinearIcon name="chevronDown" /></>}
            ariaLabel="当前项目并行数"
            onOpenChange={(nextOpen) => setOpenPicker(nextOpen ? "current-parallelism" : null)}
            onChange={(value) => submitChange({
              ...draft,
              parallelismOverride: value === "default"
                ? null
                : Number(value),
            })}
          />
        </label>
        <label className="project-automation-field">
          <span>默认项目并行数</span>
          <TaskPropertyPicker
            value={String(draft.defaultParallelism)}
            options={parallelismOptions.map((value) => ({ value, label: value, icon: null }))}
            open={openPicker === "default-parallelism"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            triggerContent={<><span>{draft.defaultParallelism}</span><LinearIcon name="chevronDown" /></>}
            ariaLabel="默认项目并行数"
            onOpenChange={(nextOpen) => setOpenPicker(nextOpen ? "default-parallelism" : null)}
            onChange={(value) => submitChange({
              ...draft,
              defaultParallelism: Number(value),
            })}
          />
        </label>
        <label className="project-automation-field">
          <span>扫描间隔</span>
          <TaskPropertyPicker
            value={String(draft.intervalMinutes)}
            options={[5, 10, 15, 30, 60].map((minutes) => ({
              value: String(minutes),
              label: `${minutes} 分钟`,
              icon: null,
            }))}
            open={openPicker === "interval"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            triggerContent={<><span>{draft.intervalMinutes} 分钟</span><LinearIcon name="chevronDown" /></>}
            ariaLabel="扫描间隔"
            onOpenChange={(nextOpen) => setOpenPicker(nextOpen ? "interval" : null)}
            onChange={(value) => submitChange({
              ...draft,
              intervalMinutes: Number(value) as IntervalMinutes,
            })}
          />
        </label>
        <div className="project-automation-switch">
          <span>暂停当前项目</span>
          <button
            type="button"
            className={`board-setting-switch${draft.paused ? " is-on" : ""}`}
            role="switch"
            aria-checked={draft.paused}
            disabled={disabled}
            onClick={() => submitChange({
              ...draft,
              paused: !draft.paused,
            })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </section>
      <section className="project-automation-section">
        <span className="project-automation-section-heading">模型</span>
        <label className="project-automation-field">
          <span>模型</span>
          <TaskPropertyPicker
            value={draft.model}
            options={AUTOMATION_MODELS.map((model) => ({
              value: model.slug,
              label: model.label,
              icon: null,
            }))}
            open={openPicker === "model"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            triggerContent={<><span>{modelLabel}</span><LinearIcon name="chevronDown" /></>}
            ariaLabel="模型"
            onOpenChange={(nextOpen) => setOpenPicker(nextOpen ? "model" : null)}
            onChange={(value) => submitChange(withAutomationModel(draft, value as AutomationModel))}
          />
        </label>
        <label className="project-automation-field">
          <span>推理强度</span>
          <TaskPropertyPicker
            value={draft.reasoningEffort}
            options={getAutomationModel(draft.model).efforts.map((effort) => ({
              value: effort,
              label: EFFORT_LABELS[effort],
              icon: null,
            }))}
            open={openPicker === "reasoning"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            triggerContent={<><span>{EFFORT_LABELS[draft.reasoningEffort]}</span><LinearIcon name="chevronDown" /></>}
            ariaLabel="推理强度"
            onOpenChange={(nextOpen) => setOpenPicker(nextOpen ? "reasoning" : null)}
            onChange={(value) => submitChange({
              ...draft,
              reasoningEffort: value as AutomationReasoningEffort,
            })}
          />
        </label>
      </section>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE" ? "自动认领中" : "自动化"}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE" ? "自动认领中" : "自动化"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        {pending
          ? <span className="ai-chat-spinner" aria-hidden="true" />
          : <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />}
        <span>{status === "ACTIVE" ? "自动认领中" : "自动化"}</span>
      </button>
      {menu}
    </>
  );
}
