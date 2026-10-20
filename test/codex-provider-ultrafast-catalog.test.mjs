import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import { createUltrafastCatalogAdapter, readBundledModelCatalog, withUltrafastCatalog } from "../scripts/codex-provider-ultrafast-catalog.mjs";

test("catalog preserves native metadata and only adds the two official Ultrafast models", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "custom-alias"].map(slug => ({
    slug, base_instructions: 'Native instructions with a quoted brace: "}"', service_tiers: [{ id: "priority" }],
  }));
  const original = { models, extra: "preserved" };
  const binary = path.join(root, "codex");
  await writeFile(binary, Buffer.concat([Buffer.from([0, 255]), Buffer.from(JSON.stringify(original)), Buffer.from([0])]));
  assert.deepEqual(await readBundledModelCatalog(binary), original);
  const patched = withUltrafastCatalog(original);
  assert.equal(patched.extra, original.extra);
  assert.equal(patched.models[0].base_instructions, models[0].base_instructions);
  assert.deepEqual(patched.models.map(m => m.service_tiers.some(tier => tier.id === "ultrafast")), [true, true, false, false]);
  assert.equal(original.models[0].service_tiers.length, 1);
  assert.deepEqual(withUltrafastCatalog(patched), patched);
});

test("provider catalog preserves an existing endpoint and restores only its own config field", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  const executable = path.join(root, "codex");
  await writeFile(executable, JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: [] }] }));
  let authorization;
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: "gpt-6-astra", base_instructions: "custom instructions", service_tiers: [] }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const originalUrl = `http://127.0.0.1:${upstream.address().port}/catalog`;
  const config = { model_provider: "probe.dot", model_providers: {
    "probe.dot": { model_catalog_url: originalUrl, name: "Probe" }, openai: { name: "OpenAI" },
  } };
  let writes = 0;
  const adapter = createUltrafastCatalogAdapter({ executable, preferencesFile, dataDirectory: root, report() {},
    createClient: () => ({ close() {}, async request(method, params) {
      if (method === "config/read") return { config, layers: [{ name: { type: "user", file: "/fixture/config.toml" }, version: "v1", config }] };
      assert.equal(method, "config/batchWrite");
      assert.equal(params.filePath, "/fixture/config.toml");
      assert.equal(params.expectedVersion, "v1");
      for (const edit of params.edits) {
        assert.equal(edit.keyPath, 'model_providers."probe.dot".model_catalog_url');
        config.model_providers["probe.dot"].model_catalog_url = edit.value;
      }
      writes++;
      return { status: "ok" };
    } }),
  });
  t.after(() => adapter.close());
  await adapter.sync(); await adapter.sync();
  assert.equal(writes, 1);
  const url = config.model_providers["probe.dot"].model_catalog_url;
  const response = await fetch(url + "?client_version=fixture", { headers: { Authorization: "Bearer fixture-only" } });
  const catalog = await response.json();
  assert.equal(authorization, "Bearer fixture-only");
  assert.equal(catalog.models[0].base_instructions, "custom instructions");
  assert.equal(catalog.models[0].service_tiers[0].id, "ultrafast");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));
  await adapter.sync();
  assert.equal(config.model_providers["probe.dot"].model_catalog_url, originalUrl);
  assert.equal(config.model_catalog_json, undefined);
  assert.deepEqual(config.model_providers.openai, { name: "OpenAI" });
  const disabledResponse = await fetch(url);
  assert.equal(disabledResponse.status, 200, "the URL retained by running Codex remains available");
  assert.deepEqual((await disabledResponse.json()).models[0].service_tiers, []);
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  await adapter.sync();
  assert.equal(config.model_providers["probe.dot"].model_catalog_url, url, "re-enabling reuses the running catalog URL");
  assert.equal((await (await fetch(url)).json()).models[0].service_tiers[0].id, "ultrafast");
});

