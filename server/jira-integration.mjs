import { createHash } from "node:crypto";

import { JIRA_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "duedate",
  "assignee",
  "reporter",
  "project",
  "resolution",
  "issuelinks",
  "created",
  "updated",
];
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

function quoteJqlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJiraJql(projects = []) {
  const projectFilter = projects.length > 0
    ? ` AND project in (${projects.map(quoteJqlString).join(", ")})`
    : "";
  return `assignee = currentUser()${projectFilter} AND statusCategory != Done ORDER BY updated DESC`;
}

function includesAny(value, terms) {
  const normalized = String(value ?? "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

export function taskStatusFromJira(status) {
  const name = status?.name ?? "";
  const category = status?.statusCategory?.key;
  if (category === "done") {
    return includesAny(name, ["cancel", "reject", "取消", "拒绝"]) ? "canceled" : "done";
  }
  if (category === "new") {
    return includesAny(name, ["backlog", "待立项", "需求池"]) ? "backlog" : "todo";
  }
  if (includesAny(name, ["review", "verify", "test", "验收", "评审", "测试"])) {
    return "in_review";
  }
  if (includesAny(name, ["block", "hold", "阻塞", "挂起"])) return "blocked";
  return "in_progress";
}

export function taskPriorityFromJira(priority) {
  const name = priority?.name ?? "";
  if (includesAny(name, ["highest", "critical", "blocker", "urgent", "紧急", "最高"])) {
    return "urgent";
  }
  if (includesAny(name, ["high", "major", "高"])) return "high";
  if (includesAny(name, ["medium", "normal", "中"])) return "medium";
  if (includesAny(name, ["low", "minor", "trivial", "低"])) return "low";
  return "none";
}

function actorFromJira(user, fallback) {
  const id = limitedString(user?.key ?? user?.name ?? user?.accountId, fallback, 240);
  return {
    type: "user",
    id: `jira:${id}`,
    name: limitedString(user?.displayName ?? user?.name, fallback, 120),
    avatarUrl: user?.avatarUrls?.["48x48"] ?? user?.avatarUrls?.["32x32"] ?? null,
  };
}

function jiraAccountId(user) {
  return limitedString(user?.accountId ?? user?.key ?? user?.name, "", 254);
}

function duplicateOfFromJira(fields) {
  const duplicateResolution = includesAny(fields.resolution?.name, ["duplicate", "重复"]);
  const link = Array.isArray(fields.issuelinks)
    ? fields.issuelinks.find((candidate) => (
      candidate?.outwardIssue?.key
      && includesAny(candidate?.type?.outward, ["duplicate", "重复"])
    ))
    : null;
  if (!duplicateResolution && !link) return null;
  return {
    externalKey: typeof link?.outwardIssue?.key === "string"
      ? link.outwardIssue.key.trim().slice(0, 128) || null
      : null,
  };
}

function accountFromJira(user, fallback) {
  const accountId = jiraAccountId(user);
  if (!accountId) {
    throw new ApiError(502, "INVALID_JIRA_ACCOUNT", "Jira 未返回稳定的登录账号身份");
  }
  return {
    accountId,
    displayName: limitedString(user?.displayName ?? user?.name, fallback, 254),
  };
}

function issueScopeState(issue, config) {
  const fields = issue?.fields ?? {};
  const statusCategory = fields.status?.statusCategory?.key;
  if (statusCategory === "done") return "outside";
  if (!statusCategory) return "unknown";
  if (jiraAccountId(fields.assignee) !== config.accountId) return "outside";
  if (config.projects.length === 0) return "inside";
  const projectNames = [fields.project?.key, fields.project?.name]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());
  if (projectNames.length === 0) return "unknown";
  return config.projects.some((project) => projectNames.includes(project.toLowerCase()))
    ? "inside"
    : "outside";
}

function jiraOriginId(manifest) {
  const applicationId = typeof manifest?.id === "string" ? manifest.id.trim() : "";
  if (!applicationId) {
    throw new ApiError(502, "INVALID_JIRA_ORIGIN", "Jira 未返回稳定的实例身份");
  }
  return createHash("sha256").update(applicationId).digest("hex");
}

function legacyJiraOriginId(baseUrl) {
  return createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
}

function normalizeIssue(issue, config, index = 0) {
  const fields = issue?.fields ?? {};
  const externalId = String(issue.id);
  const externalKey = limitedString(issue.key, "JIRA", 128);
  const internalId = `JIRA:${config.originId.toUpperCase()}:${externalId}`;
  const assignee = actorFromJira(fields.assignee, config.displayName);
  const reporter = actorFromJira(fields.reporter, config.displayName);
  const labels = Array.isArray(fields.labels)
    ? [...new Set(fields.labels.flatMap((label) => {
      if (typeof label !== "string") return [];
      const normalized = label.trim().slice(0, 64);
      return normalized ? [normalized] : [];
    }))].slice(0, 20)
    : [];
  return {
    id: internalId,
    identifier: internalId,
    title: limitedString(fields.summary, externalKey, 240),
    description: typeof fields.description === "string" ? fields.description.slice(0, 100_000) : "",
    status: taskStatusFromJira(fields.status),
    priority: taskPriorityFromJira(fields.priority),
    labels,
    sortOrder: (index + 1) * 1024,
    creator: reporter,
    assignee,
    dueDate: typeof fields.duedate === "string" ? fields.duedate : null,
    externalOrigin: config.originId,
    externalId,
    externalKey,
    externalUrl: `${config.baseUrl}/browse/${encodeURIComponent(externalKey)}`,
    externalStatus: limitedString(fields.status?.name, "Unknown", 128),
    externalUpdatedAt: typeof fields.updated === "string" ? fields.updated : null,
    duplicateOf: duplicateOfFromJira(fields),
    createdAt: typeof fields.created === "string" ? fields.created : new Date().toISOString(),
    updatedAt: typeof fields.updated === "string" ? fields.updated : new Date().toISOString(),
  };
}

function safeConfig(config, syncState, settings) {
  const state = syncState ?? {
    lastAttemptedAt: null,
    lastSuccessfulAt: null,
    syncedIssueCount: 0,
    unknownIssueCount: 0,
    syncError: null,
  };
  return config
    ? {
      configured: true,
      baseUrl: config.baseUrl,
      authMethod: config.username ? "basic" : "bearer",
      username: null,
      displayName: config.displayName,
      projects: config.projects,
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt: state.lastSuccessfulAt,
      ...state,
      autoCompleteEnabled: settings.autoCompleteEnabled,
      insecureHttp: config.baseUrl.startsWith("http:"),
    }
    : {
      configured: false,
      baseUrl: null,
      authMethod: "basic",
      username: null,
      displayName: null,
      projects: [],
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt: null,
      ...state,
      autoCompleteEnabled: settings.autoCompleteEnabled,
      insecureHttp: false,
    };
}

export function createJiraIntegration({ configStore, database, fetch: fetchImplementation = globalThis.fetch }) {
  let pendingSync = null;

  function settings() {
    return database.getJiraSettings?.() ?? { autoCompleteEnabled: false };
  }

  async function request(config, pathname, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(`${config.baseUrl}${pathname}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: config.username
            ? `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`
            : `Bearer ${config.password}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "JIRA_TIMEOUT" : "JIRA_UNAVAILABLE",
        timedOut ? "连接 Jira 超时" : "无法连接 Jira，请检查地址和内网连接",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401) {
      throw new ApiError(
        401,
        "JIRA_AUTH_FAILED",
        "Jira 登录已失效，请在 Jira 设置中检查账号、API Token、Bearer Token 或 CAPTCHA 状态",
      );
    }
    if (response.status === 403) {
      throw new ApiError(
        403,
        "JIRA_PERMISSION_DENIED",
        "当前 Jira 账号无权读取这些任务，请检查项目权限或重新连接账号",
      );
    }
    if (response.status === 404) {
      throw new ApiError(404, "JIRA_RESOURCE_NOT_FOUND", "Jira 资源不存在或当前账号无法查看");
    }
    if (response.status === 429) {
      throw new ApiError(502, "JIRA_RATE_LIMITED", "Jira 请求过于频繁，Panel 将稍后重试");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(400, "JIRA_REDIRECT", "Jira 地址发生重定向，请填写最终访问地址");
    }
    if (!response.ok) {
      throw new ApiError(
        response.status >= 500 ? 502 : 409,
        "JIRA_REQUEST_FAILED",
        `Jira 请求失败（HTTP ${response.status}）`,
      );
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, "INVALID_JIRA_RESPONSE", "Jira 返回了无效的 JSON 数据");
    }
  }

  async function fetchAssignedIssues(config) {
    const issues = [];
    let startAt = 0;
    while (true) {
      const page = await request(config, "/rest/api/2/search", {
        method: "POST",
        body: JSON.stringify({
          jql: buildJiraJql(config.projects),
          startAt,
          maxResults: 100,
          fields: JIRA_FIELDS,
        }),
      });
      const pageIssues = Array.isArray(page?.issues) ? page.issues : [];
      issues.push(...pageIssues);
      startAt += pageIssues.length;
      if (pageIssues.length === 0 || startAt >= Number(page?.total ?? 0)) break;
    }
    return issues;
  }

  async function fetchOriginId(config) {
    return jiraOriginId(await request(config, "/rest/applinks/1.0/manifest"));
  }

  async function fetchAccount(config) {
    return accountFromJira(await request(config, "/rest/api/2/myself"), config.username);
  }

  function assertAccountChangeAccepted(current, next, accepted) {
    if (!current?.accountId || current.accountId === next.accountId || accepted) return;
    throw new ApiError(
      409,
      "JIRA_ACCOUNT_CHANGED",
      `Jira 登录账号已从“${current.displayName}”变为“${next.displayName}”，请确认后继续同步`,
      {
        current: { accountId: current.accountId, displayName: current.displayName },
        next,
      },
    );
  }

  async function fetchIssue(config, issueKey) {
    const fields = encodeURIComponent(JIRA_FIELDS.join(","));
    return request(config, `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${fields}`);
  }

  async function collectSyncIssues(config, assignedIssues, { archiveMissing }) {
    const normalized = assignedIssues.map((issue, index) => normalizeIssue(issue, config, index));
    const assignedIds = new Set(normalized.map((issue) => issue.externalId));
    const missing = database.listActiveJiraTasks(config.originId)
      .filter((task) => !assignedIds.has(task.externalId));
    const unknownTasks = [];
    for (const task of missing) {
      try {
        const issue = await fetchIssue(config, task.externalKey);
        const scope = issueScopeState(issue, config);
        if (scope === "unknown") {
          unknownTasks.push({ id: task.id, message: `同步状态未知：无法确认 ${task.externalKey} 是否仍在同步范围内。` });
          continue;
        }
        normalized.push({
          ...normalizeIssue(issue, config, normalized.length),
          archived: archiveMissing && scope === "outside",
        });
        if (scope === "inside") {
          unknownTasks.push({ id: task.id, message: `同步状态未知：${task.externalKey} 仍符合范围但未出现在 Jira 搜索结果中。` });
        }
      } catch (error) {
        if (error?.code === "JIRA_AUTH_FAILED" || error?.code === "JIRA_PERMISSION_DENIED") throw error;
        unknownTasks.push({
          id: task.id,
          message: `同步状态未知：无法确认 ${task.externalKey} 的当前状态。${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
        });
      }
    }
    const knownKeys = new Set(normalized.map((issue) => issue.externalKey));
    const accessibleCanonicalKeys = new Set(knownKeys);
    const canonicalKeys = [...new Set(normalized.flatMap((issue) => (
      issue.duplicateOf?.externalKey && !knownKeys.has(issue.duplicateOf.externalKey)
        ? [issue.duplicateOf.externalKey]
        : []
    )))];
    for (const issueKey of canonicalKeys) {
      try {
        const issue = await fetchIssue(config, issueKey);
        const scope = issueScopeState(issue, config);
        accessibleCanonicalKeys.add(issueKey);
        normalized.push({
          ...normalizeIssue(issue, config, normalized.length),
          archived: archiveMissing && scope !== "inside",
        });
      } catch (error) {
        if (error?.code === "JIRA_AUTH_FAILED") throw error;
      }
    }
    for (const issue of normalized) {
      if (issue.duplicateOf) {
        issue.duplicateOf.accessible = accessibleCanonicalKeys.has(issue.duplicateOf.externalKey);
      }
    }
    return { issues: normalized, issueCount: assignedIssues.length, unknownTasks };
  }

  async function assertLiveOrigin(config) {
    if (await fetchOriginId(config) !== config.originId) {
      throw new ApiError(
        409,
        "JIRA_ORIGIN_MISMATCH",
        "当前 Jira 地址指向了另一个实例，请重新连接后再操作",
      );
    }
  }

  async function validateConnection(candidate) {
    const originId = await fetchOriginId(candidate);
    const account = await fetchAccount(candidate);
    const config = { ...candidate, originId, ...account };
    const issues = await fetchAssignedIssues(config);
    return { config, issues };
  }

  async function syncWithConfig(storedConfig, {
    acceptAccountChange = false,
    archiveMissing = true,
  } = {}) {
    const attemptedAt = new Date().toISOString();
    database.recordJiraSyncAttempt(attemptedAt);
    try {
      let config = storedConfig;
      let assignedIssues;
      let legacyIdentity = null;
      if (storedConfig.version === 1) {
        ({ config, issues: assignedIssues } = await validateConnection(storedConfig));
        legacyIdentity = {
          urlHash: legacyJiraOriginId(storedConfig.baseUrl),
          originId: config.originId,
        };
      } else {
        await assertLiveOrigin(config);
        const account = await fetchAccount(config);
        assertAccountChangeAccepted(config, account, acceptAccountChange);
        config = { ...config, ...account };
        assignedIssues = await fetchAssignedIssues(config);
      }
      const sync = await collectSyncIssues(config, assignedIssues, { archiveMissing });
      const succeededAt = new Date().toISOString();
      database.syncJiraTasks(sync.issues, {
        archiveMissing,
        originId: config.originId,
        projectName: `Jira · ${config.displayName}`,
        legacyIdentity,
        unknownTasks: sync.unknownTasks,
        syncedAt: succeededAt,
      });
      if (
        storedConfig.version !== 3
        || storedConfig.accountId !== config.accountId
        || storedConfig.displayName !== config.displayName
      ) config = await configStore.save(config);
      database.recordJiraSyncSuccess({
        attemptedAt,
        succeededAt,
        issueCount: sync.issueCount,
        unknownIssueCount: sync.unknownTasks.length,
      });
      return safeConfig(config, database.getJiraSyncState(), settings());
    } catch (error) {
      database.markJiraSyncError(
        error instanceof Error ? error.message : String(error),
        error?.code,
        attemptedAt,
      );
      throw error;
    }
  }

  async function sync({ force = false, acceptAccountChange = false } = {}) {
    const config = await configStore.read();
    const state = database.getJiraSyncState();
    if (!config) return safeConfig(null, state, settings());
    if (
      !force
      && state.lastSuccessfulAt
      && Date.now() - new Date(state.lastSuccessfulAt).getTime() < SYNC_INTERVAL_MS
    ) {
      return safeConfig(config, state, settings());
    }
    if (pendingSync) return pendingSync;
    pendingSync = syncWithConfig(config, { acceptAccountChange })
      .finally(() => {
        pendingSync = null;
      });
    return pendingSync;
  }

  async function resolveTransition(config, issueKey, targetStatus) {
    const payload = await request(
      config,
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    );
    const transitions = Array.isArray(payload?.transitions) ? payload.transitions : [];
    const matches = transitions.filter((candidate) => taskStatusFromJira(candidate.to) === targetStatus);
    const availableStatuses = transitions.map((candidate) => ({
      id: String(candidate.id),
      name: String(candidate.name ?? candidate.to?.name ?? ""),
      taskboardStatus: taskStatusFromJira(candidate.to),
    }));
    if (matches.length === 0) {
      throw new ApiError(
        409,
        "JIRA_TRANSITION_UNAVAILABLE",
        `Jira 当前工作流不能将 ${issueKey} 移到目标状态`,
        { availableStatuses },
      );
    }
    if (matches.length > 1) {
      throw new ApiError(
        409,
        "JIRA_TRANSITION_AMBIGUOUS",
        `Jira 有多个工作流操作可将 ${issueKey} 移到目标状态，请在 Jira 中选择`,
        {
          availableStatuses: availableStatuses.filter(
            (candidate) => candidate.taskboardStatus === targetStatus,
          ),
        },
      );
    }
    return matches[0];
  }

  async function applyTransition(config, issueKey, transition) {
    await request(config, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: String(transition.id) } }),
    });
  }

  async function applyTaskTransition(config, issueKey, targetStatus) {
    const issue = await request(
      config,
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=status`,
    );
    if (taskStatusFromJira(issue?.fields?.status) === targetStatus) return;
    const transition = await resolveTransition(config, issueKey, targetStatus);
    await applyTransition(config, issueKey, transition);
  }

  function liveIssueState(issue) {
    return {
      updatedAt: typeof issue?.fields?.updated === "string" ? issue.fields.updated : null,
      statusName: limitedString(issue?.fields?.status?.name, "Unknown", 128),
      taskStatus: taskStatusFromJira(issue?.fields?.status),
    };
  }

  async function resolveJiraPriority(config, targetPriority) {
    if (targetPriority === "none") return null;
    const priorities = await request(config, "/rest/api/2/priority");
    const match = Array.isArray(priorities)
      ? priorities.find((priority) => taskPriorityFromJira(priority) === targetPriority)
      : null;
    if (!match) {
      throw new ApiError(
        409,
        "JIRA_PRIORITY_UNAVAILABLE",
        "Jira 中没有可映射到该优先级的选项",
      );
    }
    return { id: String(match.id) };
  }

  return {
    async status() {
      return safeConfig(
        await configStore.read(),
        database.getJiraSyncState(),
        settings(),
      );
    },
    async configure(input) {
      const current = await configStore.read();
      const currentAuthMethod = current?.username ? "basic" : "bearer";
      const authMethod = input.authMethod ?? (current ? currentAuthMethod : "basic");
      const username = authMethod === "bearer" ? "" : (input.username || current?.username);
      if (authMethod === "basic" && !username?.trim()) {
        throw new ApiError(400, "JIRA_USERNAME_REQUIRED", "Basic Auth 必须填写 Jira 用户名或邮箱");
      }
      const password = input.password || current?.password;
      const candidate = configStore.validate({ ...input, username, password });
      if (current?.version === 1 && candidate.baseUrl !== current.baseUrl) {
        throw new ApiError(
          409,
          "JIRA_LEGACY_URL_CHANGE_UNAVAILABLE",
          "请先使用原 Jira 地址完成配置升级，再修改地址",
        );
      }
      if (
        !input.password
        && (
          !current
          || candidate.baseUrl !== current.baseUrl
          || candidate.username !== current.username
          || authMethod !== currentAuthMethod
        )
      ) {
        throw new ApiError(
          400,
          "JIRA_PASSWORD_REQUIRED",
          "修改 Jira 地址、用户名或认证方式时必须重新输入密码或 Token",
        );
      }
      const attemptedAt = new Date().toISOString();
      database.recordJiraSyncAttempt(attemptedAt);
      try {
        const originId = await fetchOriginId(candidate);
        const account = await fetchAccount(candidate);
        assertAccountChangeAccepted(current, account, input.acceptAccountChange === true);
        const config = { ...candidate, originId, ...account };
        const issues = await fetchAssignedIssues(config);
        const legacyIdentity = current?.version === 1
          ? { urlHash: legacyJiraOriginId(current.baseUrl), originId: config.originId }
          : null;
        const syncResult = await collectSyncIssues(config, issues, { archiveMissing: true });
        const succeededAt = new Date().toISOString();
        database.syncJiraTasks(syncResult.issues, {
          archiveMissing: true,
          originId: current?.originId === config.originId ? config.originId : null,
          projectName: `Jira · ${config.displayName}`,
          legacyIdentity,
          unknownTasks: syncResult.unknownTasks,
          syncedAt: succeededAt,
        });
        const savedConfig = await configStore.save(config);
        database.recordJiraSyncSuccess({
          attemptedAt,
          succeededAt,
          issueCount: syncResult.issueCount,
          unknownIssueCount: syncResult.unknownTasks.length,
        });
        return safeConfig(savedConfig, database.getJiraSyncState(), settings());
      } catch (error) {
        database.markJiraSyncError(
          error instanceof Error ? error.message : String(error),
          error?.code,
          attemptedAt,
        );
        throw error;
      }
    },
    sync,
    async reconcile() {
      const config = await configStore.read();
      if (!config || config.version === 1) {
        throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未完成稳定身份配置");
      }
      return syncWithConfig(config, { archiveMissing: false });
    },
    async updateTask(task, changes) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (task.externalOrigin !== config.originId || !task.externalKey) {
        throw new ApiError(
          409,
          "JIRA_ORIGIN_MISMATCH",
          "此任务不属于当前 Jira 连接，请重新同步后再操作",
        );
      }
      await assertLiveOrigin(config);
      const statusChanged = Object.hasOwn(changes, "status") && changes.status !== task.status;
      const priorityChanged = Object.hasOwn(changes, "priority") && changes.priority !== task.priority;
      const fields = {};
      if (Object.hasOwn(changes, "title") && changes.title !== task.title) fields.summary = changes.title;
      if (Object.hasOwn(changes, "description") && changes.description !== task.description) {
        fields.description = changes.description;
      }
      if (Object.hasOwn(changes, "labels") && JSON.stringify(changes.labels) !== JSON.stringify(task.labels)) {
        fields.labels = changes.labels;
      }
      if (Object.hasOwn(changes, "dueDate") && changes.dueDate !== task.dueDate) {
        fields.duedate = changes.dueDate;
      }
      const fieldsChanged = Object.keys(fields).length > 0 || priorityChanged;
      if (statusChanged && fieldsChanged) {
        throw new ApiError(
          409,
          "JIRA_MULTI_STEP_UPDATE_UNAVAILABLE",
          "请分开修改 Jira 状态和其他字段",
        );
      }
      if (priorityChanged) {
        fields.priority = await resolveJiraPriority(config, changes.priority);
      }
      if (statusChanged) {
        await applyTaskTransition(config, task.externalKey, changes.status);
        return true;
      }
      if (fieldsChanged) {
        await request(config, `/rest/api/2/issue/${encodeURIComponent(task.externalKey)}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
        return true;
      }
      return false;
    },
    async moveTask(task, status) {
      if (status === task.status) return;
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (task.externalOrigin !== config.originId || !task.externalKey) {
        throw new ApiError(
          409,
          "JIRA_ORIGIN_MISMATCH",
          "此任务不属于当前 Jira 连接，请重新同步后再操作",
        );
      }
      await assertLiveOrigin(config);
      await applyTaskTransition(config, task.externalKey, status);
    },
    async completeTask(task, expectedUpdatedAt) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (task.externalOrigin !== config.originId || !task.externalKey) {
        throw new ApiError(
          409,
          "JIRA_ORIGIN_MISMATCH",
          "此任务不属于当前 Jira 连接，请重新同步后再操作",
        );
      }
      await assertLiveOrigin(config);
      let remote = liveIssueState(await fetchIssue(config, task.externalKey));
      if (remote.taskStatus === "done") return remote;
      if (expectedUpdatedAt && remote.updatedAt !== expectedUpdatedAt) {
        throw new ApiError(
          409,
          "JIRA_AUTO_COMPLETE_CONFLICT",
          `${task.externalKey} 在 Panel 上次同步后已被修改，请确认远端状态后重试`,
          { remote },
        );
      }
      const transition = await resolveTransition(config, task.externalKey, "done");
      if (!database.isJiraAutoCompletionEligible(task.id)) {
        throw new ApiError(
          409,
          "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE",
          "关联 Issue 已变化，Jira 不再满足自动完成条件",
        );
      }
      await applyTransition(config, task.externalKey, transition);
      remote = liveIssueState(await fetchIssue(config, task.externalKey));
      if (remote.taskStatus !== "done") {
        throw new ApiError(
          502,
          "JIRA_TRANSITION_NOT_CONFIRMED",
          `Jira 未确认 ${task.externalKey} 已进入完成状态`,
          { remote },
        );
      }
      return remote;
    },
  };
}
