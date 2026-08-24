import { createHmac, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_ID,
  JIRA_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { resolvePanelDataDirectory } from "../shared/panel-paths.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutPanelLauncherEnvironment } from "../shared/codex-environment.mjs";
import { executableCommand } from "../shared/executable-command.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import {
  isAutomationModel,
  isSupportedModelEffort,
} from "../shared/panel-automation-options.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
import { ClaimQueueService } from "./claim-queue.mjs";
import { decodeComposerReferenceKey } from "./composer-reference.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, PanelDatabase } from "./database.mjs";
import { createJiraConfigStore } from "./jira-config.mjs";
import { JiraAutoCompleteService } from "./jira-auto-complete.mjs";
import { createJiraIntegration } from "./jira-integration.mjs";
import { ProjectSummaryService } from "./project-summary.mjs";
import { sendInjectorControlRequest } from "../scripts/codex-injector-control.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const HOST_RUNTIME_TTL_MS = 3_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request, allowOpaqueOrigin = false) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  if (!isTrustedNetworkHost(host)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  if (allowOpaqueOrigin && origin === "null") return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost)) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseWorkflowVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return value;
}

function parseWorkflowWorkspace(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "tabs", "activeWorkflowId", "snapshots"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.version' must be 1");
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' must contain 1 to 100 workflows");
  }
  const tabs = value.tabs.map((tab, index) => {
    assertPlainObject(tab);
    assertAllowedKeys(tab, new Set(["id", "name"]));
    return {
      id: stringField(tab.id, `workspace.tabs[${index}].id`, { required: true, maxLength: 128 }),
      name: stringField(tab.name, `workspace.tabs[${index}].name`, { required: true, maxLength: 120 }),
    };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' ids must be unique");
  }
  const activeWorkflowId = stringField(value.activeWorkflowId, "workspace.activeWorkflowId", {
    required: true,
    maxLength: 128,
  });
  if (!tabs.some((tab) => tab.id === activeWorkflowId)) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.activeWorkflowId' must reference a workflow tab");
  }
  assertPlainObject(value.snapshots);
  const snapshots = {};
  for (const tab of tabs) {
    const snapshot = value.snapshots[tab.id];
    assertPlainObject(snapshot);
    assertAllowedKeys(snapshot, new Set(["nodes", "edges", "flow", "selectedNodeId"]));
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 10_000) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.nodes' must be an array`);
    }
    if (snapshot.flow === undefined && (!Array.isArray(snapshot.edges) || snapshot.edges.length > 20_000)) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.edges' must be an array`);
    }
    if (snapshot.flow !== undefined && snapshot.edges !== undefined) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}' cannot contain both 'flow' and 'edges'`);
    }
    const selectedNodeId = stringField(
      snapshot.selectedNodeId ?? null,
      `workspace.snapshots.${tab.id}.selectedNodeId`,
      { nullable: true, maxLength: 256 },
    );
    try {
      snapshots[tab.id] = normalizeWorkflowSnapshot({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        flow: snapshot.flow,
        selectedNodeId,
      });
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        `'workspace.snapshots.${tab.id}' is not a valid workflow: ${error.message}`,
      );
    }
  }
  return { version: 1, tabs, activeWorkflowId, snapshots };
}

function parseWorkflowWorkspaceSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "workspace"]));
  return {
    version: parseWorkflowVersion(body.version),
    workspace: parseWorkflowWorkspace(body.workspace),
  };
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.codexProjectKind must be local or remote");
  }
  if (
    (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (
    request.headers["x-panel-client"] === "panelctl"
    || request.headers["x-taskboard-client"] === "taskctl"
  ) {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-panel-user-id")
    ?? requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-panel-user-name")
    ?? requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-panel-user-avatar")
    ?? requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Panel-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Panel-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Panel-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user or codex-agent");
  }
  return value;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseWorkflowId(value) {
  const workflowId = stringField(value, "workflowId", { nullable: true, maxLength: 128 });
  if (workflowId === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowId' cannot be empty");
  }
  return workflowId;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId", "threadBinding",
    "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    workflowId: parseWorkflowId(body.workflowId ?? null),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "projectId", "title", "description", "status", "priority", "labels", "threadId", "threadBinding",
    "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const threadBinding = parseThreadBinding(body.threadBinding);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.workflowId !== undefined) changes.workflowId = parseWorkflowId(body.workflowId);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, threadBinding, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseJiraProjects(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "projectIds"]));
  if (!Array.isArray(body.projectIds)) {
    throw new ApiError(400, "INVALID_FIELD", "'projectIds' must be an array");
  }
  return {
    version: parseVersion(body.version),
    projectIds: body.projectIds.map((projectId) => validateProjectId(projectId)),
  };
}

function parseJiraSimpleStart(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version"]));
  return { version: parseVersion(body.version) };
}

function parseJiraLifecycle(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "action"]));
  if (!["pause", "keep", "rework", "replan", "migrate"].includes(body.action)) {
    throw new ApiError(400, "INVALID_FIELD", "Unsupported Jira lifecycle action");
  }
  return { version: parseVersion(body.version), action: body.action };
}

function parseJiraPlanSpec(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "spec"]));
  return {
    version: parseVersion(body.version),
    spec: stringField(body.spec, "spec", { required: true, maxLength: 200_000 }),
  };
}

function parseJiraPlanPublish(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "items"]));
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'items' must contain 1 to 100 tickets");
  }
  const items = body.items.map((item, index) => {
    assertPlainObject(item);
    assertAllowedKeys(item, new Set([
      "key", "projectId", "title", "description", "priority", "labels", "blockedBy",
    ]));
    const blockedBy = item.blockedBy === undefined ? [] : item.blockedBy;
    if (!Array.isArray(blockedBy) || blockedBy.length > 50) {
      throw new ApiError(400, "INVALID_FIELD", `'items[${index}].blockedBy' must be an array`);
    }
    return {
      key: stringField(item.key, `items[${index}].key`, { required: true, maxLength: 80 }),
      projectId: validateProjectId(item.projectId),
      title: stringField(item.title, `items[${index}].title`, { required: true, maxLength: 240 }),
      description: stringField(item.description ?? "", `items[${index}].description`, { maxLength: 100_000 }),
      priority: parsePriority(item.priority, "none"),
      labels: item.labels === undefined ? [] : parseLabels(item.labels),
      blockedBy: blockedBy.map((key, blockedIndex) => stringField(
        key,
        `items[${index}].blockedBy[${blockedIndex}]`,
        { required: true, maxLength: 80 },
      )),
    };
  });
  const keys = new Set(items.map((item) => item.key));
  if (keys.size !== items.length) {
    throw new ApiError(400, "INVALID_FIELD", "Ticket keys must be unique");
  }
  for (const item of items) {
    if (new Set(item.blockedBy).size !== item.blockedBy.length) {
      throw new ApiError(400, "INVALID_FIELD", `Ticket '${item.key}' has duplicate blockers`);
    }
    if (item.blockedBy.includes(item.key) || item.blockedBy.some((key) => !keys.has(key))) {
      throw new ApiError(400, "INVALID_FIELD", `Ticket '${item.key}' has an invalid blocker`);
    }
  }
  const blockersByKey = new Map(items.map((item) => [item.key, item.blockedBy]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) {
      throw new ApiError(400, "INVALID_FIELD", "Ticket blockers must not contain a cycle");
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const blocker of blockersByKey.get(key)) visit(blocker);
    visiting.delete(key);
    visited.add(key);
  };
  for (const item of items) visit(item.key);
  return { version: parseVersion(body.version), items };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-panel-filename"]
    ?? request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Panel-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  const kind = request.headers["x-panel-attachment-kind"]
    ?? request.headers["x-taskboard-attachment-kind"];
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Panel-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "issueId", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.issueId !== undefined) {
    input.issueId = body.issueId === null
      ? null
      : parseAiSetting(body.issueId, "issueId", 128);
  }
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  if (body.contractVersion !== undefined) return parseComposerTurn(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

function parseComposerCandidateQuery(searchParams) {
  assertAllowedQuery(
    searchParams,
    new Set(["projectId", "threadId", "trigger", "query", "surface"]),
    "GET /api/local/ai/composer/candidates",
  );
  let projectId;
  const rawProjectId = searchParams.get("projectId");
  if (rawProjectId !== null) {
    try {
      projectId = validateProjectId(rawProjectId);
    } catch {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project id is invalid");
    }
  }
  const trigger = searchParams.get("trigger");
  if (trigger !== "/" && trigger !== "@") {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer trigger must be '/' or '@'");
  }
  const query = searchParams.get("query") ?? "";
  if (query.length > 256) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer query cannot exceed 256 characters");
  }
  let threadId;
  try {
    threadId = parseThreadId(searchParams.get("threadId") ?? undefined);
  } catch {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread id is invalid");
  }
  const surface = searchParams.get("surface") ?? "ai-chat";
  if (!new Set(["ai-chat", "issue-description", "comment"]).has(surface)) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer surface is invalid");
  }
  return { projectId, threadId, trigger, query, surface };
}