test("restoring a catalog preserves inherited values and rejects higher-priority overrides", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-layers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preferencesFile = path.join(root, "preferences.json"), executable = path.join(root, "codex");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  await writeFile(executable, JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: [] }] }));
  const inheritedUrl = "http://127.0.0.1:9/inherited-catalog";
  const userConfig = { model_providers: { probe: { name: "Probe" } } };
  const userName = { type: "user", file: "/fixture/config.toml" };
  let overridden = false, writes = 0;
  const adapter = createUltrafastCatalogAdapter({ executable, preferencesFile, dataDirectory: root, report() {},
    createClient: () => ({ close() {}, async request(method, params) {
      const own = userConfig.model_providers.probe;
      if (method === "config/read") return {
        config: { model_provider: "probe", model_providers: { probe: { ...own,
          model_catalog_url: overridden ? "http://127.0.0.1:9/project" : own.model_catalog_url ?? inheritedUrl } } },
        origins: { "model_providers.probe.model_catalog_url": { name: overridden ? { type: "project" }
          : own.model_catalog_url ? userName : { type: "system" } } },
        layers: [{ name: userName, version: "v1", config: userConfig }],
      };
      assert.equal(method, "config/batchWrite");
      for (const edit of params.edits) {
        if (edit.value === null) delete own.model_catalog_url;
        else own.model_catalog_url = edit.value;
      }
      writes++;
      return { status: "ok" };
    } }),
  });
  t.after(() => adapter.close());
  await adapter.sync();
  const saved = JSON.parse(await readFile(path.join(root, "ultrafast-catalog.json"), "utf8"));
  assert.equal(saved.providers.probe.originalUrl, inheritedUrl);
  assert.equal(saved.providers.probe.restoreValue, null);
  // A project override can hide our root field; disabling must still remove it.
  overridden = true;
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));
  await adapter.sync();
  assert.deepEqual(userConfig.model_providers.probe, { name: "Probe" });
  assert.equal(writes, 2);
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  await assert.rejects(adapter.sync(), /higher-priority config layer/);
  assert.equal(writes, 2);
  overridden = false;
  await adapter.sync();
  userConfig.model_providers.probe.model_catalog_url = "http://127.0.0.1:9/user-edit";
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));
  await adapter.sync();
  assert.equal(userConfig.model_providers.probe.model_catalog_url, "http://127.0.0.1:9/user-edit");
});

// Opt-in uses only the executable from the caller. All state, credentials,
// workspaces and HTTP endpoints belong to this disposable test environment.
test("real Codex core sends Ultrafast after adapter setup and restart, then restores the original catalog", {
  skip: !process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE,
  timeout: 60_000,
}, async t => {
  const executable = process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE;
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), home = path.join(root, "home"), codexHome = path.join(root, "codex");
  await Promise.all([workspace, home, codexHome].map(directory => mkdir(directory)));
  const processEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: root, OTEL_SDK_DISABLED: "true" };
  const bodies = [];
  const api = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.setHeader("Content-Type", "text/event-stream");
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp_probe", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } })}\n\n`);
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => { api.closeAllConnections(); api.close(); });
  const configFile = path.join(codexHome, "config.toml");
  await writeFile(configFile, `model = "gpt-6-astra"
model_provider = "probe"
check_for_update_on_startup = false
[features]
api_key_model_discovery = true
[analytics]
enabled = false
[model_providers.probe]
name = "Local test only"
base_url = "http://127.0.0.1:${api.address().port}/v1"
wire_api = "responses"
experimental_bearer_token = "fixture-token"
request_max_retries = 0
stream_max_retries = 0
`);
  const createClient = () => new CodexAppServer({ executable, processEnv, cwd: workspace });
  const send = async (client, threadId, model = "gpt-6-astra") => {
    if (!threadId) threadId = (await client.startThread({ cwd: workspace, model, modelProvider: "probe", approvalPolicy: "never", sandbox: "read-only" })).thread.id;
    else await client.resumeThread({ threadId, cwd: workspace });
    let unsubscribe, timer;
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Local mock turn timed out")), 10_000);
      unsubscribe = client.subscribe(event => { if (event.method === "turn/completed") resolve(); });
    });
    try {
      await client.startTurn({ threadId, model, serviceTier: "ultrafast", input: [{ type: "text", text: "Reply OK. Do not use tools." }] });
      await completed;
      return threadId;
    } finally { clearTimeout(timer); unsubscribe(); }
  };
  let client = createClient(); t.after(() => client.close());
  const threadId = await send(client);
  assert.equal(bodies.at(-1).service_tier, undefined, "unadapted core reproduces the dropped parameter");
  await client.close();
  const preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  const adapter = createUltrafastCatalogAdapter({ executable, processEnv, preferencesFile, dataDirectory: path.join(root, "panel"), createClient, report() {} });
  t.after(() => adapter.close());
  await adapter.sync();
  client = createClient();
  // The explicit user setting wins over the desktop assignment; Panel leaves it alone.
  await client.request("experimentalFeature/enablement/set", { enablement: { api_key_model_discovery: false } });
  const listing = await client.request("model/list", { includeHidden: true });
  assert.ok(listing.data.length > 0, "explicit user discovery setting keeps the model picker available");
  assert.equal(parse(await readFile(configFile, "utf8")).features.api_key_model_discovery, true);
  await send(client, threadId);
  assert.equal(bodies.at(-1).service_tier, "ultrafast", "resumed native thread must forward the selected tier");
  await send(client, null, "gpt-6.1-sol");
  assert.equal(bodies.at(-1).service_tier, "ultrafast");
  await client.close();
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));
  await adapter.sync();
  const restored = parse(await readFile(configFile, "utf8"));
  assert.equal(restored.model_providers.probe.model_catalog_url, undefined);
  assert.equal(restored.model_catalog_json, undefined);
  assert.equal(restored.features.api_key_model_discovery, true, "disabling Ultrafast preserves the user discovery setting");
  client = createClient();
  await send(client, threadId);
  assert.equal(bodies.at(-1).service_tier, undefined);
});
