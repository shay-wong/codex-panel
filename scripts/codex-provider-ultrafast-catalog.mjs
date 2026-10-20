import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import { codexExecutableInApp } from "../shared/codex-executable.mjs";

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
    if (!enabled && Object.keys(state.providers).length === 0) return;
    const client = createClient();
    try {
      const { config, layers, origins } = await client.request("config/read", { includeLayers: true });
      const userLayer = layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
      const provider = config.model_provider ?? "openai";
      const active = enabled && provider !== "openai" && config.model_providers?.[provider];
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
  const [operation, appPath] = process.argv.slice(2);
  if (!["read-discovery", "enable-discovery", "remove-discovery"].includes(operation) || !appPath) {
    throw new Error("Expected read-discovery, enable-discovery or remove-discovery and a Codex application path");
  }
  const client = new CodexAppServer({ executable: codexExecutableInApp(appPath) });
  try {
    if (operation === "read-discovery") console.log(JSON.stringify(await readModelDiscovery(client)));
    else await setModelDiscovery(client, operation === "enable-discovery");
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await client.close(); }
}
