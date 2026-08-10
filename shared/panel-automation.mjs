import path from "node:path";
import { isSupportedModelEffort } from "./panel-automation-options.mjs";

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "operation",
  "panelProjectId",
  "codexProjectId",
  "projectName",
  "workspacePath",
  "skillPath",
  "automationId",
  "enabledByUser",
  "quotaAware",
  "intervalMinutes",
  "model",
  "reasoningEffort",
]);

export function parsePanelAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !HOST_REQUEST_FIELDS.has(field))) return null;
  if (value.action !== "automation") return null;
  if (!validIdentifier(value.id, 80) || !validIdentifier(value.requestId, 100)) return null;
  if (!AUTOMATION_OPERATIONS.has(value.operation)) return null;
  if (!validProjectId(value.panelProjectId)) return null;
  if (!validText(value.codexProjectId, 256) || !validText(value.projectName, 200)) return null;
  if (!validAbsolutePath(value.workspacePath) || !validAbsolutePath(value.skillPath)) return null;
  if (!INTERVAL_MINUTES.has(value.intervalMinutes)) return null;
  if (!isSupportedModelEffort(value.model, value.reasoningEffort)) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (typeof value.enabledByUser !== "boolean" || typeof value.quotaAware !== "boolean") return null;

  return {
    id: value.id,
    action: "automation",
    requestId: value.requestId,
    operation: value.operation,
    panelProjectId: value.panelProjectId,
    codexProjectId: value.codexProjectId,
    projectName: value.projectName,
    workspacePath: value.workspacePath,
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    enabledByUser: value.enabledByUser,
    quotaAware: value.quotaAware,
    intervalMinutes: value.intervalMinutes,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function buildPanelAutomationName(request) {
  return `Panel 自动认领 · ${request.panelProjectId}`;
}

function legacyAutomationName(request) {
  return `Taskboard 自动认领 · ${request.panelProjectId}`;
}

export function buildPanelAutomationPrompt(request) {
  const automationName = buildPanelAutomationName(request);
  const panelctlCommand = buildPanelctlCommand(request);
  return [
    `[$manage-panel](${request.skillPath}) e-panel 每 ${request.intervalMinutes} 分钟检查任务面板中的「${request.projectName}」项目（项目 ID：${request.panelProjectId}，项目目录：${request.workspacePath}）。`,
    `本轮所有 panelctl 操作都使用完整命令前缀 ${panelctlCommand}，不要使用 PATH 中的 panelctl。`,
    `开始时先运行 ${panelctlCommand} issue list --project ${request.panelProjectId} --status todo --json。若没有 todo，使用 Codex automation_update 将名为「${automationName}」的当前自动化设为 PAUSED，保留其他字段，然后结束；不要创建或打开新的任务会话。`,
    "每次仅处理一个 todo：选定后用 issue get 读取最新议题内容，并用 comment list 读取全部评论，确认是否包含已完成后被打回的返工要求。",
    "认领时使用最新 version 将议题移动到 in_progress；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。",
    "若 issue get 返回 threadId，认领时将 --thread-id 设为该值以保留绑定，再使用 Codex send_message_to_thread 向原会话发送继续处理此议题的指令；当前自动化会话不要重复处理。若没有 threadId，则在当前自动化会话处理。",
    "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
    "执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
    `本次处理或交接后，再次运行 ${panelctlCommand} issue list --project ${request.panelProjectId} --status todo --json。若没有 todo，使用 Codex automation_update 将名为「${automationName}」的当前自动化设为 PAUSED，保留其他字段，避免后续创建空会话。`,
  ].join("\n");
}

function buildPanelctlCommand(request) {
  const cliPath = path.resolve(path.dirname(request.skillPath), "../..", "cli/panelctl.mjs");
  const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)}`;
  const runtimeFilePath = process.env.CODEX_PANEL_RUNTIME_FILE;
  return runtimeFilePath
    ? `CODEX_PANEL_RUNTIME_FILE=${shellQuote(runtimeFilePath)} ${command}`
    : command;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPanelAutomationSpec(request) {
  return {
    kind: "cron",
    name: buildPanelAutomationName(request),
    prompt: buildPanelAutomationPrompt(request),
    projectId: request.codexProjectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${request.intervalMinutes}`,
  };
}

export function panelAutomationPolicyOperation(request, {
  explicit,
  previousQuotaState,
  quotaState,
  currentStatus,
}) {
  if (!request.enabledByUser) return "pause";
  if (
    !explicit
    && currentStatus === "PAUSED"
    && (!request.quotaAware || previousQuotaState === "available")
  ) return "list";
  if (request.quotaAware && quotaState !== "available") return "pause";
  if (
    explicit
    || currentStatus === undefined
    || (request.quotaAware && previousQuotaState !== "available")
  ) return "ensure-active";
  return "ensure-active";
}

export async function reconcilePanelAutomation(request, rpc) {
  const listed = await rpc("list-automations", {});
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const name = buildPanelAutomationName(request);
  const legacyName = legacyAutomationName(request);
  const matchingItems = items.filter((item) => item?.name === name || item?.name === legacyName);

  if (request.operation === "list") {
    return { items: matchingItems.map(sanitizeAutomation).filter(Boolean) };
  }

  const existing = (
    request.automationId
      ? matchingItems.find((item) => item?.id === request.automationId)
      : null
  ) ?? matchingItems[0];
  const spec = buildPanelAutomationSpec(request);

  if (request.operation === "pause") {
    if (!existing) return { error: "not-found" };
    if (automationMatchesSpec(existing, spec, "PAUSED")) return { item: existing };
    return rpc("automation-update", { ...spec, id: existing.id, status: "PAUSED" });
  }

  if (request.operation !== "ensure-active") {
    throw new Error(`Unsupported automation operation: ${request.operation}`);
  }
  if (existing) {
    if (automationMatchesSpec(existing, spec, "ACTIVE")) return { item: existing };
    return rpc("automation-update", {
      ...spec,
      id: existing.id,
      status: "ACTIVE",
    });
  }
  return rpc("automation-create", spec);
}

function sanitizeAutomation(item) {
  if (
    !validText(item?.id, 256)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
    || !isSupportedModelEffort(item.model, item.reasoningEffort)
    || !validRrule(item.rrule)
  ) return null;
  return {
    id: item.id,
    status: item.status,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
    ...(
      item.nextRunAt === null || Number.isFinite(item.nextRunAt)
        ? { nextRunAt: item.nextRunAt }
        : {}
    ),
  };
}

function validRrule(value) {
  return typeof value === "string"
    && /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.test(value);
}

function automationMatchesSpec(item, spec, status) {
  return item?.status === status
    && Object.entries(spec).every(([field, value]) => (
      field === "projectId"
        ? (item.projectId ?? item.target?.projectId) === value
        : item[field] === value
    ));
}

function validIdentifier(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[a-z0-9-]+$/i.test(value);
}

function validProjectId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAbsolutePath(value) {
  return validText(value, 2_048) && path.isAbsolute(value);
}
