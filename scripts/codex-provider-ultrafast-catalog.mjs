import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import { codexExecutableInApp } from "../shared/codex-executable.mjs";
import { executableCommand } from "../shared/executable-command.mjs";
import { withoutPanelLauncherEnvironment } from "../shared/codex-environment.mjs";

async function readUserConfigLayer(client) {
  const { layers } = await client.request("config/read", { includeLayers: true });
  const userLayer = layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
  if (!userLayer?.name.file || !userLayer.version) throw new Error("无法定位 Codex 用户配置");
  return userLayer;
}

export async function readModelDiscovery(client) {
  const userLayer = await readUserConfigLayer(client);
  const value = userLayer.config?.features?.api_key_model_discovery;
  if (value !== undefined && typeof value !== "boolean") throw new Error("Codex 模型发现配置不是布尔值");
  return value ?? null;
}

export async function setModelDiscovery(client, enabled) {
  const userLayer = await readUserConfigLayer(client);
  const current = userLayer.config?.features?.api_key_model_discovery;
  if (enabled ? current === true : current === undefined) return;
  const result = await client.request("config/batchWrite", {
    edits: [{ keyPath: "features.api_key_model_discovery", value: enabled ? true : null, mergeStrategy: "replace" }],
    filePath: userLayer.name.file, expectedVersion: userLayer.version, reloadUserConfig: true,
  });
  if (result.status !== "ok") throw new Error("配置受更高优先级设置覆盖，请检查 Codex 配置");
}

export function withUltrafastCatalog(catalog) {
  if (!Array.isArray(catalog?.models)) throw new Error("Invalid Codex model catalog");
  return { ...catalog, models: catalog.models.map(model => {
    if (!["gpt-6-astra", "gpt-6.1-sol"].includes(model.slug)
      || model.service_tiers?.some(tier => tier.id === "ultrafast")) return model;
    return { ...model, service_tiers: [...(model.service_tiers ?? []),
      { id: "ultrafast", name: "Ultrafast", description: "" }] };
  }) };
}

