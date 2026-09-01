const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";
const HOST_REQUEST_MAX_LENGTH = 4_194_304;

function parseHostRequest(payload, parseAutomationRequest) {
  if (typeof payload !== "string" || payload.length > HOST_REQUEST_MAX_LENGTH) {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  const id = (
    request
    && typeof request.id === "string"
    && /^[a-z0-9-]{1,80}$/i.test(request.id)
  ) ? request.id : null;
  if (!id) return { id: null, request: null, error: HOST_REQUEST_ERROR };
  if (request.action === "ensure") return { id, request, error: null };
  if (request.action === "read-current-user") return { id, request, error: null };
  if (
    request.action === "load-frame"
    && typeof request.frameName === "string"
    && /^codex-(?:panel|taskboard)-[a-f0-9-]{36,80}$/i.test(request.frameName)
    && typeof request.frameCapability === "string"
    && /^[a-f0-9-]{36,80}$/i.test(request.frameCapability)
  ) return { id, request, error: null };
  if (request.action === "open-external" && typeof request.url === "string") {
    try {
      const url = new URL(request.url);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.href.length <= 2_048) {
        return { id, request: { ...request, url: url.href }, error: null };
      }
    } catch {}
  }
  if (
    request.action === "open-attachment"
    && typeof request.attachmentId === "string"
    && /^[a-f0-9-]{36}$/i.test(request.attachmentId)
    && typeof request.filename === "string"
    && request.filename.length > 0
    && request.filename.length <= 240
    && request.filename !== "."
    && request.filename !== ".."
    && !/[\u0000-\u001f\u007f/\\]/.test(request.filename)
  ) return { id, request, error: null };
  if (request.action === "automation") {
    const parsed = parseAutomationRequest(request);
    return parsed
      ? { id, request: parsed, error: null }
      : {
          id,
          request: null,
          error: HOST_REQUEST_ERROR,
          diagnosticCode: AUTOMATION_SCHEMA_DIAGNOSTIC,
        };
  }
  if (request.action === "next-native-claim") {
    return { id, request, error: null };
  }
  if (
    request.action === "bind-native-claim"
    && typeof request.reservationId === "string"
    && /^[a-f0-9-]{36}$/i.test(request.reservationId)
    && typeof request.taskId === "string"
    && request.taskId.length > 0
    && request.taskId.length <= 128
    && request.threadBinding
    && typeof request.threadBinding === "object"
    && !Array.isArray(request.threadBinding)
    && typeof request.threadBinding.threadId === "string"
    && request.threadBinding.threadId.length > 0
    && request.threadBinding.threadId.length <= 240
    && typeof request.threadBinding.codexProjectId === "string"
    && request.threadBinding.codexProjectId.length > 0
    && request.threadBinding.codexProjectId.length <= 240
    && request.threadBinding.codexProjectKind === "local"
    && request.threadBinding.codexHostId === "local"
    && typeof request.threadBinding.workspacePath === "string"
    && request.threadBinding.workspacePath.length > 0
    && request.threadBinding.workspacePath.length <= 4_096
    && (
      request.developmentContext === undefined
      ||
      request.developmentContext === null
      || (
        request.developmentContext
        && typeof request.developmentContext === "object"
        && !Array.isArray(request.developmentContext)
        && (
          (
            request.developmentContext.type === "worktree"
            && typeof request.developmentContext.path === "string"
            && request.developmentContext.path.length > 0
            && request.developmentContext.path.length <= 4_096
            && (
              request.developmentContext.branch === null
              || (
                typeof request.developmentContext.branch === "string"
                && request.developmentContext.branch.length <= 512
              )
            )
          )
          || (
            request.developmentContext.type === "branch"
            && typeof request.developmentContext.branch === "string"
            && request.developmentContext.branch.length > 0
            && request.developmentContext.branch.length <= 512
          )
        )
      )
    )
  ) return { id, request, error: null };
  if (
    request.action === "fail-native-claim"
    && typeof request.reservationId === "string"
    && /^[a-f0-9-]{36}$/i.test(request.reservationId)
    && typeof request.taskId === "string"
    && request.taskId.length > 0
    && request.taskId.length <= 128
    && typeof request.error === "string"
    && request.error.length > 0
    && request.error.length <= 4_096
  ) return { id, request, error: null };
  if (
    request.action === "prefill-task-composer"
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 16_384
    && typeof request.skillName === "string"
    && /^[a-z0-9-]{1,100}$/i.test(request.skillName)
    && typeof request.skillDisplayName === "string"
    && request.skillDisplayName.length > 0
    && request.skillDisplayName.length <= 1_024
    && typeof request.skillPath === "string"
    && request.skillPath.length > 0
    && request.skillPath.length <= 1_024
    && (
      request.skills === undefined
      || (
        Array.isArray(request.skills)
        && request.skills.length > 0
        && request.skills.length <= 8
        && request.skills.every((skill) => (
          skill
          && typeof skill === "object"
          && !Array.isArray(skill)
          && typeof skill.name === "string"
          && /^[a-z0-9-]{1,100}$/i.test(skill.name)
          && typeof skill.displayName === "string"
          && skill.displayName.length > 0
          && skill.displayName.length <= 1_024
          && typeof skill.path === "string"
          && skill.path.length > 0
          && skill.path.length <= 1_024
        ))
      )
    )
  ) {
    return { id, request, error: null };
  }
  if (
    request.action === "confirm-task-conversation"
    && typeof request.threadId === "string"
    && request.threadId.length > 0
    && request.threadId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.threadId)
    && typeof request.codexHostId === "string"
    && request.codexHostId.length > 0
    && request.codexHostId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.codexHostId)
    && typeof request.targetRoot === "string"
    && request.targetRoot.length <= 4_096
    && typeof request.identifier === "string"
    && request.identifier.length > 0
    && request.identifier.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.identifier)
  ) {
    return { id, request, error: null };
  }
  if (
    request.action === "start-task-conversation"
    && typeof request.taskId === "string"
    && request.taskId.length > 0
    && request.taskId.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(request.taskId)
    && typeof request.previousThreadId === "string"
    && request.previousThreadId.length <= 240
    && typeof request.codexHostId === "string"
    && request.codexHostId.length > 0
    && request.codexHostId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.codexHostId)
    && typeof request.projectless === "boolean"
    && (
      request.projectless
      || (
        typeof request.targetRoot === "string"
        && request.targetRoot.length > 0
        && request.targetRoot.length <= 4_096
      )
    )
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 4_000_000
    && typeof request.title === "string"
    && request.title.length > 0
    && request.title.length <= 240
    && (
      request.codexProjectId === undefined
      || (
        typeof request.codexProjectId === "string"
        && request.codexProjectId.length > 0
        && request.codexProjectId.length <= 240
      )
    )
    && (request.useWorktree === undefined || typeof request.useWorktree === "boolean")
  ) {
    return { id, request, error: null };
  }
  return { id, request: null, error: HOST_REQUEST_ERROR };
}

