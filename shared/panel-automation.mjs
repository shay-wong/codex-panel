import path from "node:path";
import { isSupportedModelEffort } from "./panel-automation-options.mjs";

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy"]);
const JIRA_AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "restore", "run-now"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const PROJECT_HOST_REQUEST_FIELDS = new Set([
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
const JIRA_HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "template",
  "operation",
  "providerKey",
  "providerAlias",
  "configPath",
  "jql",
  "skillPath",
  "automationId",
  "enabled",
]);
const JIRA_AUTOMATION_RRULE = [
  "DTSTART;TZID=Asia/Shanghai:19700101T090000",
  "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
].join("\n");

export function parsePanelAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.action !== "automation") return null;
  if (!validIdentifier(value.id, 80) || !validIdentifier(value.requestId, 100)) return null;
  if (value.template === "jira-sync") return parseJiraAutomationHostRequest(value);
  if (Object.keys(value).some((field) => !PROJECT_HOST_REQUEST_FIELDS.has(field))) return null;
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

function parseJiraAutomationHostRequest(value) {
  if (Object.keys(value).some((field) => !JIRA_HOST_REQUEST_FIELDS.has(field))) return null;
  if (!JIRA_AUTOMATION_OPERATIONS.has(value.operation)) return null;
  if (!validJiraProviderKey(value.providerKey)) return null;
  if (!validText(value.providerAlias, 120)) return null;
  if (!validAbsolutePath(value.configPath) || !validAbsolutePath(value.skillPath)) return null;
  if (!validMultilineText(value.jql, 10_000)) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (typeof value.enabled !== "boolean") return null;
  return {
    id: value.id,
    action: "automation",
    requestId: value.requestId,
    template: "jira-sync",
    operation: value.operation,
    providerKey: value.providerKey,
    providerAlias: value.providerAlias,
    configPath: value.configPath,
    jql: value.jql,
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    enabled: value.enabled,
  };
}

export function buildJiraAutomationName(request) {
  return `Panel Jira 同步 · ${request.providerKey}`;
}

export function buildJiraAutomationPrompt(request) {
  const panelctl = buildPanelctlCommand(request);
  const jiraList = [
    "jira issue list",
    "--config", shellQuote(request.configPath),
    "--jql", shellQuote(request.jql),
    "--order-by updated",
    "--raw",
    "--paginate 0:100",
  ].join(" ");
  return [
    "这是 Codex Panel 生成的 Jira 同步计划任务。模板版本：1。",
    `Provider 固定为 ${request.providerKey}（${request.providerAlias}），Jira CLI 配置固定为 ${request.configPath}。`,
    "只允许读取 Jira、Panel 当前状态和 Jira issue 中明确链接的必要需求证据。不得创建、修改、移动、归档或删除 Panel issue；不得回写 Jira；不得修改 provider 配置。",
    `先运行 ${jiraList}。随后用 --paginate 100:100、200:100 等继续读取，直到某页少于 100 条，确保获得完整结果。`,
    `只用完整命令 ${panelctl} project list --json 和 ${panelctl} issue list --archived all --json 读取 Panel。不得执行其他 panelctl 写命令。`,
    "仅在 Jira issue 提供明确需求链接、并且当前已认证的只读工具可用时读取相关需求；无法读取时记录为 ambiguity，不要猜测项目。",
    "输出一个 JSON 同步计划，必须包含 schemaVersion: 1，以及 provider、run、snapshots、evidence、proposals、ambiguities、failures。provider 必须回显 key、alias、configPath 和 jql；run 必须包含唯一 id、startedAt、finishedAt 和 status；snapshots 必须包含 Jira issues、Panel projects 和 Panel issues。",
    "proposals 只描述建议的创建、归类、合并和关联，不执行建议。只有证据唯一指向一个项目时才能建议该项目；多仓库任务可以建议多个项目内 issue；证据不足时建议放入“全局”。标题相似本身不足以建议合并。",
    "如果 proposals、ambiguities 和 failures 都为空，输出计划后归档当前 Codex 任务，保持没有变化的运行安静；否则保留任务并用简短摘要说明需要关注的变化、歧义或失败。",
  ].join("\n");
}

