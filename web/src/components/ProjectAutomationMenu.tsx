import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { PanelIcon } from "./PanelIcon";

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
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
};

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
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const status = automation?.status ?? "PAUSED";
  const stateLabel = !automation?.enabledByUser
    ? "已关闭"
    : automation.paused
      ? "项目暂停"
      : "运行中";
  const disabled = pending || Boolean(unavailableReason);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
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
        <strong>自动认领待办</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>自动认领开关</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
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
      <div className="project-automation-queue" aria-label="自动执行队列状态">
        <span>排队 <strong>{automation?.queue.queued ?? 0}</strong></span>
        <span>运行 <strong>{automation?.queue.running ?? 0}</strong></span>
        <span>阻塞 <strong>{automation?.queue.blocked ?? 0}</strong></span>
        <span>失败 <strong>{automation?.queue.failed ?? 0}</strong></span>
      </div>
      <label className="project-automation-field">
        <span>扫描间隔</span>
        <select
          value={draft.intervalMinutes}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            intervalMinutes: Number(event.target.value) as IntervalMinutes,
          })}
        >
          {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
        </select>
      </label>
      <label className="project-automation-field">
        <span>模型</span>
        <select
          value={draft.model}
          disabled={disabled}
          onChange={(event) => submitChange(withAutomationModel(draft, event.target.value as AutomationModel))}
        >
          {AUTOMATION_MODELS.map((model) => (
            <option key={model.slug} value={model.slug}>{model.label}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>推理强度</span>
        <select
          value={draft.reasoningEffort}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            reasoningEffort: event.target.value as AutomationReasoningEffort,
          })}
        >
          {getAutomationModel(draft.model).efforts.map((effort) => (
            <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
          ))}
        </select>
      </label>
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
          : <PanelIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />}
        <span>{status === "ACTIVE" ? "自动认领中" : "自动化"}</span>
      </button>
      {menu}
    </>
  );
}