export async function handleHostBindingPayload(params, handlers) {
  if (
    typeof handlers.isAuthorizedContext === "function"
    && !handlers.isAuthorizedContext(params.executionContextId)
  ) {
    return { responded: false, accepted: false };
  }

  const parsed = parseHostRequest(params.payload, handlers.parseAutomationRequest);
  if (!parsed.request) {
    if (!parsed.id) return { responded: false, accepted: false };
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.id,
      ok: false,
      error: parsed.error,
      ...(parsed.diagnosticCode ? { diagnosticCode: parsed.diagnosticCode } : {}),
    });
    return { responded: true, accepted: false };
  }

  try {
    let result;
    if (parsed.request.action === "ensure") {
      result = await handlers.ensure();
    } else if (parsed.request.action === "read-current-user") {
      result = await handlers.readCurrentUser();
    } else if (parsed.request.action === "load-frame") {
      result = await handlers.loadFrame(parsed.request);
    } else if (parsed.request.action === "open-external") {
      result = await handlers.openExternal(parsed.request);
    } else if (parsed.request.action === "open-attachment") {
      result = await handlers.openAttachment(parsed.request);
    } else if (parsed.request.action === "automation") {
      result = await handlers.runAutomation(parsed.request, params.executionContextId);
    } else if (parsed.request.action === "next-native-claim") {
      result = await handlers.claimNext();
    } else if (parsed.request.action === "bind-native-claim") {
      result = await handlers.bindClaim(parsed.request);
    } else if (parsed.request.action === "fail-native-claim") {
      result = await handlers.failClaim(parsed.request);
    } else if (parsed.request.action === "start-task-conversation") {
      result = await handlers.startConversation(parsed.request, params.executionContextId);
    } else if (parsed.request.action === "confirm-task-conversation") {
      result = await handlers.confirmConversation(parsed.request, params.executionContextId);
    } else {
      result = await handlers.prefill(parsed.request, params.executionContextId);
    }
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: true,
      ...result,
    });
  } catch (error) {
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: false,
      error: error.message,
      ...(typeof error?.threadId === "string" ? { threadId: error.threadId } : {}),
      ...(error?.uncertain === true ? { uncertain: true } : {}),
    });
  }
  return { responded: true, accepted: true };
}