async function modelContextState({ executable, dataDirectory, processEnv, cwd }, client) {
  const { config, layers, origins } = await client.request("config/read", { includeLayers: true });
  const userLayer = layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
  if (!userLayer?.name.file || !userLayer.version) throw new Error("无法定位 Codex 用户配置");
  const statePath = path.join(dataDirectory, "model-context.json");
  const catalogPath = path.join(dataDirectory, "model-context-catalog.json");
  let state = await readJson(statePath, null);
  if (!state || config.model_catalog_json !== catalogPath) {
    const args = ["debug", "models"];
    const provider = config.model_provider ?? "openai";
    const ultrafast = (await readJson(path.join(dataDirectory, "ultrafast-catalog.json"), null))?.providers?.[provider];
    if (!config.model_catalog_json && ultrafast && ultrafast.url === config.model_providers?.[provider]?.model_catalog_url) {
      // Keep the source catalog independent of the Ultrafast preference.
      if (ultrafast.originalUrl) args.push("-c", `model_providers.${JSON.stringify(provider)}.model_catalog_url=${JSON.stringify(ultrafast.originalUrl)}`);
      else args.push("--bundled");
    }
    const command = executableCommand(executable, args);
    const { stdout } = await promisify(execFile)(command.executable, command.args, {
      cwd, env: withoutPanelLauncherEnvironment(processEnv),
      timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    state = {
      catalog: JSON.parse(stdout), contextWindows: {},
      originalCatalog: userLayer.config?.model_catalog_json ?? null,
    };
  }
  if (!Array.isArray(state.catalog?.models)) throw new Error("Codex 模型目录格式无效");
  return { config, userLayer, origins, state, statePath, catalogPath };
}

export async function modelContextSettings({
  executable, dataDirectory, processEnv = process.env, cwd,
}, contextWindows) {
  await mkdir(dataDirectory, { recursive: true });
  dataDirectory = realpathSync(dataDirectory);
  const client = new CodexAppServer({ executable, processEnv, cwd });
  try {
    const { config, userLayer, origins, state, statePath, catalogPath } = await modelContextState(
      { executable, dataDirectory, processEnv, cwd }, client,
    );
    if (contextWindows !== undefined) {
      if (!contextWindows || typeof contextWindows !== "object" || Array.isArray(contextWindows)) {
        throw new Error("上下文设置必须是模型 ID 与 token 数的对应表");
      }
      const slugs = new Set(state.catalog.models.map(model => model.slug));
      for (const [model, size] of Object.entries(contextWindows)) {
        if (!slugs.has(model)) throw new Error(`模型目录中没有 ${model}`);
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${model} 的 token 数必须为正整数`);
      }
      const hasOverrides = Object.keys(contextWindows).length > 0;
      if (hasOverrides && config.model_context_window != null) {
        throw new Error("请先移除 Codex 的全局 model_context_window，否则会覆盖每个模型的上下文设置");
      }
      const origin = origins?.model_catalog_json?.name;
      if (origin && !(origin.type === "system"
        || origin.type === "user" && !origin.profile && origin.file === userLayer.name.file)) {
        throw new Error("模型目录由更高优先级配置管理，无法保存上下文设置");
      }
      state.contextWindows = contextWindows;
      if (hasOverrides) {
        const catalog = { ...state.catalog, models: state.catalog.models.map(model => (
          Object.hasOwn(contextWindows, model.slug)
            ? { ...model, context_window: contextWindows[model.slug] } : model
        )) };
        await writeFile(statePath + ".tmp", JSON.stringify(state), { mode: 0o600 });
        await rename(statePath + ".tmp", statePath);
        await writeFile(catalogPath + ".tmp", JSON.stringify(catalog), { mode: 0o600 });
        await rename(catalogPath + ".tmp", catalogPath);
      }
      const value = hasOverrides ? catalogPath : state.originalCatalog;
      if ((config.model_catalog_json ?? null) !== value) {
        const result = await client.request("config/batchWrite", {
          edits: [{ keyPath: "model_catalog_json", value, mergeStrategy: "replace" }],
          filePath: userLayer.name.file, expectedVersion: userLayer.version, reloadUserConfig: true,
        });
        if (result.status !== "ok") throw new Error("上下文配置被更高优先级设置覆盖");
      }
    }
    return {
      models: state.catalog.models.map(model => ({
        slug: model.slug, displayName: model.display_name ?? model.slug,
        contextWindow: model.context_window ?? null,
      })),
      contextWindows: state.contextWindows,
    };
  } finally { await client.close(); }
}

// Read the public ModelInfo catalog compiled into this exact CLI, including its
// instructions and capabilities. Do not replace it with a reduced model/list result.
export async function readBundledModelCatalog(executable) {
  const bytes = await readFile(executable);
  let cursor = 0;
  while ((cursor = bytes.indexOf('"models"', cursor)) !== -1) {
    const start = bytes.lastIndexOf("{", cursor);
    cursor += 8;
    if (start < 0 || cursor - start > 32
      || !/^\{\s*"models"\s*:\s*\[/.test(bytes.subarray(start, cursor + 16).toString())) continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < bytes.length; end++) {
      const char = bytes[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === 92) escaped = true;
        else if (char === 34) quoted = false;
      } else if (char === 34) quoted = true;
      else if (char === 123 || char === 91) depth++;
      else if ((char === 125 || char === 93) && --depth === 0) {
        const catalog = JSON.parse(bytes.subarray(start, end + 1).toString());
        if (catalog.models?.some(model => model.slug === "gpt-6-astra")) return catalog;
        break;
      }
    }
  }
  throw new Error("Bundled Codex model catalog is unavailable");
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

// Provider-specific catalog URLs keep the global model_catalog_json and official
// OpenAI configuration untouched. The core reads this URL when its process starts.
export function createUltrafastCatalogAdapter({
  executable, dataDirectory, preferencesFile, processEnv = process.env,
  report = console.error,
  createClient = () => new CodexAppServer({ executable, processEnv }),
}) {
  const stateFile = path.join(dataDirectory, "ultrafast-catalog.json");
  let server, state, catalog, queue = Promise.resolve();
  // Running Codex processes retain their catalog URL until they restart.
  const sessionProviders = new Map();
  const save = async () => {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(stateFile + ".tmp", JSON.stringify(state), { mode: 0o600 });
    await rename(stateFile + ".tmp", stateFile);
  };
  const startServer = async () => {
    if (server) return;
    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const entry = [...sessionProviders.values()].find(entry => url.pathname === entry.route);
      if (request.method !== "GET" || !entry) { response.writeHead(404).end(); return; }
      try {
        let source = catalog;
        if (entry.originalUrl) {
          const upstream = new URL(entry.originalUrl);
          url.searchParams.forEach((value, key) => upstream.searchParams.set(key, value));
          const headers = { ...request.headers };
          delete headers.host;
          delete headers.connection;
          const result = await fetch(upstream, { headers, signal: AbortSignal.timeout(10_000) });
          if (!result.ok) throw new Error("Provider catalog request failed");
          source = await result.json();
        }
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(Object.values(state.providers).includes(entry) ? withUltrafastCatalog(source) : source));
      } catch {
        // Never log request headers: the core includes the provider's bearer token.
        response.writeHead(502).end("Model catalog unavailable");
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(state.port ?? 0, "127.0.0.1", resolve);
      });
    } catch (error) { server = null; throw error; }
    state.port = server.address().port;
    await save();
  };
  const sync = async () => {
    if (!preferencesFile) return;
    const preferences = await readJson(preferencesFile, {});
    state ??= await readJson(stateFile, { providers: {} });
    for (const [name, entry] of Object.entries(state.providers)) sessionProviders.set(name, entry);
    const enabled = preferences.customProviderUltrafast === true;
    const contexts = await readJson(path.join(dataDirectory, "model-context.json"), null);
    if (!enabled && Object.keys(state.providers).length === 0 && !contexts) return;
    const client = createClient();
    try {
      const { config, layers, origins } = await client.request("config/read", { includeLayers: true });
      const userLayer = layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
      const provider = config.model_provider ?? "openai";
      let active = enabled && provider !== "openai" && config.model_providers?.[provider];
      if (contexts && config.model_catalog_json === path.join(realpathSync(dataDirectory), "model-context-catalog.json")) {
        const source = active ? withUltrafastCatalog(contexts.catalog) : contexts.catalog;
        const combined = { ...source, models: source.models.map(model => Object.hasOwn(contexts.contextWindows, model.slug)
          ? { ...model, context_window: contexts.contextWindows[model.slug] } : model) };
        await writeFile(config.model_catalog_json + ".tmp", JSON.stringify(combined), { mode: 0o600 });
        await rename(config.model_catalog_json + ".tmp", config.model_catalog_json);
        active = false;
      }
      if (active && config.model_catalog_json) {
        throw new Error("Ultrafast requires service_tiers in your existing model_catalog_json");
      }
      if (active) {
        const origin = origins?.[`model_providers.${provider}.model_catalog_url`]?.name;
        if (origin && !(origin.type === "system"
          || origin.type === "user" && !origin.profile && origin.file === userLayer?.name.file)) {
          throw new Error("Ultrafast catalog URL is controlled by a higher-priority config layer");
        }
        catalog ??= await readBundledModelCatalog(executable);
        await startServer();
      }
      const edits = [];
      for (const [name, entry] of Object.entries(state.providers)) {
        if (active && name === provider) continue;
        const current = userLayer?.config?.model_providers?.[name]?.model_catalog_url;
        if (current === entry.url) edits.push({ keyPath: `model_providers.${JSON.stringify(name)}.model_catalog_url`,
          value: entry.restoreValue, mergeStrategy: "replace" });
      }
      if (active) {
        const current = config.model_providers[provider].model_catalog_url ?? null;
        let entry = state.providers[provider];
        if (!entry || current !== entry.url) {
          const previous = sessionProviders.get(provider);
          entry = { originalUrl: current,
            restoreValue: userLayer?.config?.model_providers?.[provider]?.model_catalog_url ?? null,
            route: previous?.originalUrl === current ? previous.route : `/models/${randomUUID()}` };
          entry.url = `http://127.0.0.1:${state.port}${entry.route}`;
          state.providers[provider] = entry;
          sessionProviders.set(provider, entry);
          // Retain restoration information before changing the user's config.
          await save();
        }
        if (current !== entry.url) edits.push({ keyPath: `model_providers.${JSON.stringify(provider)}.model_catalog_url`,
          value: entry.url, mergeStrategy: "replace" });
      }
      if (edits.length) {
        const result = await client.request("config/batchWrite", {
          edits, filePath: userLayer?.name.file ?? null,
          expectedVersion: userLayer?.version ?? null, reloadUserConfig: true,
        });
        if (result.status !== "ok") throw new Error("Ultrafast catalog config is overridden by another layer");
        report("Panel Ultrafast catalog updated; restart Codex to apply core model capabilities.");
      }
      for (const name of Object.keys(state.providers)) {
        if (!active || name !== provider) delete state.providers[name];
      }
      await save();
    } finally { await client.close(); }
  };
  return {
    sync() {
      const pending = queue.then(sync);
      queue = pending.catch(() => {});
      return pending;
    },
    async close() {
      await queue;
      if (server) {
        const closing = server;
        server = null;
        closing.closeAllConnections();
        await new Promise(resolve => closing.close(resolve));
      }
    },
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, appPath, dataDirectory] = process.argv.slice(2);
  if (!["read-contexts", "write-contexts", "read-discovery", "enable-discovery", "remove-discovery"].includes(operation) || !appPath) {
    throw new Error("Expected a model configuration operation and a Codex application path");
  }
  const client = new CodexAppServer({ executable: codexExecutableInApp(appPath) });
  try {
    if (operation === "read-contexts" || operation === "write-contexts") {
      if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("需要绝对路径的 Panel 数据目录");
      let input;
      if (operation === "write-contexts") {
        let source = "";
        for await (const chunk of process.stdin) source += chunk;
        input = JSON.parse(source);
      }
      console.log(JSON.stringify(await modelContextSettings({ executable: codexExecutableInApp(appPath), dataDirectory }, input)));
    } else if (operation === "read-discovery") console.log(JSON.stringify(await readModelDiscovery(client)));
    else await setModelDiscovery(client, operation === "enable-discovery");
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await client.close(); }
}
