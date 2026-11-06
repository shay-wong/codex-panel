const updateModules = new WeakMap();

// Rspack exposes its existing module registry from the already loaded main entry.
export async function findCodexRspackRequire() {
  const existing = globalThis.__codexPanelRspack__?.require ?? globalThis.__codexPanelUpdateRequire__;
  if (existing?.m) return existing;
  const scripts = [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src);
  for (const url of scripts) {
    if (!/\/\d+\.[\w-]+\.js$/.test(new URL(url, location.href).pathname)) continue;
    const response = await fetch(url);
    if (!response.ok) continue;
    const source = await response.text();
    if (!/export\s*\{[^}]*\b__webpack_require__\b/.test(source)) continue;
    const load = (await import(url)).__webpack_require__;
    if (typeof load !== "function" || !load.m) throw Error("Codex 原生模块注册表不可用");
    globalThis.__codexPanelUpdateRequire__ = load;
    return load;
  }
  return null;
}

function rspackUpdateModule(load, markers) {
  const runtime = globalThis.__codexPanelRspack__;
  if (runtime?.require === load && runtime.findModule) return runtime.findModule(markers);
  const matches = Object.entries(load.m).filter(([, factory]) => markers.every(marker => factory.toString().includes(marker)));
  return matches.length === 1 ? { id: matches[0][0], source: matches[0][1].toString() } : null;
}

function rspackUpdateSubscription(load) {
  const cached = globalThis.__codexPanelUpdateSubscription__;
  if (cached?.load === load) return cached.subscribe;
  const module = rspackUpdateModule(load, ["getRestartBlockers", "stateChanged(", "new Set"]);
  if (!module) throw Error("无法识别 Codex 原生更新状态模块");
  const subscriptions = Object.values(load(module.id)).filter(value => typeof value === "function"
    && /\.add\(([\w$]+)\).*\.delete\(\1\)/.test(value.toString().replace(/\s+/g, "")));
  if (subscriptions.length !== 1) throw Error("无法识别 Codex 原生更新状态订阅");
  const subscribe = subscriptions[0];
  globalThis.__codexPanelUpdateSubscription__ = { load, subscribe };
  return subscribe;
}

function rspackAppUpdates(load) {
  const module = rspackUpdateModule(load, ["setAppHost", "setAppServices", "appServices:"]);
  const updates = module && load(module.id).appServices?.appUpdates;
  if (!updates) throw Error("Codex 更新检查接口尚未就绪");
  return updates;
}

// Resolve the cached native update subscription without starting a check or download.
export function updateSubscriptionExport(source) {
  const match = source.match(/function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.add\(\2\),([\w$]+)!=null&&\2\(\4\),\(\)=>\{\3\.delete\(\2\)\}\}/);
  if (!match || !source.includes(`stateChanged(`)) throw new Error("无法识别 Codex 原生更新状态接口");
  const exported = source.slice(source.lastIndexOf("export{")).match(
    new RegExp(`(?:,|\\{)${match[1].replace(/\$/g, "\\$")} as ([\\w$]+)(?=,|\\})`),
  );
  if (!exported) throw new Error("Codex 原生更新状态接口未导出");
  return exported[1];
}