export async function interruptNativeCodexThread(binding, request) {
  const result = await request("thread/read", {
    threadId: binding.threadId,
    includeTurns: true,
  });
  const turn = Array.isArray(result?.thread?.turns)
    ? result.thread.turns.findLast((candidate) => candidate?.status === "inProgress")
    : null;
  if (!turn?.id) return { interrupted: false };
  await request("turn/interrupt", { threadId: binding.threadId, turnId: turn.id });
  return { interrupted: true, turnId: turn.id };
}

export async function reconcileInjectionRuntime({
  currentStatus,
  source,
  sourceHash,
  shouldOpen = false,
  removeRegisteredSource,
  registerCurrentSource,
  reloadRenderer,
  evaluateCurrentSource,
  publishRegistration,
  reopen,
}) {
  if (currentStatus.scriptIdentifier) {
    try {
      await removeRegisteredSource(currentStatus.scriptIdentifier);
    } catch {}
  }
  const scriptIdentifier = await registerCurrentSource(source);
  await reloadRenderer();
  await evaluateCurrentSource(source);
  await publishRegistration(scriptIdentifier);
  const replaced = currentStatus.sourceHash !== sourceHash;
  const shouldRemainOpen = shouldOpen || currentStatus.pageVisible === true;
  if (shouldRemainOpen) await reopen();
  return { replaced, scriptIdentifier, shouldRemainOpen };
}

export function findResidentInjectorPids({
  processList,
  currentPid,
  injectorPath,
  port,
  defaultPort,
}) {
  const residents = [];

  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === currentPid || !residentInjectorCommandMatches(command, injectorPath)) continue;
    if (commandPort(command, defaultPort) !== port) continue;
    residents.push(pid);
  }
  return residents;
}

export function residentInjectorCommandMatches(
  command,
  injectorPath,
  port = null,
  defaultPort = 9229,
) {
  const escapedPath = escapeRegExp(injectorPath);
  const absoluteScript = new RegExp(`(?:^|\\s)(?:${escapedPath}|"${escapedPath}")(?=\\s|$)`);
  return absoluteScript.test(command)
    && /(?:^|\s)--watch(?=\s|$)/.test(command)
    && (port === null || commandPort(command, defaultPort) === port);
}

export function managedInjectorCommandMatches(command, {
  nodePath,
  injectorPath,
  startupToken = null,
  port = null,
  defaultPort = 9229,
} = {}) {
  if (typeof command !== "string" || !nodePath || !injectorPath) return false;
  const absoluteNode = new RegExp(`^(?:${escapeRegExp(nodePath)}|"${escapeRegExp(nodePath)}")(?=\\s|$)`);
  return absoluteNode.test(command)
    && residentInjectorCommandMatches(command, injectorPath, port, defaultPort)
    && (
      startupToken === null
      || commandArgumentMatches(command, "--startup-token", startupToken)
    );
}

export function injectionReadinessMatches(status, {
  expectedSourceHash,
  expectedStartupToken,
  now = Date.now(),
  maxHeartbeatAgeMs = 5_000,
} = {}) {
  const heartbeatAge = now - Number(status?.heartbeatAt);
  return status?.sourceHash === expectedSourceHash
    && status?.startupToken === expectedStartupToken
    && status?.entryMounted === true
    && Number.isFinite(heartbeatAge)
    && heartbeatAge >= 0
    && heartbeatAge <= maxHeartbeatAgeMs;
}

export async function restartResidentInjector(port, handlers) {
  const previousPids = handlers.findResidents(port);
  if (previousPids.length === 0) return { previousPids: [], pid: null, restarted: false };

  for (const pid of previousPids) await handlers.stopResident(pid);
  const startupToken = handlers.createStartupToken();
  const started = handlers.startResident(port, startupToken);
  await handlers.waitUntilReady(port, started.pid, startupToken);
  return {
    previousPids,
    pid: started.pid,
    restarted: true,
  };
}

export async function stopResidentInjectors(pids, stopResident) {
  const stoppedPids = [];
  for (const pid of [...new Set(pids)]) {
    await stopResident(pid);
    stoppedPids.push(pid);
  }
  return stoppedPids;
}

export function sameFrameDocumentUrl(candidate, expected) {
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    return candidateUrl.origin === expectedUrl.origin
      && candidateUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function commandPort(command, defaultPort) {
  const match = command.match(/(?:^|\s)--port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
  return match ? Number(match[1] ?? match[2]) : defaultPort;
}

function commandArgumentMatches(command, option, value) {
  const escapedOption = escapeRegExp(option);
  const escapedValue = escapeRegExp(value);
  return new RegExp(
    `(?:^|\\s)${escapedOption}(?:=${escapedValue}|\\s+${escapedValue})(?=\\s|$)`,
  ).test(command);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