export function buildJiraAutomationSpec(request) {
  return {
    kind: "cron",
    name: buildJiraAutomationName(request),
    prompt: buildJiraAutomationPrompt(request),
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    rrule: JIRA_AUTOMATION_RRULE,
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

export async function reconcileJiraAutomation(request, rpc) {
  const listed = await rpc("list-automations", {});
  if (!Array.isArray(listed?.items)) {
    throw new Error("Codex 返回的自动化列表格式无效");
  }
  const items = listed.items;
  const name = buildJiraAutomationName(request);
  const existing = (
    request.automationId
      ? items.find((item) => item?.id === request.automationId)
      : null
  ) ?? items.find((item) => item?.name === name);
  const spec = buildJiraAutomationSpec(request);
  const expectedStatus = request.enabled ? "ACTIVE" : "PAUSED";

  if (!existing) {
    const mayCreate = request.enabled && (
      request.operation === "restore"
      || (request.operation === "ensure-active" && !request.automationId)
    );
    if (!mayCreate) {
      return { state: "missing" };
    }
    const created = await rpc("automation-create", spec);
    return { ...created, state: "normal" };
  }

  const item = sanitizeJiraAutomation(existing);
  if (!item) return { state: "missing" };
  const definitionMatches = jiraAutomationMatchesDefinition(existing, spec);
  const state = definitionMatches && existing.status === expectedStatus
    ? "normal"
    : "drifted";

  if (request.operation === "list") return { item, state };

  if (request.operation === "run-now") {
    if (!request.enabled) return { item, state, run: "disabled" };
    if (state !== "normal") return { item, state, run: "drifted" };
    const inbox = await rpc("inbox-items", { limit: 200 });
    if (!Array.isArray(inbox?.items)) {
      throw new Error("Codex 返回的运行列表格式无效");
    }
    const running = inbox.items.some((run) => (
      (run?.automationId ?? run?.automation_id) === existing.id
      && run?.status === "IN_PROGRESS"
    ));
    if (running) return { item, state, run: "already-running" };
    await rpc("automation-run-now", { id: existing.id });
    return { item, state, run: "started" };
  }

  if (request.operation === "restore") {
    const restored = await rpc("automation-update", {
      ...spec,
      id: existing.id,
      status: expectedStatus,
    });
    return { ...restored, state: "normal" };
  }

  if (request.operation === "pause") {
    if (existing.status === "PAUSED") return { item, state };
    const currentSpec = jiraAutomationUpdateSpec(existing);
    if (!currentSpec) return { item, state: "drifted" };
    const paused = await rpc("automation-update", {
      ...currentSpec,
      id: existing.id,
      status: "PAUSED",
    });
    return { ...paused, state: definitionMatches && !request.enabled ? "normal" : "drifted" };
  }

  if (request.operation !== "ensure-active") {
    throw new Error(`Unsupported Jira automation operation: ${request.operation}`);
  }
  if (state === "drifted") return { item, state };
  if (existing.status === "ACTIVE") return { item, state };
  const activated = await rpc("automation-update", {
    ...spec,
    id: existing.id,
    status: "ACTIVE",
  });
  return { ...activated, state: "normal" };
}

function sanitizeJiraAutomation(item) {
  if (
    !validText(item?.id, 256)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
  ) return null;
  return {
    id: item.id,
    status: item.status,
    ...(item.nextRunAt === null || Number.isFinite(item.nextRunAt)
      ? { nextRunAt: item.nextRunAt }
      : {}),
  };
}

function jiraAutomationMatchesDefinition(item, spec) {
  return item?.target?.type === "projectless"
    && item?.notificationPolicy === undefined
    && Object.entries(spec).every(([field, value]) => item[field] === value);
}

function jiraAutomationUpdateSpec(item) {
  if (
    item?.kind !== "cron"
    || !validText(item.name, 200)
    || !validMultilineText(item.prompt, 100_000)
    || (item.executionEnvironment !== "local" && item.executionEnvironment !== "worktree")
    || !validText(item.rrule, 2_048)
    || !validText(item.model, 100)
    || !validText(item.reasoningEffort, 20)
  ) return null;
  const spec = {
    kind: "cron",
    name: item.name,
    prompt: item.prompt,
    executionEnvironment: item.executionEnvironment,
    localEnvironmentConfigPath: item.localEnvironmentConfigPath ?? null,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
    ...(item.notificationPolicy === undefined
      ? {}
      : { notificationPolicy: item.notificationPolicy }),
  };
  if (item.target?.type === "project") return { ...spec, projectId: item.target.projectId };
  if (item.target?.type === "projectless") return spec;
  return Array.isArray(item.cwds) ? { ...spec, cwds: item.cwds } : null;
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

function validJiraProviderKey(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value);
}

function validMultilineText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