export async function readCodexUpdateState(cdp) {
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const load = await (${findCodexRspackRequire})();
      if (load) {
        const rspackUpdateModule = ${rspackUpdateModule};
        let state;
        const unsubscribe = (${rspackUpdateSubscription})(load)(value => { state = value; });
        unsubscribe();
        if (!state) throw Error("Codex 尚未提供更新状态，请稍后重试");
        return { isUpdateReady: state.isUpdateReady, lifecycleState: state.lifecycleState,
          downloadProgressPercent: state.downloadProgressPercent, downloadedUpdateAppBrand: state.downloadedUpdateAppBrand };
      }
      let { url, name } = ${JSON.stringify(updateModules.get(cdp) ?? {})};
      if (!url) {
        const urls = [...performance.getEntriesByType("resource").map(entry => entry.name),
          ...document.querySelectorAll('script[src],link[rel="modulepreload"][href]')].map(entry => typeof entry === "string" ? entry : entry.src || entry.href);
        const find = () => urls.find(url => /initialize-app-host-services-[\\w-]+\\.js$/.test(new URL(url, location.href).pathname));
        const queue = [...document.querySelectorAll('script[type="module"][src]')].map(entry => entry.src);
        const visited = new Set();
        // Codex clears resource timings; its current entry imports still identify the update module.
        for (const entry of queue) {
          if (find()) break;
          if (visited.has(entry)) continue;
          visited.add(entry);
          const response = await fetch(entry);
          if (!response.ok) throw Error("无法读取 Codex 更新状态入口");
          const source = await response.text();
          for (const match of source.matchAll(/["'\\x60](\\.\\/((?:app-(?:main|runtime|initial)|initialize-app-host-services)-[\\w-]+\\.js))["'\\x60]/g)) {
            const dependency = new URL(match[1], entry).href;
            urls.push(dependency);
            queue.push(dependency);
          }
        }
        url = find();
        if (!url) throw Error("当前 Codex 页面未提供更新状态入口，请打开主窗口后重试");
        const response = await fetch(url);
        if (!response.ok) throw Error("无法读取 Codex 更新状态模块");
        name = (${updateSubscriptionExport})(await response.text());
      }
      const module = await import(url);
      let state;
      const unsubscribe = module[name](value => { state = value; });
      unsubscribe();
      if (!state) throw Error("Codex 尚未提供更新状态，请稍后重试");
      return { isUpdateReady: state.isUpdateReady, lifecycleState: state.lifecycleState,
        downloadProgressPercent: state.downloadProgressPercent,
        downloadedUpdateAppBrand: state.downloadedUpdateAppBrand, module: { url, name } };
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? "无法读取 Codex 更新状态");
  const state = response.result?.value;
  if (state?.module) updateModules.set(cdp, state.module);
  // “ready” also means an offer exists; a downloaded brand confirms the payload arrived.
  return { ready: state?.isUpdateReady === true && state.lifecycleState === "ready"
    && ["chatgpt", "codex"].includes(state.downloadedUpdateAppBrand),
    downloading: state?.lifecycleState === "downloading",
    progress: Number.isFinite(state?.downloadProgressPercent) ? state.downloadProgressPercent : null };
}

const updateChecks = new WeakMap();

export async function downloadCodexUpdate(cdp, download, { getPlanType } = {}) {
  const current = download.status();
  if (current?.ready || current?.downloading) return current;
  const result = updateChecks.get(cdp)?.result;
  if (result?.status !== "available") return readCodexUpdateStatus(cdp, { force: true, download });
  download.start({ ...result, getPlanType });
  return download.status();
}

export async function readCodexUpdateStatus(cdp, { force = false, download } = {}) {
  if (force) download?.clearFailure();
  const direct = download?.status();
  if (direct) return direct;
  const state = await readCodexUpdateState(cdp);
  let check = updateChecks.get(cdp);
  if (check && !check.result && Date.now() - check.startedAt >= 35_000) {
    check.result = { status: "timeout" };
  }
  if (!check || (force && check.result) || Date.now() - check.startedAt >= 15 * 60_000) {
    check = { startedAt: Date.now(), result: null };
    updateChecks.set(cdp, check);
    // The native quiet check can take 30 seconds; keep connection heartbeats responsive.
    void cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const load = await (${findCodexRspackRequire})();
        if (load) {
          const rspackUpdateModule = ${rspackUpdateModule};
          return await (${rspackAppUpdates})(load).checkForUpdateInformation();
        }
        const url = [...document.querySelectorAll('script[src],link[rel="modulepreload"][href]')]
          .map(entry => entry.src || entry.href).find(url => /app-shared-[\\w-]+\\.js$/.test(new URL(url, location.href).pathname));
        if (!url) throw Error("Codex 更新检查接口尚未就绪");
        const module = await import(url);
        const host = Object.values(module).find(value => value && Object.hasOwn(value, "appUpdates"));
        if (!host) throw Error("Codex 更新检查接口不可用");
        return await host.appUpdates.checkForUpdateInformation();
      })()`,
      awaitPromise: true, returnByValue: true,
    }).then(response => {
      check.result ??= response.exceptionDetails ? { status: "error" } : response.result?.value ?? { status: "error" };
    }).catch(() => { check.result ??= { status: "error" }; });
  }
  const result = check.result;
  const version = typeof result?.installedVersion === "string" ? ` · ${result.installedVersion}` : "";
  let message;
  if (state.ready) message = `更新已下载，可安装并重新连接${version}`;
  else if (state.downloading) message = `正在下载更新${state.progress == null ? "…" : ` · ${Math.round(state.progress)}%`}`;
  else if (!result) message = `正在检查更新…${version}`;
  else if (result.status === "busy") message = `Codex 更新器正忙，请稍后重试${version}`;
  else if (result.status === "timeout") message = "检查更新超时，请重试";
  else if (result.status === "up_to_date") message = `当前已是最新版${version}`;
  else if (result.status === "available") message = result.availableVersion ? `发现新版本 ${result.availableVersion}${version}` : `发现新版本，尚未下载完成${version}`;
  else if (result.status === "restart_required") message = `更新需要重启后生效${version}`;
  else message = `暂时无法检查更新${version}`;
  return { ready: state.ready, available: result?.status === "available", downloading: state.downloading,
    message, checking: !result && !state.ready && !state.downloading };
}