function invalidComposerRebindRequest(message) {
  return new ApiError(400, "INVALID_COMPOSER_REBIND_REQUEST", message);
}

function assertComposerRebindKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidComposerRebindRequest(`'${field}.${key}' is not allowed`);
    }
  }
}

function parseComposerRebindRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidComposerRebindRequest("Composer rebind body must be an object");
  }
  assertComposerRebindKeys(
    value,
    new Set(["contractVersion", "projectId", "threadId", "document"]),
    "body",
  );
  if (value.contractVersion !== "composer.v1") {
    throw invalidComposerRebindRequest("'contractVersion' must be 'composer.v1'");
  }
  let projectId;
  try {
    projectId = validateProjectId(value.projectId);
  } catch {
    throw invalidComposerRebindRequest("'projectId' is invalid");
  }
  let threadId;
  try {
    threadId = parseThreadId(value.threadId);
  } catch {
    throw invalidComposerRebindRequest("'threadId' is invalid");
  }
  const document = value.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidComposerRebindRequest("'document' must be an object");
  }
  assertComposerRebindKeys(document, new Set(["version", "nodes"]), "document");
  if (document.version !== 1) {
    throw invalidComposerRebindRequest("'document.version' must be 1");
  }
  if (!Array.isArray(document.nodes) || document.nodes.length > 200) {
    throw invalidComposerRebindRequest("'document.nodes' must contain at most 200 entries");
  }
  let textLength = 0;
  const nodes = document.nodes.map((node, nodeIndex) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}]' must be an object`);
    }
    if (node.type === "text") {
      assertComposerRebindKeys(node, new Set(["type", "text"]), `document.nodes[${nodeIndex}]`);
      if (typeof node.text !== "string") {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].text' must be a string`);
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "unsupportedReference") {
      assertComposerRebindKeys(
        node,
        new Set(["type", "referenceUri", "label"]),
        `document.nodes[${nodeIndex}]`,
      );
      if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
      }
      if (typeof node.referenceUri !== "string" || node.referenceUri.length > 1_024) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is invalid`,
        );
      }
      const match = /^taskboard:\/\/composer-reference\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        node.referenceUri,
      );
      if (!match) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is not a composer reference marker`,
        );
      }
      try {
        decodeComposerReferenceKey(match[3]);
      } catch {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' has an invalid reference key`,
        );
      }
      const reasonCode = match[1] !== "v1"
        ? "REFERENCE_FORMAT_UNSUPPORTED"
        : !new Set(["skill", "agent"]).has(match[2])
          ? "REFERENCE_KIND_UNSUPPORTED"
          : null;
      if (!reasonCode) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}]' must use persistedReference for supported markers`,
        );
      }
      return {
        type: "unsupportedReference",
        referenceUri: node.referenceUri,
        label: node.label,
        reasonCode,
      };
    }
    if (node.type !== "persistedReference") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].type' must be text, persistedReference or unsupportedReference`,
      );
    }
    assertComposerRebindKeys(
      node,
      new Set(["type", "referenceKind", "referenceKey", "label"]),
      `document.nodes[${nodeIndex}]`,
    );
    if (node.referenceKind !== "skill" && node.referenceKind !== "agent") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKind' must be skill or agent`,
      );
    }
    if (
      typeof node.referenceKey !== "string"
      || node.referenceKey.length === 0
      || node.referenceKey.length > 512
    ) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is invalid`,
      );
    }
    if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
    }
    let stableId;
    try {
      stableId = decodeComposerReferenceKey(node.referenceKey);
    } catch {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is not canonical base64url`,
      );
    }
    if (node.referenceKind === "skill" && stableId !== stableId.normalize("NFC")) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' does not contain an NFC Skill name`,
      );
    }
    return {
      type: "persistedReference",
      referenceKind: node.referenceKind,
      referenceKey: node.referenceKey,
      label: node.label,
      stableId,
    };
  });
  if (textLength > 100_000) {
    throw invalidComposerRebindRequest("Composer text cannot exceed 100000 characters");
  }
  return {
    contractVersion: "composer.v1",
    projectId,
    threadId,
    document: { version: 1, nodes },
  };
}

async function resolveComposerRebindWorkspace(aiChat, input) {
  let thread;
  if (input.threadId !== undefined) {
    try {
      thread = aiChat.getThread(input.threadId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread does not exist");
      }
      throw error;
    }
    if (thread.origin.projectId !== input.projectId) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread does not belong to the selected project",
      );
    }
    try {
      if (!(await stat(thread.origin.workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_UNAVAILABLE",
        "The conversation workspace is not available on this device",
      );
    }
    return thread.origin.workspacePath;
  }
  let resolved;
  try {
    resolved = await aiChat.resolveContext(input.projectId, thread?.origin.issueId);
  } catch (error) {
    if (
      error instanceof ApiError
      && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)
    ) {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
    }
    throw error;
  }
  return resolved.workspacePath;
}

function parseComposerDocument(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "nodes"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_COMPOSER_DOCUMENT", "'document.version' must be 1");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > 200) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'document.nodes' must be an array with at most 200 entries",
    );
  }
  let textLength = 0;
  const nodes = value.nodes.map((node, index) => {
    assertPlainObject(node);
    if (typeof node.type !== "string" || !node.type) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        `'document.nodes[${index}].type' is required`,
      );
    }
    if (node.type === "text") {
      assertAllowedKeys(node, new Set(["type", "text"]));
      if (typeof node.text !== "string") {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_DOCUMENT",
          `'document.nodes[${index}].text' must be a string`,
        );
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "skill" || node.type === "agent") {
      assertAllowedKeys(node, new Set(["type", "candidateRef", "label"]));
      return {
        type: node.type,
        candidateRef: stringField(
          node.candidateRef,
          `document.nodes[${index}].candidateRef`,
          { required: true, maxLength: 512 },
        ),
        label: stringField(node.label, `document.nodes[${index}].label`, {
          required: true,
          maxLength: 256,
        }),
      };
    }
    return { type: node.type };
  });
  if (textLength > 100_000) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "Composer text cannot exceed 100000 characters",
    );
  }
  return { version: 1, nodes };
}

