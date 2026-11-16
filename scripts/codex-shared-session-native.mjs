// 只读已连接的原生服务；不能向同一个 app-server 再次发送 initialize。
export async function readSharedSessionInitialization(load) {
  if (!load?.m) throw Error("Codex 原生服务尚未就绪");
  const markers = ["setAppHost", "setAppServices", "appServices:"];
  const matches = Object.entries(load.m).filter(([, factory]) => markers.every(marker => String(factory).includes(marker)));
  const services = matches.length === 1 ? load(matches[0][0]).appServices : null;
  if (!services?.executionPaths || !services?.appInfo) throw Error("无法读取 Codex 原生连接信息");
  const version = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      error ? reject(error) : resolve(value);
    };
    const receive = event => {
      const message = event.data;
      // Electron 原生桥事件的 source 为 null，不能用浏览器 postMessage 的同窗条件过滤。
      if (message?.type === "codex-app-server-initialized" && message.hostId === "local") {
        finish(null, message.appServerVersion);
      }
    };
    const timer = setTimeout(() => finish(Error("读取 Codex 版本超时")), 5_000);
    window.addEventListener("message", receive);
    Promise.resolve(window.electronBridge.sendMessageFromView({ type: "request-app-server-state" })).catch(finish);
  });
  const [appServerVersion, paths, system] = await Promise.all([
    version, services.executionPaths.readHomePaths("local"), services.appInfo.getSystemInfo(),
  ]);
  if (typeof appServerVersion !== "string" || typeof paths?.codexHome !== "string") throw Error("Codex 原生连接信息不完整");
  const windows = system.platform === "win32" && !system.isCodexRunningInsideWsl;
  return {
    userAgent: `codex/${appServerVersion}`,
    codexHome: paths.codexHome,
    platformFamily: windows ? "windows" : "unix",
    platformOs: windows ? "windows" : system.platform === "darwin" ? "macos" : "linux",
  };
}

export async function retainSharedConversation(load, threadId, retain) {
  const leases = globalThis.__codexPanelSharedConversationLeases__ ??= new Map();
  if (!retain) {
    const entry = leases.get(threadId);
    if (!entry) return;
    leases.delete(threadId);
    entry.pending[Symbol.dispose]?.();
    entry.lease?.[Symbol.dispose]?.();
    entry.manager[Symbol.dispose]?.();
    return;
  }
  if (leases.has(threadId)) return;
  const markers = ["setAppHost", "setAppServices", "appServices:"];
  const matches = Object.entries(load.m).filter(([, factory]) => markers.every(marker => String(factory).includes(marker)));
  const services = matches.length === 1 ? load(matches[0][0]).appServices : null;
  const opened = await services?.appServerManagers?.open("local");
  if (opened?.status !== "ready") throw Error("Codex 会话服务尚未就绪");
  // 原生会话租约只防止空闲回收，不阻止用户主动归档、删除或停止会话。
  const entry = { manager: opened.manager, pending: opened.manager.retainActiveConversation(threadId), lease: null };
  leases.set(threadId, entry);
  try {
    entry.lease = await entry.pending;
    if (leases.get(threadId) !== entry) {
      entry.lease?.[Symbol.dispose]?.();
      return;
    }
    // 先由原生管理器恢复历史和流归属，确保 CLI 的事件与审批也能进入 App。
    const resumed = await entry.manager.resumeConversation({
      conversationId: threadId,
      intent: "view",
      model: null,
      reasoningEffort: null,
      workspaceRoots: [],
      useAppServerPermissionDefault: true,
      collaborationMode: null,
      showThreadGoalResumeConfirmation: false,
    });
    if (resumed?.status !== "ready") throw Error("Codex 尚未准备好共享此会话");
  } catch (error) {
    if (leases.get(threadId) === entry) leases.delete(threadId);
    entry.pending[Symbol.dispose]?.();
    entry.lease?.[Symbol.dispose]?.();
    entry.manager[Symbol.dispose]?.();
    throw error;
  }
}