function parseComposerTurn(body) {
  assertAllowedKeys(body, new Set([
    "contractVersion",
    "revision",
    "document",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (body.contractVersion !== "composer.v1") {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'contractVersion' must be 'composer.v1'",
    );
  }
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  return {
    contractVersion: "composer.v1",
    revision: stringField(body.revision, "revision", { required: true, maxLength: 512 }),
    document: parseComposerDocument(body.document),
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments: parseAiAttachments(body.attachments),
  };
}

function parseProjectAutomationPolicy(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "enabledByUser",
    "paused",
    "intervalMinutes",
    "model",
    "reasoningEffort",
    "defaultParallelism",
    "parallelismOverride",
  ]));
  if (typeof body.enabledByUser !== "boolean" || typeof body.paused !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "Automation switches must be boolean");
  }
  if (![5, 10, 15, 30, 60].includes(body.intervalMinutes)) {
    throw new ApiError(400, "INVALID_FIELD", "'intervalMinutes' must be 5, 10, 15, 30, or 60");
  }
  if (!isAutomationModel(body.model) || !isSupportedModelEffort(body.model, body.reasoningEffort)) {
    throw new ApiError(400, "INVALID_FIELD", "Automation model and reasoning effort are incompatible");
  }
  if (!Number.isInteger(body.defaultParallelism) || body.defaultParallelism < 1 || body.defaultParallelism > 8) {
    throw new ApiError(400, "INVALID_FIELD", "'defaultParallelism' must be an integer from 1 through 8");
  }
  if (
    body.parallelismOverride !== null
    && (!Number.isInteger(body.parallelismOverride)
      || body.parallelismOverride < 1
      || body.parallelismOverride > 8)
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'parallelismOverride' must be null or an integer from 1 through 8");
  }
  return {
    enabledByUser: body.enabledByUser,
    paused: body.paused,
    intervalMinutes: body.intervalMinutes,
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    defaultParallelism: body.defaultParallelism,
    parallelismOverride: body.parallelismOverride,
  };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (worktreePath) contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath, processEnv = process.env) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  const environment = withoutPanelLauncherEnvironment(processEnv);
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      env: environment,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...parseWorktrees(worktreesResult.stdout),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath, processEnv) {
  const entries = await new Promise((resolve, reject) => {
    const command = executableCommand(codexExecutable, ["app-server", "--stdio"]);
    const child = spawn(command.executable, command.args, {
      cwd: workspacePath,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-panel", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable, processEnv) {
  const command = executableCommand(codexExecutable, ["mcp", "list", "--json"]);
  const result = await execFileAsync(command.executable, command.args, {
    env: processEnv,
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath, processEnv) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath, processEnv),
    discoverMcpServers(resolved.codexExecutable, processEnv),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const dataDirectory = options.dataDirectory
    ? path.resolve(options.dataDirectory)
    : resolvePanelDataDirectory();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const skillPath = options.skillPath
    ?? path.join(PROJECT_ROOT, "skills", "manage-panel", "SKILL.md");
  const installedSkillPath = path.join(
    os.homedir(),
    ".agents",
    "skills",
    "manage-panel",
    "SKILL.md",
  );
  const instanceToken = String(options.instanceToken
    ?? process.env.CODEX_PANEL_INSTANCE_TOKEN
    ?? process.env.CODEX_TASKBOARD_INSTANCE_TOKEN
    ?? "").trim();
  if (instanceToken && !/^[a-z0-9-]{16,128}$/i.test(instanceToken)) {
    throw new Error("CODEX_PANEL_INSTANCE_TOKEN must be an identifier");
  }
  const instanceSecret = String(options.instanceSecret
    ?? process.env.CODEX_PANEL_INSTANCE_SECRET
    ?? process.env.CODEX_TASKBOARD_INSTANCE_SECRET
    ?? "").trim();
  if (instanceToken && !/^[a-f0-9-]{32,128}$/i.test(instanceSecret)) {
    throw new Error("CODEX_PANEL_INSTANCE_SECRET must be set in launcher mode");
  }
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "panel.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    jiraConfigPath: options.jiraConfigPath ?? path.join(dataDirectory, "jira-connection.json"),
    clientStoragePath: options.clientStoragePath ?? path.join(dataDirectory, "client-storage.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath,
    nativeSkillPath: options.nativeSkillPath
      ?? options.skillPath
      ?? (existsSync(installedSkillPath) ? installedSkillPath : skillPath),
    codexExecutable: resolveCodexExecutable({ explicit: options.codexExecutable }),
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    instanceToken,
    instanceSecret,
    version: String(
      options.version
        ?? process.env.CODEX_PANEL_VERSION
        ?? process.env.CODEX_TASKBOARD_VERSION
        ?? "development",
    ).trim(),
  };
}

export function resolvePort(value = (
  process.env.CODEX_PANEL_PORT
  ?? process.env.CODEX_TASKBOARD_PORT
  ?? "47823"
)) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_PANEL_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = (
  process.env.CODEX_PANEL_HOST
  ?? process.env.CODEX_TASKBOARD_HOST
  ?? "0.0.0.0"
)) {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_PANEL_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createPanelServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const codexProcessEnvironment = withoutPanelLauncherEnvironment(
    options.processEnv ?? process.env,
  );
  const routePrefix = resolved.instanceToken ? `/${resolved.instanceToken}` : "";
  const database = new PanelDatabase(resolved.databasePath);
  const events = new EventHub();
  let clientStorageWrite = Promise.resolve();

  async function readClientStorage() {
    try {
      const value = JSON.parse(await readFile(resolved.clientStoragePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function updateClientStorage(body) {
    assertPlainObject(body);
    assertAllowedKeys(body, new Set(["key", "value"]));
    const key = stringField(body.key, "key", { required: true, maxLength: 512 });
    const value = stringField(body.value, "value", { nullable: true, maxLength: 100_000 });
    clientStorageWrite = clientStorageWrite.catch(() => {}).then(async () => {
      const entries = await readClientStorage();
      if (value === null) delete entries[key];
      else entries[key] = value;
      await mkdir(path.dirname(resolved.clientStoragePath), { recursive: true });
      const temporaryPath = `${resolved.clientStoragePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, resolved.clientStoragePath);
      await chmod(resolved.clientStoragePath, 0o600);
    });
    await clientStorageWrite;
  }
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const jiraConfig = options.jiraConfigStore ?? createJiraConfigStore({
    configPath: resolved.jiraConfigPath,
  });
  const jira = createJiraIntegration({
    configStore: jiraConfig,
    database,
    fetch: options.jiraFetch ?? globalThis.fetch,
  });
  const jiraAutoComplete = new JiraAutoCompleteService({
    database,
    jira,
    onChanged: (context) => {
      events.emit("task.jira.updated", { taskId: context.jira.id, task: context.jira });
    },
  });
  const interruptNativeThread = options.interruptNativeThread ?? (async (binding) => (
    sendInjectorControlRequest({
      runtimeFile: process.env.CODEX_PANEL_RUNTIME_FILE
        ?? process.env.CODEX_TASKBOARD_RUNTIME_FILE
        ?? path.join(resolved.dataDirectory, "launcher-runtime.json"),
      action: "interrupt-thread",
      payload: {
        threadId: binding.threadId,
        codexHostId: binding.codexHostId,
      },
      ownership: {
        nodePath: process.execPath,
        injectorPath: path.join(PROJECT_ROOT, "scripts", "codex-injector.mjs"),
      },
    })
  ));
  let hostRuntime = null;
  function currentHostThreadBinding(threadId) {
    if (
      !hostRuntime
      || hostRuntime.threadId !== threadId
      || !hostRuntime.codexProjectId
      || !hostRuntime.codexProjectKind
      || !hostRuntime.codexHostId
      || !hostRuntime.workspacePath
    ) return undefined;
    return {
      threadId,
      codexProjectId: hostRuntime.codexProjectId,
      codexProjectKind: hostRuntime.codexProjectKind,
      codexHostId: hostRuntime.codexHostId,
      workspacePath: hostRuntime.workspacePath,
    };
  }
  function resolveInputThreadBinding(input) {
    if (input.threadBinding !== undefined) return input;
    const threadBinding = currentHostThreadBinding(input.threadId);
    return threadBinding ? { ...input, threadBinding } : input;
  }
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveThreadBinding: currentHostThreadBinding,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath, codexProcessEnvironment);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
    assertTaskProjectMoveAllowed: (taskId, targetProjectId) => {
      if (!database.hasAiChatThreadProjectConflict(taskId, targetProjectId)) return;
      throw new CloudProxyError(
        409,
        "AI_CHAT_PROJECT_MOVE_BLOCKED",
        "Delete issue-linked AI conversations before moving the issue to another project",
      );
    },
  });
  async function readCloudJson(pathname) {
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    }));
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(
        upstream.ok ? 502 : upstream.status,
        "INVALID_CLOUD_RESPONSE",
        "Cloud panel returned an invalid JSON response",
      );
    }
    if (!upstream.ok) {
      throw new ApiError(
        upstream.status,
        payload?.error?.code ?? "CLOUD_REQUEST_FAILED",
        payload?.error?.message ?? "Cloud panel request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  async function resolveAiChatContext(projectId, issueId) {
    const config = await cloudConfig.read();
    if (!config.remoteUrl) {
      let resolvedWorkspace;
      try {
        resolvedWorkspace = await resolveAiWorkspace(
          projectId,
          resolved.codexStatePath,
          database,
        );
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "PROJECT_WORKSPACE_UNAVAILABLE"
          || projectId !== DEFAULT_PROJECT_ID
        ) {
          throw error;
        }
        resolvedWorkspace = {
          workspacePath: PROJECT_ROOT,
          addDirectories: [],
          project: database.getProject(projectId),
        };
      }
      let issue;
      if (issueId !== undefined) {
        issue = database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return {
        ...resolvedWorkspace,
        workspacePath: issue?.developmentContext?.type === "worktree"
          ? issue.developmentContext.path
          : resolvedWorkspace.workspacePath,
        issue,
      };
    }

    const projectPayload = await readCloudJson("/api/projects");
    const project = Array.isArray(projectPayload.projects)
      ? projectPayload.projects.find((candidate) => candidate?.id === projectId)
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    let issue;
    if (issueId !== undefined) {
      const issuePayload = await readCloudJson(`/api/tasks/${encodeURIComponent(issueId)}`);
      issue = issuePayload.task;
      if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
    }

    const resolvedWorkspace = await resolveMappedAiWorkspace(
      projectId,
      project,
      config.projectMappings,
    );
    return { ...resolvedWorkspace, issue };
  }

  const aiChat = new AiChatService({
    database,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    managePanelSkillPath: resolved.skillPath,
    handoffActor: CODEX_AGENT_ACTOR,
    onIssueCommentCreated: ({ comment, task }) => {
      events.emit("comment.created", { comment, task });
    },
    processEnv: codexProcessEnvironment,
    resolveContext: resolveAiChatContext,
  });
  const failedAutomaticWorktrees = new Set();

  async function canonicalWorkspace(workspacePath) {
    try {
      return await realpath(workspacePath);
    } catch {
      return path.resolve(workspacePath);
    }
  }

  function automaticWorktreeBranch(task) {
    const slug = task.identifier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `panel/${slug || "issue"}-${task.id.slice(0, 8)}`;
  }

  async function prepareClaimExecution(task) {
    if (options.prepareClaimExecution) return await options.prepareClaimExecution(task);
    let current = database.getTask(task.id) ?? task;
    let context = await resolveAiChatContext(current.projectId, current.id);
    if (current.developmentContext?.type === "worktree") {
      return {
        task: current,
        workspacePath: context.workspacePath,
        workspaceKey: await canonicalWorkspace(context.workspacePath),
      };
    }

    const sharedWorkspace = context.workspacePath;
    const sharedWorkspaceKey = await canonicalWorkspace(sharedWorkspace);
    if (current.developmentContext || failedAutomaticWorktrees.has(current.id)) {
      return { task: current, workspacePath: sharedWorkspace, workspaceKey: sharedWorkspaceKey };
    }
    const existingThreadId = database.suggestedExecutionThreadId(current.id);
    const existingThread = existingThreadId ? database.getAiChatThread(existingThreadId) : null;
    if (existingThread) {
      return {
        task: current,
        workspacePath: existingThread.origin.workspacePath,
        workspaceKey: await canonicalWorkspace(existingThread.origin.workspacePath),
      };
    }

    let repositoryRoot;
    let worktreePath;
    let branch;
    try {
      const rootResult = await execFileAsync(
        "git",
        ["-C", sharedWorkspace, "rev-parse", "--show-toplevel"],
        { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      repositoryRoot = await canonicalWorkspace(rootResult.stdout.trim());
      worktreePath = path.join(resolved.dataDirectory, "worktrees", current.id);
      branch = automaticWorktreeBranch(current);
      await mkdir(path.dirname(worktreePath), { recursive: true });
      let baseRef = "refs/heads/main";
      try {
        await execFileAsync(
          "git",
          ["-C", repositoryRoot, "show-ref", "--verify", "refs/remotes/origin/main"],
          { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
        baseRef = "refs/remotes/origin/main";
      } catch {
        await execFileAsync(
          "git",
          ["-C", repositoryRoot, "show-ref", "--verify", "refs/heads/main"],
          { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
      }

      let existing = false;
      if (existsSync(worktreePath)) {
        try {
          await execFileAsync(
            "git",
            ["-C", worktreePath, "rev-parse", "--show-toplevel"],
            { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
          );
          existing = true;
        } catch {}
      }
      if (!existing) {
        try {
          await execFileAsync(
            "git",
            ["-C", repositoryRoot, "worktree", "add", "-b", branch, worktreePath, baseRef],
            { env: codexProcessEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
          );
        } catch (createError) {
          try {
            await execFileAsync(
              "git",
              ["-C", repositoryRoot, "show-ref", "--verify", `refs/heads/${branch}`],
              { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
            );
            await execFileAsync(
              "git",
              ["-C", repositoryRoot, "worktree", "add", worktreePath, branch],
              { env: codexProcessEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
            );
          } catch {
            throw createError;
          }
        }
      }
    } catch {
      // ponytail: retry worktree creation after a service restart; this process uses safe shared-workspace serialism.
      failedAutomaticWorktrees.add(current.id);
      return { task: current, workspacePath: sharedWorkspace, workspaceKey: sharedWorkspaceKey };
    }

    current = database.getTask(current.id) ?? current;
    if (!current.developmentContext) {
      current = database.updateTask(
        current.id,
        current.version,
        { developmentContext: { type: "worktree", path: worktreePath, branch } },
        undefined,
        undefined,
        CODEX_AGENT_ACTOR,
      );
      events.emit("task.updated", { task: current });
    }
    context = await resolveAiChatContext(current.projectId, current.id);
    return {
      task: current,
      workspacePath: context.workspacePath,
      workspaceKey: await canonicalWorkspace(context.workspacePath),
    };
  }

  async function cleanupClaimExecution(task) {
    if (options.cleanupClaimExecution) return await options.cleanupClaimExecution(task);
    if (task.status !== "done" || task.developmentContext?.type !== "worktree") return task;
    const worktreePath = await canonicalWorkspace(task.developmentContext.path);
    const branch = task.developmentContext.branch;
    const automaticWorktreeRoot = await canonicalWorkspace(path.join(resolved.dataDirectory, "worktrees"));
    if (
      !branch?.startsWith("panel/")
      || path.dirname(worktreePath) !== automaticWorktreeRoot
      || path.basename(worktreePath) !== task.id
    ) return task;
    try {
      const statusResult = await execFileAsync(
        "git",
        ["-C", worktreePath, "status", "--porcelain"],
        { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (statusResult.stdout.trim()) return task;
      const listResult = await execFileAsync(
        "git",
        ["-C", worktreePath, "worktree", "list", "--porcelain"],
        { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const repositoryRoot = parseWorktrees(listResult.stdout)[0]?.path;
      if (!repositoryRoot) return task;
      let merged = false;
      for (const target of ["refs/remotes/origin/main", "refs/heads/main"]) {
        try {
          await execFileAsync(
            "git",
            ["-C", repositoryRoot, "show-ref", "--verify", target],
            { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
          );
          await execFileAsync(
            "git",
            ["-C", repositoryRoot, "merge-base", "--is-ancestor", branch, target],
            { env: codexProcessEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 },
          );
          merged = true;
          break;
        } catch {}
      }
      if (!merged) return task;
      await execFileAsync(
        "git",
        ["-C", repositoryRoot, "worktree", "remove", worktreePath],
        { env: codexProcessEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch {
      return task;
    }

    const current = database.getTask(task.id);
    if (
      !current
      || current.status !== "done"
      || current.developmentContext?.type !== "worktree"
      || current.developmentContext.path !== task.developmentContext.path
    ) return current ?? task;
    const cleaned = database.updateTask(
      current.id,
      current.version,
      { developmentContext: null },
      undefined,
      undefined,
      CODEX_AGENT_ACTOR,
    );
    return cleaned;
  }

  const claimQueue = new ClaimQueueService({
    database,
    aiChat,
    prepareExecution: prepareClaimExecution,
    cleanupExecution: cleanupClaimExecution,
    onTaskChanged: (task) => events.emit("task.moved", { task }),
    onCommentCreated: ({ comment, task }) => events.emit("comment.created", { comment, task }),
    onQueueChanged: (claim) => events.emit("claim.updated", {
      projectId: claim.projectId,
      taskId: claim.taskId,
      claim,
    }),
    onPolicyChanged: (policy) => events.emit("automation.updated", {
      projectId: policy.projectId,
      policy,
    }),
  });
  const pendingJiraSimpleStarts = new Map();
  // ponytail: one in-process reservation per Jira is enough while this server owns all local mutations.
  const pendingJiraReopenActions = new Map();

  function jiraPlanningPrompt(jiraTask, projects, review, plan) {
    const repositories = projects.length > 0
      ? projects.map((project) => `- ${project.name} (${project.id})`).join("\n")
      : "- 尚未关联仓库；可以先澄清需求，但发布 tickets 前必须让用户在 Jira 详情中关联仓库。";
    const preservedItems = plan?.items.filter((item) => (
      item.task && ["in_progress", "in_review", "blocked", "done"].includes(item.task.status)
    )) ?? [];
    const preservedWork = preservedItems.length > 0
      ? preservedItems.map((item) => (
        `- ${item.key}: ${item.task.identifier} [${item.task.status}] ${item.task.title}`
      )).join("\n")
      : "- 无";
    return [
      review ? "Jira 内容或关联仓库已经变化，请重新复核规划。" : "请规划下面这个 Jira 需求。",
      "",
      `Jira: ${jiraTask.externalKey ?? jiraTask.identifier}`,
      `标题: ${jiraTask.title}`,
      `优先级: ${jiraTask.priority}`,
      "描述与需求链接:",
      jiraTask.description || "（无描述）",
      "",
      "关联仓库:",
      repositories,
      "",
      "必须保留并纳入新计划约束的已开始成果:",
      preservedWork,
      "",
      "这是规划会话，不授权修改仓库代码或开始执行 Issue。先使用 grill-me 澄清需求；确认后使用 to-spec 生成本地 Spec，再使用 to-tickets 拆分 tracer-bullet tickets。",
      `保存 Spec 与发布 tickets 时使用 manage-panel 中的 Jira planning 命令，Jira 标识固定为 ${jiraTask.id}。发布前必须让用户确认拆分结果，并确认每个 ticket 都选择了已关联仓库。`,
    ].join("\n");
  }

  async function startJiraPlanning(jiraTaskId, version) {
    const context = database.getJiraContext(jiraTaskId);
    if (!context.jira) {
      throw new ApiError(409, "JIRA_TASK_REQUIRED", "Only Jira issues can be planned");
    }
    if (context.jira.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Jira issue changed since it was read");
    }
    if (context.lifecycle?.pending?.kind === "reopened") {
      throw new ApiError(409, "JIRA_REPLAN_REQUIRED", "Choose how to handle the reopened Jira issue first");
    }
    const projectId = context.projects[0]?.id ?? DEFAULT_PROJECT_ID;
    let thread = context.plan?.threadId
      ? database.getAiChatThread(context.plan.threadId)
      : null;
    if (thread?.archivedAt) thread = null;
    if (!thread) {
      thread = await aiChat.createThread({
        projectId,
        title: `${context.jira.externalKey ?? context.jira.identifier} · Jira 规划`,
        sandbox: "read-only",
      });
    }
    const started = database.beginJiraPlanning(jiraTaskId, version, thread.id);
    if (started.shouldPrompt) {
      await aiChat.startTurn(thread.id, {
        message: jiraPlanningPrompt(context.jira, context.projects, Boolean(context.plan), context.plan),
        skillIds: ["grill-me", "to-spec", "to-tickets"],
      });
      database.markJiraPlanPrompted(jiraTaskId);
    }
    return { context: database.getJiraContext(jiraTaskId) };
  }

  async function createJiraReplan(jiraTaskId, version, reservation) {
    const context = database.beginJiraReplan(jiraTaskId, version, reservation);
    const projectId = context.projects[0]?.id ?? DEFAULT_PROJECT_ID;
    let thread;
    let run;
    try {
      thread = await aiChat.createThread({
        projectId,
        title: `${context.jira.externalKey ?? context.jira.identifier} · Jira 重新规划`,
        sandbox: "read-only",
      });
      run = await aiChat.startTurn(thread.id, {
        message: jiraPlanningPrompt(context.jira, context.projects, true, context.plan),
        skillIds: ["grill-me", "to-spec", "to-tickets"],
      });
      return {
        context: database.completeJiraReplan(
          jiraTaskId,
          context.jira.version,
          version,
          context.plan.version,
          thread.id,
          reservation,
        ),
      };
    } catch (error) {
      if (thread) {
        try {
          await aiChat.discardThread(thread.id);
        } catch (cleanupError) {
          throw new ApiError(
            500,
            "JIRA_REPLAN_CLEANUP_FAILED",
            `Jira replanning failed and its new conversation could not be removed: ${cleanupError.message}`,
            { cause: error.message },
          );
        }
      }
      throw error;
    }
  }

  function jiraPlanEdges(items) {
    const byKey = new Map(items.map((item) => [item.key, item]));
    return items.flatMap((item) => item.blockedBy.map((blockerKey) => [
      byKey.get(blockerKey).taskId,
      item.taskId,
    ]));
  }

  function publishJiraPlan(jiraTaskId, version, manifest, actor) {
    const started = database.beginJiraPlanPublish(jiraTaskId, version, manifest);
    for (const item of started.items) {
      let task = database.getTask(item.taskId);
      if (!task) {
        task = database.createTask({
          id: item.taskId,
          projectId: item.projectId,
          title: item.title,
          description: item.description,
          status: "backlog",
          priority: item.priority,
          labels: item.labels,
          actor,
          assignee: actor,
          workflowId: null,
          developmentContext: null,
          startDate: null,
          dueDate: null,
          recurrence: null,
        });
        events.emit("task.created", { task });
      } else if (task.projectId !== item.projectId || task.source === "jira" || task.archivedAt !== null) {
        throw new ApiError(
          409,
          "JIRA_PLAN_TASK_CONFLICT",
          `Issue '${task.identifier}' is no longer available for planning`,
        );
      } else if (task.status === "backlog" || task.status === "todo") {
        const changes = Object.fromEntries(Object.entries({
          title: item.title,
          description: item.description,
          priority: item.priority,
          labels: item.labels,
        }).filter(([key, value]) => JSON.stringify(task[key]) !== JSON.stringify(value)));
        if (Object.keys(changes).length > 0) {
          task = database.updateTask(task.id, task.version, changes, undefined, undefined, actor);
          events.emit("task.updated", { task });
        }
      }

      const context = database.getJiraContext(jiraTaskId);
      if (!context.issues.some((issue) => issue.id === task.id)) {
        const linked = database.addJiraTaskLink(jiraTaskId, context.jira.version, task.id, actor);
        events.emit("task.jira.updated", { taskId: task.id, task: linked.jira });
      }
    }

    const currentTaskIds = new Set(started.items.map((item) => item.taskId));
    for (const previous of started.previousItems) {
      if (currentTaskIds.has(previous.taskId)) continue;
      const task = database.getTask(previous.taskId);
      if (!task || !["backlog", "todo"].includes(task.status)) continue;
      const canceled = database.moveTask(
        task.id,
        task.version,
        "canceled",
        undefined,
        undefined,
        undefined,
        actor,
      );
      events.emit("task.moved", { task: canceled });
    }

    database.replaceJiraPlanBlocks(
      jiraTaskId,
      started.plan.publication - 1,
      started.plan.publication,
      jiraPlanEdges(started.items),
    );
    const plan = database.finishJiraPlanPublish(jiraTaskId, started.plan.publication);
    events.emit("task.jira.updated", { taskId: jiraTaskId, task: database.getTask(jiraTaskId) });
    return { context: database.getJiraContext(jiraTaskId), plan };
  }

  async function createAndStartSimpleJira(jiraTaskId, version, actor) {
    const started = database.beginJiraSimpleStart(jiraTaskId, version);
    if (started.operation.status === "complete") {
      return {
        context: database.getJiraContext(jiraTaskId),
        operation: started.operation,
      };
    }
    if (!started.operation.transitionedAt) {
      await jira.moveTask(started.jira, "in_progress");
      database.markJiraSimpleStartTransitioned(started.operation.id);
    }

    for (const item of database.listJiraSimpleStartItems(jiraTaskId)) {
      let task = database.getTask(item.taskId);
      if (!task) {
        task = database.createTask({
          id: item.taskId,
          projectId: item.projectId,
          title: started.jira.title,
          description: started.jira.description,
          status: "backlog",
          priority: started.jira.priority,
          labels: started.jira.labels,
          actor,
          assignee: CODEX_AGENT_ACTOR,
          workflowId: null,
          developmentContext: null,
          startDate: null,
          dueDate: null,
          recurrence: null,
        });
        events.emit("task.created", { task });
      }
      if (task.projectId !== item.projectId || task.source === "jira" || task.archivedAt !== null) {
        throw new ApiError(
          409,
          "JIRA_SIMPLE_START_TASK_CONFLICT",
          `Issue '${task.identifier}' no longer belongs to the selected active repository`,
        );
      }

      let context = database.getJiraContext(jiraTaskId);
      if (!context.issues.some((issue) => issue.id === task.id)) {
        context = database.addJiraTaskLink(
          jiraTaskId,
          context.jira.version,
          task.id,
          actor,
        );
        events.emit("task.jira.updated", { taskId: task.id, task: context.jira });
      }

      let thread = database.getAiChatThread(item.threadId);
      if (!thread) {
        const prepared = await prepareClaimExecution(task);
        task = prepared.task;
        thread = await aiChat.createThread({
          id: item.threadId,
          projectId: task.projectId,
          issueId: task.id,
          title: `${task.identifier} · ${started.jira.externalKey ?? started.jira.identifier}`,
        });
      }
      if (thread.origin.issueId !== task.id || thread.status !== "idle") {
        throw new ApiError(
          409,
          "JIRA_SIMPLE_START_THREAD_CONFLICT",
          `Conversation '${thread.id}' is no longer idle for '${task.identifier}'`,
        );
      }
    }

    for (const item of database.listJiraSimpleStartItems(jiraTaskId)) {
      const task = database.getTask(item.taskId);
      if (task.status !== "backlog") continue;
      const moved = database.moveTask(
        task.id,
        task.version,
        "todo",
        undefined,
        undefined,
        undefined,
        actor,
      );
      events.emit("task.moved", { task: moved });
    }

    for (const item of database.listJiraSimpleStartItems(jiraTaskId)) {
      const task = database.getTask(item.taskId);
      if (task.status === "todo") claimQueue.enqueue(task.id, "manual");
    }

    const currentJira = database.getTask(jiraTaskId);
    if (currentJira.status !== "in_progress") {
      const moved = database.moveTask(
        currentJira.id,
        currentJira.version,
        "in_progress",
        undefined,
        undefined,
        undefined,
        actor,
      );
      events.emit("task.moved", { task: moved });
    }
    database.completeJiraSimpleStart(started.operation.id);
    return {
      context: database.getJiraContext(jiraTaskId),
      operation: database.getJiraSimpleStartOperation(jiraTaskId),
    };
  }

  function runSimpleJiraStart(jiraTaskId, version, actor) {
    const current = pendingJiraSimpleStarts.get(jiraTaskId);
    if (current) return current;
    const operation = createAndStartSimpleJira(jiraTaskId, version, actor)
      .finally(() => pendingJiraSimpleStarts.delete(jiraTaskId));
    pendingJiraSimpleStarts.set(jiraTaskId, operation);
    return operation;
  }

  async function createJiraRework(jiraTaskId, version, actor, reservation) {
    const started = database.beginJiraRework(jiraTaskId, version, reservation);
    for (const item of started.items) {
      let task = database.getTask(item.taskId);
      if (!task) {
        task = database.createTask({
          id: item.taskId,
          projectId: item.projectId,
          title: `返工：${started.jira.title}`,
          description: started.jira.description,
          status: started.jira.status === "in_progress" ? "todo" : "backlog",
          priority: started.jira.priority,
          labels: started.jira.labels,
          actor,
          assignee: CODEX_AGENT_ACTOR,
          workflowId: null,
          developmentContext: null,
          startDate: null,
          dueDate: null,
          recurrence: null,
        });
        events.emit("task.created", { task });
      }
      let context = database.getJiraContext(jiraTaskId);
      if (!context.issues.some((issue) => issue.id === task.id)) {
        context = database.addJiraTaskLink(
          jiraTaskId,
          context.jira.version,
          task.id,
          actor,
          reservation,
        );
        events.emit("task.jira.updated", { taskId: task.id, task: context.jira });
      }
      if (!database.getAiChatThread(item.threadId)) {
        await aiChat.createThread({
          id: item.threadId,
          projectId: task.projectId,
          issueId: task.id,
          title: `${task.identifier} · ${started.jira.externalKey ?? started.jira.identifier} · 返工`,
        });
      }
    }
    return { context: database.completeJiraReopen(jiraTaskId, version, reservation) };
  }

  function runJiraRework(jiraTaskId, version, actor) {
    return runJiraReopenAction(jiraTaskId, version, "rework", (reservation) => (
      createJiraRework(jiraTaskId, version, actor, reservation)
    ));
  }

  function runJiraReplan(jiraTaskId, version) {
    return runJiraReopenAction(
      jiraTaskId,
      version,
      "replan",
      (reservation) => createJiraReplan(jiraTaskId, version, reservation),
    );
  }

  function runJiraReopenAction(jiraTaskId, version, action, execute) {
    const current = pendingJiraReopenActions.get(jiraTaskId);
    if (current) {
      if (current.action === action) return current.operation;
      throw new ApiError(
        409,
        "JIRA_REOPEN_ACTION_IN_PROGRESS",
        "Another reopened Jira action is already being applied",
      );
    }
    const entry = { action, operation: null };
    entry.operation = Promise.resolve()
      .then(async () => {
        const reservation = database.beginJiraReopenAction(jiraTaskId, version, action);
        try {
          return await execute(reservation);
        } finally {
          database.finishJiraReopenAction(jiraTaskId, reservation);
        }
      })
      .finally(() => {
        if (pendingJiraReopenActions.get(jiraTaskId) === entry) {
          pendingJiraReopenActions.delete(jiraTaskId);
        }
      });
    pendingJiraReopenActions.set(jiraTaskId, entry);
    return entry.operation;
  }
  const projectSummary = new ProjectSummaryService({
    database,
    codexExecutable: resolved.codexExecutable,
    processEnv: codexProcessEnvironment,
    workspacePath: PROJECT_ROOT,
  });
  const aiEventResponses = new Set();
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (resolved.instanceToken && incomingUrl.pathname !== "/health") {
        if (incomingUrl.pathname === routePrefix) {
          response.writeHead(301, { location: `${incomingUrl.pathname}/${incomingUrl.search}` });
          response.end();
          return;
        }
        if (
          incomingUrl.pathname !== routePrefix
          && !incomingUrl.pathname.startsWith(`${routePrefix}/`)
        ) {
          throw new ApiError(404, "NOT_FOUND", "Route not found");
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }

      assertTrustedNetworkRequest(request, Boolean(resolved.instanceToken));
      const origin = request.headers.origin;
      const trustedEmbedOrigin = TRUSTED_EMBED_ORIGINS.has(origin)
        || (Boolean(resolved.instanceToken) && origin === "null");
      if (trustedEmbedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          request.headers["access-control-request-headers"] ?? "content-type",
        );
        response.setHeader("access-control-expose-headers", "x-codex-panel-proof");
        response.setHeader("access-control-allow-private-network", "true");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (resolved.instanceToken && origin === "app://-") {
        const challenge = request.headers["x-codex-panel-challenge"]
          ?? request.headers["x-codex-taskboard-challenge"];
        if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
          throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
        }
        response.setHeader(
          "x-codex-panel-proof",
          createHmac("sha256", resolved.instanceSecret).update(challenge).digest("hex"),
        );
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || pathname === "/api/workflow-capabilities"
        || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (resolved.instanceToken) {
          const challenge = request.headers["x-codex-panel-challenge"]
            ?? request.headers["x-codex-taskboard-challenge"];
          if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
            throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
          }
          return sendJson(response, 200, {
            status: "ok",
            product: "codex-panel",
            version: resolved.version,
            proof: createHmac("sha256", resolved.instanceSecret)
              .update(challenge)
              .digest("hex"),
          });
        }
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/client-storage") {
        if (request.method === "GET") {
          await clientStorageWrite;
          return sendJson(response, 200, { entries: await readClientStorage() });
        }
        if (request.method === "PATCH") {
          await updateClientStorage(await readJson(request));
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(url.searchParams.getAll("threadId").map((value) => (
          value.trim().replace(/^(?:local|cloud):/i, "")
        )))];
        if (threadIds.length > 64 || threadIds.some((threadId) => (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ))) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
          ]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            codexProjectId: stringField(body.codexProjectId ?? null, "codexProjectId", {
              nullable: true,
              maxLength: 256,
            }),
            codexProjectKind: body.codexProjectKind === "local" || body.codexProjectKind === "remote"
              ? body.codexProjectKind
              : null,
            codexHostId: stringField(body.codexHostId ?? null, "codexHostId", {
              nullable: true,
              maxLength: 256,
            }),
            workspacePath: stringField(body.workspacePath ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
            updatedAt: Date.now(),
          };
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/jira-connection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 连接接口不接受查询参数");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { connection: await jira.status() });
        }
        if (request.method === "PUT") {
          const activeCloudConfig = await cloudConfig.read();
          if (activeCloudConfig.remoteUrl) {
            throw new ApiError(
              409,
              "JIRA_LOCAL_MODE_REQUIRED",
              "Jira 连接当前仅支持本地数据模式，请先退出云端协作模式",
            );
          }
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "baseUrl",
            "authMethod",
            "username",
            "password",
            "projects",
            "acceptAccountChange",
          ]));
          const baseUrl = stringField(body.baseUrl, "baseUrl", { required: true, maxLength: 2048 });
          const authMethod = body.authMethod ?? undefined;
          if (authMethod !== undefined && authMethod !== "basic" && authMethod !== "bearer") {
            throw new ApiError(400, "INVALID_FIELD", "'authMethod' must be 'basic' or 'bearer'");
          }
          const username = stringField(body.username ?? "", "username", { maxLength: 254 });
          const password = body.password ?? "";
          if (typeof password !== "string") {
            throw new ApiError(400, "INVALID_FIELD", "'password' must be a string");
          }
          if (password.length > 4096) {
            throw new ApiError(400, "INVALID_FIELD", "'password' cannot exceed 4096 characters");
          }
          if (body.acceptAccountChange !== undefined && typeof body.acceptAccountChange !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'acceptAccountChange' must be a boolean");
          }
          try {
            const connection = await jira.configure({
              baseUrl,
              authMethod,
              username,
              password,
              projects: body.projects,
              acceptAccountChange: body.acceptAccountChange === true,
            });
            events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
            return sendJson(response, 200, { connection });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, error.code ?? "INVALID_JIRA_CONFIG", error.message);
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-settings") {
        assertNoQuery(url.searchParams, "Jira settings routes");
        if (request.method === "GET") {
          return sendJson(response, 200, { settings: database.getJiraSettings() });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["autoCompleteEnabled"]));
          if (typeof body.autoCompleteEnabled !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'autoCompleteEnabled' must be a boolean");
          }
          const settings = database.saveJiraSettings(body);
          if (settings.autoCompleteEnabled) jiraAutoComplete.queueAllEligible();
          return sendJson(response, 200, { settings });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-connection/sync") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 同步接口不接受查询参数");
        }
        const hasBody = Number(request.headers["content-length"] ?? 0) > 0
          || request.headers["transfer-encoding"] !== undefined;
        let acceptAccountChange = false;
        if (hasBody) {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["acceptAccountChange"]));
          if (typeof body.acceptAccountChange !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'acceptAccountChange' must be a boolean");
          }
          acceptAccountChange = body.acceptAccountChange;
        }
        const connection = await jira.sync({ force: true, acceptAccountChange });
        events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
        return sendJson(response, 200, { connection });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          managePanelSkillPath: resolved.nativeSkillPath,
          capabilities: { localAiChat: isLoopbackAddress(request.socket.remoteAddress) },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: { transport: "poll", intervalMs: 2000 },
              localCapabilities: { available: true },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["projectId"]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(response, 200, await aiChat.getCatalog(projectId));
      }

      if (pathname === "/api/local/ai/composer/candidates") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const query = parseComposerCandidateQuery(url.searchParams);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.candidatesForSurface(
            await aiChat.getComposerCandidates(query),
            query,
          ),
        );
      }

      if (pathname === "/api/local/ai/composer/rebind") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/composer/rebind");
        const input = parseComposerRebindRequest(await readJson(request));
        const workspacePath = await resolveComposerRebindWorkspace(aiChat, input);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.rebindPersistedReferences({
            workspacePath,
            nodes: input.document.nodes,
          }),
        );
      }

      const projectSummaryRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/summary$/);
      if (projectSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/summary");
        const projectId = validateProjectId(
          decodeRouteSegment(projectSummaryRoute[1], "Project id"),
        );
        return sendJson(response, 200, projectSummary.get(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        claimQueue.resumeAfterUserTurn(threadId, run.id);
        return sendJson(response, 202, { run });
      }

      const aiThreadCompactRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/compact$/);
      if (aiThreadCompactRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/compact");
        const threadId = decodeRouteSegment(aiThreadCompactRoute[1], "Thread id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/threads/:id/compact");
        const thread = await aiChat.compactThread(threadId);
        return sendJson(response, 200, { thread });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }

      const projectAutomationRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/automation$/);
      if (projectAutomationRoute) {
        assertNoQuery(url.searchParams, "/api/local/projects/:id/automation");
        const projectId = validateProjectId(
          decodeRouteSegment(projectAutomationRoute[1], "Project id"),
        );
        if (request.method === "GET") {
          return sendJson(response, 200, { policy: claimQueue.getProjectPolicy(projectId) });
        }
        if (request.method === "PUT") {
          const policy = claimQueue.saveProjectPolicy(
            projectId,
            parseProjectAutomationPolicy(await readJson(request)),
          );
          return sendJson(response, 200, { policy });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const taskClaimRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/claim$/);
      if (taskClaimRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/tasks/:id/claim");
        await assertEmptyRequestBody(request, "POST /api/local/tasks/:id/claim");
        const taskId = decodeRouteSegment(taskClaimRoute[1], "Task id");
        return sendJson(response, 202, claimQueue.enqueue(taskId));
      }

      if (pathname === "/api/workflow-capabilities") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const workspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (workspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        if (workspacePath && !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        return sendJson(
          response,
          200,
          await discoverWorkflowCapabilities(
            resolved,
            workspacePath ?? PROJECT_ROOT,
            codexProcessEnvironment,
          ),
        );
      }

      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          const projects = database.listProjects().map((project) => ({
            ...project,
            workspacePath: project.id === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig?.projectMappings[project.id] ?? project.workspacePath,
          }));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "DELETE") {
          database.deleteProject(projectId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["DELETE"]);
      }

      const projectLabelsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
      if (projectLabelsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project label routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectLabelsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST" && request.method !== "DELETE") {
          return methodNotAllowed(response, ["POST", "DELETE"]);
        }
        if (request.method === "DELETE" && projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
            "Jira 标签目录由同步管理，不能在 Panel 中删除",
          );
        }
        const label = parseProjectLabel(await readJson(request));
        const project = request.method === "POST"
          ? database.addProjectLabel(projectId, label)
          : database.deleteProjectLabel(projectId, label);
        events.emit("project.labels.updated", { project });
        return sendJson(response, 200, { project });
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
          events.emit("workflow.updated", {
            projectId,
            workflowVersion: workflow.version,
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: projectId === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(
          response,
          200,
          await scanDevelopmentContexts(workspacePath, codexProcessEnvironment),
        );
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (filters.projectId === JIRA_PROJECT_ID) {
            try {
              await jira.sync();
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              // Jira sync state carries the failure; keep cached issues readable.
            }
          }
          return sendJson(response, 200, { tasks: database.listTasks(filters) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...parsedInput } = parseTaskCreate(await readJson(request));
          const input = resolveInputThreadBinding(parsedInput);
          if (input.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_CREATE_UNAVAILABLE",
              "请在 Jira 中新建议题，Panel 当前只同步已分配给你的任务",
            );
          }
          const task = database.createTask({
            ...input,
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          events.emit("task.created", { task });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const jiraContextRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-context$/);
      if (jiraContextRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(jiraContextRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira context routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { context: database.getJiraContext(taskId) });
        }
        if (request.method === "PUT") {
          const { version, projectIds } = parseJiraProjects(await readJson(request));
          const context = database.setJiraProjects(
            taskId,
            version,
            projectIds,
            actorFromRequest(request),
          );
          events.emit("task.jira.updated", { taskId, task: context.jira });
          return sendJson(response, 200, { context });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const jiraAutoCompleteRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-auto-complete$/);
      if (jiraAutoCompleteRoute) {
        const jiraTaskId = decodeRouteSegment(jiraAutoCompleteRoute[1], "Task id");
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/jira-auto-complete");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["action"]));
        if (body.action === "retry") {
          jiraAutoComplete.retry(jiraTaskId);
        } else if (body.action === "accept_remote") {
          await jira.reconcile();
          const context = database.dismissJiraAutoCompletionConflict(jiraTaskId);
          events.emit("task.jira.updated", { taskId: jiraTaskId, task: context.jira });
          return sendJson(response, 200, { context });
        } else {
          throw new ApiError(400, "INVALID_FIELD", "Unsupported Jira automatic completion action");
        }
        const context = database.getJiraContext(jiraTaskId);
        events.emit("task.jira.updated", { taskId: jiraTaskId, task: context.jira });
        return sendJson(response, 200, { context });
      }

      const jiraLifecycleRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-lifecycle$/);
      if (jiraLifecycleRoute) {
        const jiraTaskId = decodeRouteSegment(jiraLifecycleRoute[1], "Task id");
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/jira-lifecycle");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const { version, action } = parseJiraLifecycle(await readJson(request));
        if (action === "rework") {
          return sendJson(
            response,
            200,
            await runJiraRework(jiraTaskId, version, actorFromRequest(request)),
          );
        }
        if (action === "replan") {
          return sendJson(response, 200, await runJiraReplan(jiraTaskId, version));
        }
        let targets = null;
        let result;
        let interruptFailures = [];
        try {
          if (action === "pause") {
            targets = database.beginJiraLifecyclePause(jiraTaskId, version);
            const linkedIssues = database.getJiraContext(jiraTaskId).issues
              .map((task) => database.getTask(task.id))
              .filter(Boolean);
            const affected = new Set(linkedIssues.map((task) => task.id));
            const runIds = aiChat.listThreads().flatMap((thread) => (
              thread.origin.issueId && affected.has(thread.origin.issueId) && thread.currentRun
                ? [thread.currentRun.id]
                : []
            ));
            const bindings = [...new Map(linkedIssues.flatMap((task) => (
              task.threadBinding
                ? [[`${task.threadBinding.codexHostId}:${task.threadBinding.threadId}`, task.threadBinding]]
                : []
            ))).values()];
            const interruptions = await Promise.allSettled([
              ...bindings.map((binding) => interruptNativeThread(binding)),
              ...runIds.map((runId) => aiChat.interrupt(runId)),
            ]);
            interruptFailures = interruptions
              .filter((interruption) => interruption.status === "rejected")
              .map((interruption) => (
                interruption.reason instanceof Error
                  ? interruption.reason.message
                  : String(interruption.reason)
              ));
          }
          result = database.resolveJiraLifecycle(jiraTaskId, version, action, targets);
        } finally {
          if (targets) database.finishJiraLifecyclePause(jiraTaskId, targets);
        }
        if (action === "pause" && result.affectedTaskIds.length > 0) {
          for (const taskId of result.affectedTaskIds) {
            events.emit("task.moved", { task: database.getTask(taskId) });
          }
        }
        events.emit("task.jira.updated", { taskId: jiraTaskId, task: result.context.jira });
        if (interruptFailures.length > 0) {
          throw new ApiError(
            502,
            "CODEX_INTERRUPT_PARTIAL_FAILURE",
            `关联 Issue 已暂停，但有 ${interruptFailures.length} 个 Codex 任务未能中断：${interruptFailures.join("；")}`,
          );
        }
        return sendJson(response, 200, { context: result.context });
      }

      const jiraSimpleStartRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-simple-start$/);
      if (jiraSimpleStartRoute) {
        let jiraTaskId;
        try {
          jiraTaskId = decodeURIComponent(jiraSimpleStartRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira start routes do not accept query parameters");
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const { version } = parseJiraSimpleStart(await readJson(request));
        return sendJson(
          response,
          200,
          await runSimpleJiraStart(jiraTaskId, version, actorFromRequest(request)),
        );
      }

      const jiraPlanSpecRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-planning\/spec$/);
      if (jiraPlanSpecRoute) {
        const jiraTaskId = decodeRouteSegment(jiraPlanSpecRoute[1], "Task id");
        assertNoQuery(url.searchParams, "PUT /api/tasks/:id/jira-planning/spec");
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        const { version, spec } = parseJiraPlanSpec(await readJson(request));
        const plan = database.saveJiraPlanSpec(jiraTaskId, version, spec);
        events.emit("task.jira.updated", { taskId: jiraTaskId, task: database.getTask(jiraTaskId) });
        return sendJson(response, 200, { context: database.getJiraContext(jiraTaskId), plan });
      }

      const jiraPlanPublishRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-planning\/publish$/);
      if (jiraPlanPublishRoute) {
        const jiraTaskId = decodeRouteSegment(jiraPlanPublishRoute[1], "Task id");
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/jira-planning/publish");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const { version, items } = parseJiraPlanPublish(await readJson(request));
        return sendJson(
          response,
          200,
          publishJiraPlan(jiraTaskId, version, items, actorFromRequest(request)),
        );
      }

      const jiraPlanningRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-planning$/);
      if (jiraPlanningRoute) {
        const jiraTaskId = decodeRouteSegment(jiraPlanningRoute[1], "Task id");
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/jira-planning");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const { version } = parseJiraSimpleStart(await readJson(request));
        return sendJson(response, 200, await startJiraPlanning(jiraTaskId, version));
      }

      const jiraLinkRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/jira-links\/([^/]+)$/);
      if (jiraLinkRoute) {
        let jiraTaskId;
        let taskId;
        try {
          jiraTaskId = decodeURIComponent(jiraLinkRoute[1]);
          taskId = decodeURIComponent(jiraLinkRoute[2]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira link routes do not accept query parameters");
        }
        const { version } = parseArchive(await readJson(request));
        const actor = actorFromRequest(request);
        let context = request.method === "POST"
          ? database.addJiraTaskLink(jiraTaskId, version, taskId, actor)
          : request.method === "DELETE"
            ? database.removeJiraTaskLink(jiraTaskId, version, taskId, actor)
            : null;
        if (!context) return methodNotAllowed(response, ["POST", "DELETE"]);
        jiraAutoComplete.reconcile(jiraTaskId);
        context = database.getJiraContext(jiraTaskId);
        events.emit("task.jira.updated", { taskId, task: context.jira });
        return sendJson(response, 200, { context });
      }

      const taskActivitiesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
      if (taskActivitiesRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskActivitiesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Activity routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { activities: database.listTaskActivities(taskId) });
        }
        return methodNotAllowed(response, ["GET"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { comments: database.listComments(taskId) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const comment = database.createComment(taskId, {
            ...resolveInputThreadBinding(parseCommentCreate(await readJson(request))),
            actor,
          });
          const task = database.getTask(taskId);
          events.emit("comment.created", { comment, task });
          if (actor.type === "user") claimQueue.resumeFromUserComment(taskId);
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = resolveInputThreadBinding(parseCommentPatch(await readJson(request)));
          const comment = database.updateComment(
            id,
            patch.version,
            patch.body,
            patch.threadId,
            patch.threadBinding,
          );
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listCommentAttachments(commentId) });
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listAttachments(taskId) });
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/(content|download)$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = attachmentContentRoute[2] === "content"
          && INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "PATCH") {
          const actor = actorFromRequest(request);
          const {
            version,
            changes,
            threadId,
            threadBinding,
            assigneeTarget,
          } = resolveInputThreadBinding(parseTaskPatch(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          let jiraChanged = false;
          if (current.source !== "jira" && changes.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_PROJECT_MOVE_UNAVAILABLE",
              "本地任务不能移入 Jira 同步项目",
            );
          }
          if (current.source === "jira") {
            if (current.version !== version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be updated");
            }
            if (Object.hasOwn(changes, "projectId")) {
              throw new ApiError(409, "JIRA_PROJECT_MOVE_UNAVAILABLE", "Jira 任务不能移到本地项目");
            }
            if (assigneeTarget !== undefined) {
              throw new ApiError(409, "JIRA_ASSIGNEE_UNAVAILABLE", "请在 Jira 中修改经办人");
            }
            const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
            const recurrence = Object.hasOwn(changes, "recurrence")
              ? changes.recurrence
              : current.recurrence;
            if (recurrence && !dueDate) {
              throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
            }
            jiraChanged = await jira.updateTask(current, changes);
          }
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actor);
          }
          let task;
          try {
            task = database.updateTask(id, version, changes, threadId, threadBinding, actor);
          } catch (error) {
            if (jiraChanged) {
              try {
                await jira.reconcile();
              } catch {
                throw new ApiError(
                  502,
                  "JIRA_RECONCILE_FAILED",
                  "Jira 已更新，但 Panel 重新同步失败，请手动同步",
                );
              }
            }
            throw error;
          }
          if (current.source !== "jira" && task.status === "done") {
            task = await claimQueue.cleanupCompletedTask(task);
          }
          events.emit("task.updated", { task });
          if (current.source !== "jira") jiraAutoComplete.queueForTask(task.id);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "DELETE") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_DELETE_UNAVAILABLE", "Jira 任务不能从 Panel 永久删除");
          }
          const { version } = parseArchive(await readJson(request));
          const deleted = database.deleteArchivedTask(id, version);
          for (const attachmentId of deleted.attachmentIds) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachmentId));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          events.emit("task.deleted", { task: deleted.task });
          return sendEmpty(response, 204);
        }
        if (action === "move" && request.method === "POST") {
          const move = resolveInputThreadBinding(parseMove(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (current.source === "jira") {
            if (current.version !== move.version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: move.version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
            }
            await jira.moveTask(current, move.status);
          }
          let task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            move.threadId,
            move.threadBinding,
            actorFromRequest(request),
          );
          if (current.source !== "jira" && task.status === "done") {
            task = await claimQueue.cleanupCompletedTask(task);
          }
          events.emit("task.moved", { task });
          if (current.source !== "jira") jiraAutoComplete.queueForTask(task.id);
          return sendJson(response, 200, { task });
        }
        if (action === "archive" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_ARCHIVE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动归档");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.archiveTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.archived", { task });
          if (current?.source !== "jira") jiraAutoComplete.queueForTask(task.id);
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_RESTORE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动恢复");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.restoreTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.restored", { task });
          if (current?.source !== "jira") jiraAutoComplete.queueForTask(task.id);
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    claimQueue,
    jiraAutoComplete,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort(), fd = null } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Panel server must bind to 127.0.0.1 or 0.0.0.0");
      }
      if (fd !== null && (!Number.isInteger(fd) || fd < 3 || fd > 255)) {
        throw new Error("Panel server listen fd must be an inherited file descriptor");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (fd === null) server.listen(port, host);
        else server.listen({ fd });
      });
      listening = true;
      claimQueue.start();
      jiraAutoComplete.start();
      return server.address();
    },
    async close() {
      claimQueue.close();
      await jiraAutoComplete.close();
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      server.closeAllConnections();
      await aiChat.close();
      await projectSummary.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
