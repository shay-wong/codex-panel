import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import { createUltrafastCatalogAdapter, modelContextSettings, readBundledModelCatalog, readModelDiscovery, setModelDiscovery, withUltrafastCatalog } from "../scripts/codex-provider-ultrafast-catalog.mjs";

async function fixtureCodex(root, models) {
  const executable = path.join(root, "codex.mjs");
  const catalog = { models: models.some(model => model.slug === "gpt-6-astra") ? models : [{ slug: "gpt-6-astra" }, ...models] };
  await writeFile(executable, `const catalog = ${JSON.stringify(catalog)};\nconsole.log(process.argv[2] === "debug" ? JSON.stringify(catalog) : "codex-cli 0.169.0-alpha.11.1");\n`);
  return executable;
}

test("model selection persists across refresh and Ultrafast catalog generation", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-selected-models-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json"), statePath = path.join(root, "model-context.json");
  const configFile = path.join(root, "config.toml");
  await writeFile(configFile, "");
  const astra = { slug: "gpt-6-astra", context_window: 272000, base_instructions: "Astra metadata" };
  const sol = { slug: "gpt-6.1-sol", context_window: 500000, base_instructions: "Sol metadata" };
  const newcomer = { ...sol, slug: "gpt-6.2-sol", base_instructions: "New model metadata" };
  const executable = await fixtureCodex(root, [astra, sol, newcomer, { ...newcomer, slug: "gpt-7-sol" }]);
  const contextWindows = { [astra.slug]: 400000, [sol.slug]: 600000 };
  await writeFile(statePath, JSON.stringify({ catalog: { models: [astra, sol] }, catalogSource: "external", originalCatalog: null,
    contextWindows, autoCompactTokenLimits: {}, multiAgentReasoningEfforts: {} }));
  await writeFile(catalogPath, JSON.stringify({ models: [astra, sol] }));
  const config = { model_catalog_json: catalogPath, model_provider: "fixture",
    model_providers: { fixture: { base_url: "http://127.0.0.1:9/v1" } } };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read");
    return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
  });
  let remoteModels = [astra, sol, newcomer];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: remoteModels })));
  const options = { executable, dataDirectory: root };
  assert.deepEqual((await modelContextSettings(options)).selectedModels, [astra.slug, sol.slug]);
  const save = selection => modelContextSettings(options, contextWindows, {}, {}, undefined, undefined, undefined, undefined, selection);
  await save([astra.slug]);
  assert.deepEqual(JSON.parse(await readFile(catalogPath)).models, [{ ...astra, context_window: 400000, priority: 0 }]);
  assert.deepEqual((await modelContextSettings(options)).selectedModels, [astra.slug]);
  const refreshed = await modelContextSettings({ ...options, refreshCatalog: true });
  assert.equal(refreshed.models.length, 3);
  assert.deepEqual(refreshed.selectedModels, [astra.slug]);
  assert.equal(refreshed.catalogChanged, false, "an unselected new model must not require a Codex restart");
  assert.deepEqual(JSON.parse(await readFile(catalogPath)).models.map(model => model.slug), [astra.slug]);
  assert.equal(JSON.parse(await readFile(statePath)).contextWindows[sol.slug], 600000);
  await save([astra.slug, newcomer.slug]);
  assert.deepEqual(JSON.parse(await readFile(catalogPath)).models, [{ ...newcomer, priority: 0 }, { ...astra, context_window: 400000, priority: 1 }]);
  const preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  const adapter = createUltrafastCatalogAdapter({ ...options, preferencesFile, report() {} });
  t.after(() => adapter.close());
  await adapter.sync();
  const combined = JSON.parse(await readFile(catalogPath));
  assert.deepEqual(combined.models.map(model => model.slug), [newcomer.slug, astra.slug]);
  assert.ok(combined.models.every(model => model.service_tiers.some(tier => tier.id === "ultrafast")));
  const before = await readFile(catalogPath, "utf8");
  await assert.rejects(save([]), /至少保留一个模型/);
  assert.equal(await readFile(catalogPath, "utf8"), before);
  remoteModels = [{ ...newcomer, slug: "gpt-7-sol" }];
  const unavailable = await modelContextSettings({ ...options, refreshCatalog: true });
  assert.equal(unavailable.catalogChanged, false);
  assert.deepEqual(unavailable.models.map(model => model.slug), ["gpt-7-sol"]);
  assert.equal(await readFile(catalogPath, "utf8"), before, "a refresh must not install an empty catalog");
  await adapter.sync();
  assert.equal(await readFile(catalogPath, "utf8"), before, "catalog synchronization must also preserve the last non-empty selection");
});

test("model settings group model series with newer versions first without changing the source catalog", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-model-sort-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "model-context.json");
  const catalog = { models: ["gemini-3-flash", "gpt-6-sol", "claude-opus-4-7", "gpt-6.2-astra", "gemini-3.1-pro", "gpt-6.10-sol", "gpt-6.1-sol", "claude-opus-4-8", "gpt-6.2-sol"]
    .map(slug => ({ slug })) };
  const executable = await fixtureCodex(root, catalog.models);
  const saved = JSON.stringify({ catalog, contextWindows: {}, catalogSource: "external", originalCatalog: null });
  await writeFile(statePath, saved);
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read");
    return { config: { model_catalog_json: path.join(root, "model-context-catalog.json") },
      layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config: {} }] };
  });
  const settings = await modelContextSettings({ executable, dataDirectory: root });
  assert.deepEqual(settings.models.map(model => model.slug), ["gpt-6.10-sol", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"]);
  assert.equal(await readFile(statePath, "utf8"), saved);
});

test("catalog refresh ignores JSON key and model array order but detects changed metadata", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-catalog-key-order-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = { slug: "gpt-6-astra", description: "Current model description", context_window: 128000,
    default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Low reasoning" }] };
  const companion = { ...model, slug: "gpt-6.1-sol" };
  const executable = await fixtureCodex(root, [model, companion]);
  const catalogPath = path.join(root, "model-context-catalog.json"), statePath = path.join(root, "model-context.json");
  const generated = [{ ...companion, priority: 0 }, { ...model, priority: 1 }];
  const reordered = generated.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.deepEqual(reordered, generated);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(generated));
  await writeFile(catalogPath, JSON.stringify({ models: reordered }));
  await writeFile(statePath, JSON.stringify({ catalog: { models: [model, companion] }, contextWindows: {},
    selectedModels: [model.slug, companion.slug], catalogSource: "external", originalCatalog: null }));
  const config = { model_catalog_json: catalogPath, model_provider: "fixture",
    model_providers: { fixture: { base_url: "http://127.0.0.1:9/v1" } } };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read");
    return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: [model, companion] })));
  const options = { executable, dataDirectory: root, refreshCatalog: true };
  assert.equal((await modelContextSettings(options)).catalogChanged, false, "key order alone must not prompt for a restart");
  await writeFile(catalogPath, JSON.stringify({ models: generated.toReversed() }));
  assert.equal((await modelContextSettings(options)).catalogChanged, false, "array order alone must not prompt when model priorities are unchanged");
  await writeFile(catalogPath, JSON.stringify({ models: [{ ...generated[0], priority: 9 }, generated[1]] }));
  assert.equal((await modelContextSettings(options)).catalogChanged, true, "priority changes must still require a restart");
  model.description = "Updated model description";
  assert.equal((await modelContextSettings(options)).catalogChanged, true, "a real metadata change must still require a restart");
});

test("model refresh and context saves preserve enabled Ultrafast catalog metadata", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-catalog-ultrafast-refresh-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), codexHome = path.join(root, "codex"), dataDirectory = path.join(root, "data"), workspace = path.join(root, "workspace");
  await Promise.all([home, codexHome, dataDirectory, workspace].map(directory => mkdir(directory)));
  const models = ["gpt-6-astra", "gpt-6.2-sol"].map(slug => ({ slug, context_window: 500000,
    description: "Provider model", service_tiers: [{ id: "priority", name: "Fast", description: "" }] }));
  const executable = await fixtureCodex(root, models);
  const configFile = path.join(codexHome, "config.toml"), catalogPath = path.join(dataDirectory, "model-context-catalog.json");
  const statePath = path.join(dataDirectory, "model-context.json"), preferencesFile = path.join(root, "preferences.json");
  await writeFile(configFile, "");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  await writeFile(statePath, JSON.stringify({ catalog: { models }, catalogSource: "external", originalCatalog: null,
    contextWindows: {}, selectedModels: models.map(model => model.slug) }));
  await writeFile(catalogPath, JSON.stringify({ models }));
  const config = { model_catalog_json: catalogPath, model_provider: "fixture",
    model_providers: { fixture: { base_url: "http://127.0.0.1:9/v1" } } };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read");
    return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
  });
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.origin, "http://127.0.0.1:9");
    return new Response(JSON.stringify({ models }));
  });
  const processEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: root,
    CODEX_PANEL_PREFERENCES_FILE: preferencesFile, OTEL_SDK_DISABLED: "true" };
  const options = { executable, dataDirectory, processEnv, cwd: workspace };
  const adapter = createUltrafastCatalogAdapter({ ...options, preferencesFile, report() {} });
  t.after(() => adapter.close());
  const assertUltrafast = async () => {
    const generated = JSON.parse(await readFile(catalogPath));
    assert.ok(generated.models.every(model => model.service_tiers.some(tier => tier.id === "ultrafast")));
    return generated;
  };
  await adapter.sync();
  await assertUltrafast();
  assert.equal((await modelContextSettings({ ...options, refreshCatalog: true })).catalogChanged, false,
    "an unchanged provider catalog must not lose the enabled Ultrafast tier or require a restart");
  await assertUltrafast();
  await modelContextSettings(options, { "gpt-6.2-sol": 600000 }, {}, {});
  const saved = await assertUltrafast();
  assert.equal(saved.models.find(model => model.slug === "gpt-6.2-sol").context_window, 600000);
  models[0].description = "Updated provider model";
  assert.equal((await modelContextSettings({ ...options, refreshCatalog: true })).catalogChanged, true);
  await assertUltrafast();
  assert.deepEqual(JSON.parse(await readFile(statePath)).catalog, { models }, "saved provider metadata must not contain the added Ultrafast tier");
});

test("refresh requests the provider even when an original catalog file is retained", async t => {
  for (const originalExists of [true, false]) await t.test(originalExists ? "original file exists" : "original file is missing", async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-refresh-original-catalog-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home"), codexHome = path.join(root, "codex"), dataDirectory = path.join(root, "data"), workspace = path.join(root, "workspace");
    await Promise.all([home, codexHome, dataDirectory, workspace].map(directory => mkdir(directory)));
    const old = { slug: "gpt-6-astra", context_window: 500000, description: "Old source",
      supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] };
    const latest = { models: [{ ...old, description: "Updated provider source" }, { ...old, slug: "gpt-6.2-sol" }] };
    const executable = await fixtureCodex(root, [old, latest.models[1]]);
    const originalCatalog = path.join(root, "original-catalog.json"), originalContents = JSON.stringify({ models: [old] });
    if (originalExists) await writeFile(originalCatalog, originalContents);
    const statePath = path.join(dataDirectory, "model-context.json"), catalogPath = path.join(dataDirectory, "model-context-catalog.json");
    const configFile = path.join(codexHome, "config.toml"), preferencesFile = path.join(root, "preferences.json");
    const contextWindows = { [old.slug]: 600000 }, autoCompactTokenLimits = { [old.slug]: "50%" }, multiAgentReasoningEfforts = { [old.slug]: "max" };
    await writeFile(configFile, "");
    await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
    await writeFile(statePath, JSON.stringify({ catalog: { models: [old] }, catalogSource: "external", originalCatalog,
      contextWindows, autoCompactTokenLimits, multiAgentReasoningEfforts, selectedModels: [old.slug] }));
    await writeFile(catalogPath, originalContents);
    const endpoint = "http://127.0.0.1:9/provider-catalog?tenant=fixture";
    const config = { model_catalog_json: catalogPath, model_provider: "fixture", model_providers: { fixture: {
      model_catalog_url: endpoint, experimental_bearer_token: "fixture-provider-key",
      query_params: { deployment: "fixture" }, env_http_headers: { "x-fixture-actor": "FIXTURE_ACTOR" },
    } } };
    t.mock.method(CodexAppServer.prototype, "request", async method => {
      assert.equal(method, "config/read");
      return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
    });
    let requests = 0, unavailable = false;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      requests++;
      assert.equal(url.origin + url.pathname, "http://127.0.0.1:9/provider-catalog");
      assert.equal(url.searchParams.get("tenant"), "fixture");
      assert.equal(url.searchParams.get("deployment"), "fixture");
      assert.equal(url.searchParams.get("client_version"), "0.169.0");
      assert.equal(options.headers.get("Authorization"), "Bearer fixture-provider-key");
      assert.equal(options.headers.get("x-fixture-actor"), "fixture-actor");
      return unavailable ? new Response("Unavailable", { status: 503 }) : new Response(JSON.stringify(latest));
    });
    const processEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: root,
      CODEX_PANEL_PREFERENCES_FILE: preferencesFile, FIXTURE_ACTOR: "fixture-actor", OTEL_SDK_DISABLED: "true" };
    const options = { executable, dataDirectory, processEnv, cwd: workspace };
    const adapter = createUltrafastCatalogAdapter({ ...options, preferencesFile, report() {} });
    t.after(() => adapter.close());
    await adapter.sync();
    const refreshed = await modelContextSettings({ ...options, refreshCatalog: true });
    assert.equal(requests, 1, "a saved original file must not intercept provider refresh");
    assert.equal(refreshed.catalogChanged, true);
    assert.deepEqual(refreshed.models.map(model => model.slug), ["gpt-6.2-sol", old.slug]);
    assert.deepEqual(refreshed.selectedModels, [old.slug]);
    assert.deepEqual(refreshed.contextWindows, contextWindows);
    assert.deepEqual(refreshed.autoCompactTokenLimits, autoCompactTokenLimits);
    assert.deepEqual(refreshed.multiAgentReasoningEfforts, multiAgentReasoningEfforts);
    const state = JSON.parse(await readFile(statePath));
    assert.equal(state.originalCatalog, originalCatalog);
    assert.deepEqual(state.catalog, latest);
    const generated = JSON.parse(await readFile(catalogPath));
    assert.equal(generated.models.length, 1, "new provider candidates remain unselected");
    assert.equal(generated.models[0].description, "Updated provider source");
    assert.equal(generated.models[0].context_window, 600000);
    assert.equal(generated.models[0].auto_compact_token_limit, 300000);
    assert.equal(generated.models[0].multi_agent_reasoning_effort, "max");
    assert.ok(generated.models[0].service_tiers.some(tier => tier.id === "ultrafast"));
    if (originalExists) assert.equal(await readFile(originalCatalog, "utf8"), originalContents);
    else await assert.rejects(readFile(originalCatalog), { code: "ENOENT" });
    const beforeState = await readFile(statePath, "utf8"), beforeCatalog = await readFile(catalogPath, "utf8");
    unavailable = true;
    await assert.rejects(modelContextSettings({ ...options, refreshCatalog: true }), /503/);
    assert.equal(requests, 2);
    assert.equal(await readFile(statePath, "utf8"), beforeState);
    assert.equal(await readFile(catalogPath, "utf8"), beforeCatalog);
    if (originalExists) assert.equal(await readFile(originalCatalog, "utf8"), originalContents);
    else await assert.rejects(readFile(originalCatalog), { code: "ENOENT" });
  });
});

test("official GPT intersection restores main reasoning metadata and native numeric order", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-official-gpt-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const levels = ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort, description: `${effort} reasoning` }));
  const official = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.3-sol"].map((slug, priority) => ({
    slug, priority, default_reasoning_level: "low", supported_reasoning_levels: levels,
    base_instructions: `Official instructions for ${slug}`, context_window: 500000,
  }));
  const source = { models: [
    { slug: "gpt-6-astra", priority: 0, default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }],
      base_instructions: "Provider Astra instructions", context_window: 400000 },
    { slug: "claude-opus-5", supported_reasoning_levels: [] },
    { slug: "gpt-6.1-sol", priority: 1, default_reasoning_level: null, supported_reasoning_levels: [], base_instructions: null },
    { slug: "gpt-image-1", supported_reasoning_levels: [] },
    { slug: "gpt-6.2-sol", priority: 2, context_window: 700000, supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] },
    { slug: "gpt-provider-only", context_window: 800000 },
  ] };
  const executable = await fixtureCodex(root, official);
  const statePath = path.join(root, "model-context.json"), catalogPath = path.join(root, "model-context-catalog.json");
  const overrides = { "gpt-6.1-sol": 600000, "gpt-provider-only": 900000 };
  const saved = JSON.stringify({ catalog: source, catalogSource: "external", originalCatalog: null,
    contextWindows: overrides, selectedModels: source.models.map(model => model.slug) });
  await writeFile(statePath, saved);
  await writeFile(catalogPath, JSON.stringify(source));
  const config = { model: "gpt-6.1-sol", model_reasoning_effort: "ultra", model_catalog_json: catalogPath };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read", "catalog normalization must not rewrite the main model or effort");
    return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
  });
  const options = { executable, dataDirectory: root };
  const settings = await modelContextSettings(options);
  const slugs = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-astra"];
  assert.deepEqual(settings.models.map(model => model.slug), slugs);
  assert.deepEqual(new Set(settings.selectedModels), new Set(slugs));
  assert.equal(await readFile(statePath, "utf8"), saved, "reading must leave source and saved overrides untouched");
  await modelContextSettings(options, settings.contextWindows, {}, {}, undefined, undefined, undefined, undefined, settings.selectedModels);
  const generated = JSON.parse(await readFile(catalogPath));
  assert.deepEqual(generated.models.map(model => [model.slug, model.priority]), slugs.map((slug, index) => [slug, index]));
  const sol = generated.models.find(model => model.slug === "gpt-6.1-sol");
  assert.equal(sol.default_reasoning_level, "low");
  assert.deepEqual(sol.supported_reasoning_levels, levels);
  assert.equal(sol.base_instructions, "Official instructions for gpt-6.1-sol");
  assert.equal(sol.context_window, 600000, "saved context takes precedence over official fallback");
  const astra = generated.models.find(model => model.slug === "gpt-6-astra");
  assert.equal(astra.default_reasoning_level, "high");
  assert.deepEqual(astra.supported_reasoning_levels, [{ effort: "high" }], "explicit provider restrictions take precedence");
  assert.equal(astra.base_instructions, "Provider Astra instructions");
  assert.equal(astra.context_window, 400000);
  assert.equal(generated.models[0].context_window, 700000);
  assert.equal(generated.models[0].default_reasoning_level, "high", "an official default outside the provider's explicit range must not be used");
  assert.deepEqual(generated.models[0].supported_reasoning_levels, [{ effort: "high" }, { effort: "max" }]);
  const state = JSON.parse(await readFile(statePath));
  assert.deepEqual(state.catalog, source);
  assert.deepEqual(state.contextWindows, overrides);
  assert.equal(config.model_reasoning_effort, "ultra");
});

test("subscription catalog refresh uses the official endpoint and refreshed account credentials", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-subscription-catalog-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "config.toml");
  const catalogPath = path.join(root, "model-context-catalog.json");
  const statePath = path.join(root, "model-context.json");
  const authPath = path.join(root, "auth.json");
  await writeFile(configFile, "");
  const old = { slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000, base_instructions: "Old source" };
  const latest = { models: [old, { ...old, slug: "gpt-6.2-sol", context_window: 500000, base_instructions: "Account-specific instructions" }] };
  const executable = await fixtureCodex(root, latest.models);
  await writeFile(statePath, JSON.stringify({ catalog: { models: [old] }, catalogSource: "native", originalCatalog: null,
    contextWindows: { [old.slug]: 600000 } }));
  await writeFile(catalogPath, JSON.stringify({ models: [old] }));
  await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-expired" } }));
  let accountReads = 0, failAccount = false, downloads = 0, apiKeyMode = false;
  const config = { model_catalog_json: catalogPath };
  t.mock.method(CodexAppServer.prototype, "request", async (method, params) => {
    if (method === "config/read") return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
    assert.equal(method, "account/read");
    assert.deepEqual(params, { refreshToken: true });
    accountReads++;
    if (failAccount) throw new Error("Account refresh failed");
    await writeFile(authPath, JSON.stringify(apiKeyMode ? { auth_mode: "apikey", OPENAI_API_KEY: "fixture-openai-key",
      tokens: { access_token: "fixture-stale-subscription", account_id: "fixture-stale-account" } } : { auth_mode: "chatgpt", tokens: {
      access_token: "fixture-subscription-token", account_id: "fixture-subscription-account",
    } }));
    return { account: apiKeyMode ? { type: "apiKey" } : { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true };
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://chatgpt.com");
    assert.equal(url.pathname, "/backend-api/codex/models");
    assert.equal(url.searchParams.get("client_version"), "0.169.0");
    assert.equal(options.headers.get("Authorization"), apiKeyMode ? "Bearer fixture-openai-key" : "Bearer fixture-subscription-token");
    assert.equal(options.headers.get("ChatGPT-Account-Id"), apiKeyMode ? null : "fixture-subscription-account");
    assert.equal(options.redirect, "error");
    downloads++;
    return new Response(JSON.stringify(latest));
  });
  const options = { executable, dataDirectory: root, refreshCatalog: true, cwd: root,
    processEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root } };
  const result = await modelContextSettings(options);
  assert.deepEqual(result.models.map(model => model.slug).sort(), latest.models.map(model => model.slug).sort());
  assert.equal(result.catalogChanged, true, "the selected model receives its generated priority");
  assert.equal(accountReads, 1);
  assert.equal(downloads, 1);
  const generated = JSON.parse(await readFile(catalogPath));
  assert.equal(generated.models[0].context_window, 600000);
  assert.equal(generated.models.length, 1);
  assert.deepEqual(JSON.parse(await readFile(statePath)).catalog.models[1], latest.models[1]);
  apiKeyMode = true;
  assert.equal((await modelContextSettings(options)).catalogChanged, false);
  assert.equal(downloads, 2);
  apiKeyMode = false;
  const saved = await readFile(statePath, "utf8");
  failAccount = true;
  await assert.rejects(modelContextSettings(options), /Account refresh failed/);
  assert.equal(downloads, 2);
  failAccount = false;
  const readsBeforeUnsupported = accountReads;
  config.cli_auth_credentials_store = "keyring";
  await assert.rejects(modelContextSettings(options), /file 凭据存储/);
  config.cli_auth_credentials_store = "file";
  config.model_provider = "gateway";
  config.model_providers = { gateway: { base_url: "https://gateway.example.invalid/v1", requires_openai_auth: true } };
  await assert.rejects(modelContextSettings(options), /原生账号或命令认证/);
  assert.equal(accountReads, readsBeforeUnsupported, "keyring and custom providers must not borrow the subscription auth file");
  assert.equal(downloads, 2);
  assert.equal(await readFile(statePath, "utf8"), saved);
  assert.equal(await readFile(configFile, "utf8"), "");
});

test("manual catalog refresh requests the active provider and preserves saved settings", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-catalog-refresh-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const statePath = path.join(root, "model-context.json");
  const configFile = path.join(root, "config.toml");
  await writeFile(configFile, "");
  const old = { slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000,
    supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }], base_instructions: "Native instructions" };
  const stale = { models: [old, { ...old, slug: "not-offered-by-provider" }] };
  const latest = { models: [{ ...old, supported_reasoning_levels: [] },
    { ...old, slug: "gpt-6.2-astra", service_tiers: [{ id: "ultrafast" }] },
    { ...old, slug: "gpt-6.2-sol", context_window: 500000 },
  ] };
  const executable = await fixtureCodex(root, [old, ...latest.models.slice(1)]);
  const saved = { catalog: stale, contextWindows: { [old.slug]: 600000, "not-offered-by-provider": 96000 },
    autoCompactTokenLimits: { [old.slug]: "50%", "not-offered-by-provider": "25%" },
    multiAgentReasoningEfforts: { [old.slug]: "max", "not-offered-by-provider": "high" },
    originalCatalog: null, catalogSource: "native" };
  await writeFile(statePath, JSON.stringify(saved));
  await writeFile(catalogPath, JSON.stringify(stale));
  await writeFile(path.join(root, "models_cache.json"), JSON.stringify(stale));
  let downloads = 0, failure = "", expectedPath = "/v1/models", expectedToken = "fixture-provider-key";
  const api = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, expectedPath);
    assert.equal(url.searchParams.get("client_version"), "0.169.0");
    assert.equal(url.searchParams.get("deployment"), "fixture");
    if (expectedPath === "/catalog") assert.equal(url.searchParams.get("tenant"), "fixture");
    assert.equal(request.headers.authorization, `Bearer ${expectedToken}`);
    assert.equal(request.headers["x-openai-actor-authorization"], "fixture-actor");
    assert.equal(request.headers["x-provider"], "fixture");
    downloads++;
    if (failure === "http") { response.writeHead(502).end("unavailable"); return; }
    if (failure === "redirect") { response.writeHead(302, { Location: "/credential-leak" }).end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (failure === "no-compatible") { response.end(JSON.stringify({ models: [{ slug: "claude-opus-5" }] })); return; }
    response.end(JSON.stringify(failure === "format" ? { data: [{ id: "gpt-6.2-sol" }] } : latest));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => { api.closeAllConnections(); api.close(); });
  const origin = `http://127.0.0.1:${api.address().port}`;
  const config = { model_provider: "probe", model_catalog_json: catalogPath, model_providers: { probe: {
    base_url: `${origin}/v1/`, experimental_bearer_token: expectedToken, requires_openai_auth: true,
    http_headers: { "x-provider": "fixture", "x-openai-actor-authorization": "old-actor" },
    env_http_headers: { "x-openai-actor-authorization": "FIXTURE_ACTOR" }, query_params: { deployment: "fixture" },
  } },
    agents: { default_subagent_model: old.slug, default_subagent_reasoning_effort: "high" } };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read", "refreshing an active Panel catalog must preserve user configuration");
    return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
  });
  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(url.origin, origin, "refresh must contact only the configured provider");
    assert.equal(options.redirect, "error");
    return localFetch(url, options);
  });
  const options = { executable, dataDirectory: root, refreshCatalog: true,
    processEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, FIXTURE_ACTOR: "fixture-actor", FIXTURE_KEY: "fixture-env-key" }, cwd: root };
  const refreshed = await modelContextSettings(options);
  assert.deepEqual(refreshed.models.map(model => model.slug).sort(), latest.models.map(model => model.slug).sort());
  assert.equal(refreshed.catalogChanged, true);
  assert.deepEqual(refreshed.contextWindows, saved.contextWindows);
  assert.deepEqual(refreshed.autoCompactTokenLimits, saved.autoCompactTokenLimits);
  assert.deepEqual(refreshed.multiAgentReasoningEfforts, saved.multiAgentReasoningEfforts);
  assert.equal(refreshed.defaultSubagentModel, old.slug);
  assert.equal(refreshed.defaultSubagentReasoningEffort, "high");
  assert.equal(refreshed.models.find(model => model.slug === old.slug).contextWindow, old.context_window, "provider defaults must not receive native Sol corrections");
  const catalog = JSON.parse(await readFile(catalogPath));
  assert.equal(catalog.models[0].context_window, 600000);
  assert.equal(catalog.models[0].auto_compact_token_limit, 300000);
  assert.equal(catalog.models[0].multi_agent_reasoning_effort, "max");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, old.supported_reasoning_levels);
  assert.equal(catalog.models.length, 1, "new models are initially unselected");
  assert.deepEqual(JSON.parse(await readFile(statePath)).catalog.models.slice(1), latest.models.slice(1), "new candidates retain their full metadata");
  const resaved = await modelContextSettings({ ...options, refreshCatalog: false }, refreshed.contextWindows,
    refreshed.autoCompactTokenLimits, refreshed.multiAgentReasoningEfforts);
  assert.deepEqual(resaved.contextWindows, saved.contextWindows);
  assert.deepEqual(resaved.autoCompactTokenLimits, saved.autoCompactTokenLimits);
  assert.deepEqual(resaved.multiAgentReasoningEfforts, saved.multiAgentReasoningEfforts);
  await assert.rejects(modelContextSettings({ ...options, refreshCatalog: false },
    { ...saved.contextWindows, "new-unoffered-model": 64000 }, saved.autoCompactTokenLimits, saved.multiAgentReasoningEfforts), /模型目录中没有 new-unoffered-model/);
  latest.models[0].supported_reasoning_levels = [{ effort: "high" }];
  await assert.rejects(modelContextSettings(options), /不支持子代理推理强度 max/);
  latest.models[0].supported_reasoning_levels = [];
  assert.equal((await modelContextSettings(options)).catalogChanged, false);
  assert.equal(downloads, 3, "each explicit refresh must request the provider rather than reuse a cache");
  const provider = config.model_providers.probe;
  provider.model_catalog_url = `${origin}/panel-proxy`;
  provider.env_key = "FIXTURE_KEY";
  await writeFile(path.join(root, "ultrafast-catalog.json"), JSON.stringify({ providers: { probe: {
    url: provider.model_catalog_url, originalUrl: `${origin}/catalog?tenant=fixture`,
  } } }));
  expectedPath = "/catalog";
  expectedToken = "fixture-env-key";
  assert.equal((await modelContextSettings(options)).catalogChanged, false);
  assert.equal(downloads, 4, "explicit catalogs use the original provider URL, not Panel's proxy");
  delete options.processEnv.FIXTURE_KEY;
  await assert.rejects(modelContextSettings(options), /FIXTURE_KEY/);
  assert.equal(downloads, 4, "a missing env_key must not fall back to another credential");
  options.processEnv.FIXTURE_KEY = expectedToken;
  const beforeFailure = await readFile(statePath, "utf8");
  const catalogBeforeFailure = await readFile(catalogPath, "utf8");
  for (const [mode, error] of [["http", /502/], ["format", /Codex 完整模型目录/], ["redirect", /fetch failed/], ["no-compatible", /没有当前 Codex 支持的 GPT/]]) {
    failure = mode;
    await assert.rejects(modelContextSettings(options), error);
  }
  assert.equal(await readFile(statePath, "utf8"), beforeFailure);
  assert.equal(await readFile(catalogPath, "utf8"), catalogBeforeFailure);
  assert.equal(await readFile(configFile, "utf8"), "");
});

test("reasoning overrides apply when capabilities are unspecified and reject explicit exclusions", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-reasoning-overrides-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const statePath = path.join(root, "model-context.json");
  const configFile = path.join(root, "config.toml");
  const model = { slug: "gpt-6.1-sol", context_window: 128000, multi_agent_reasoning_effort: null, supported_reasoning_levels: [] };
  const levels = ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort }));
  const executable = await fixtureCodex(root, [{ ...model, default_reasoning_level: "low", supported_reasoning_levels: levels }]);
  const contexts = { [model.slug]: 128000 };
  await writeFile(configFile, "");
  await writeFile(catalogPath, JSON.stringify({ models: [model] }));
  await writeFile(statePath, JSON.stringify({ catalog: { models: [model] }, catalogSource: "external",
    originalCatalog: null, contextWindows: contexts, multiAgentReasoningEfforts: {} }));
  const config = { model_catalog_json: catalogPath };
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read");
    return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
  });
  const options = { executable, dataDirectory: root };
  for (const effort of ["max", "ultra"]) {
    const result = await modelContextSettings(options, contexts, {}, { [model.slug]: effort });
    assert.equal(result.multiAgentReasoningEfforts[model.slug], effort);
    assert.equal(result.models[0].multiAgentReasoningEffort, null, "source default remains unspecified");
    const catalog = JSON.parse(await readFile(catalogPath));
    assert.equal(catalog.models[0].multi_agent_reasoning_effort, effort);
    assert.deepEqual(catalog.models[0].supported_reasoning_levels, levels);
    assert.equal(catalog.models[0].default_reasoning_level, "low");
    assert.deepEqual(JSON.parse(await readFile(statePath)).catalog.models[0], model, "provider source remains unchanged");
  }
  await modelContextSettings(options, contexts, {}, { [model.slug]: "max" });
  const state = JSON.parse(await readFile(statePath));
  state.catalog.models[0].supported_reasoning_levels = [{ effort: "high" }];
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(catalogPath, "utf8");
  await assert.rejects(modelContextSettings(options, contexts, {}, { [model.slug]: "max" }), /不支持子代理推理强度 max/);
  assert.equal(await readFile(catalogPath, "utf8"), before);
  await modelContextSettings(options, contexts, {}, { [model.slug]: "high" });
  assert.equal(JSON.parse(await readFile(catalogPath)).models[0].multi_agent_reasoning_effort, "high");
  await assert.rejects(modelContextSettings(options, contexts, {}, { [model.slug]: null }), /必须为非空字符串/);
});

test("role models and reasoning update registered and standalone files without changing instructions", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-role-model-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const contexts = { "gpt-parent-model": 96000 };
  const configFile = path.join(root, "config.toml");
  const directory = path.join(root, "agents");
  await mkdir(directory);
  const reviewer = 'model = "gpt-parent-model" # keep model comment\r\nmodel_reasoning_effort = "high"\r\ndeveloper_instructions = "Review carefully"\r\n';
  const explorer = 'name = "explorer"\ndescription = "Explore"\ndeveloper_instructions = """\nmodel = "instruction-example"\nmodel_reasoning_effort = "instruction-example"\nKeep this text.\n"""\nmodel_reasoning_effort = "low" # keep effort comment\n[features]\nshell_tool = false\n';
  await writeFile(path.join(directory, "reviewer.toml"), reviewer);
  await writeFile(path.join(directory, "explorer.toml"), explorer);
  await writeFile(configFile, '[agents.reviewer]\ndescription = "Review"\nconfig_file = "agents/reviewer.toml"\n');
  const originalConfig = await readFile(configFile, "utf8");
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: { models: [{ slug: "gpt-parent-model", context_window: 128000 }, { slug: "gpt-child-model", context_window: 64000,
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "max" }] }] },
    contextWindows: contexts, originalCatalog: null, catalogSource: "external",
  }));
  const executable = await fixtureCodex(root, [{ slug: "gpt-parent-model" }, { slug: "gpt-child-model" }]);
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read", "role-only updates must not rewrite the global config");
    return { config: { model_catalog_json: catalogPath }, layers: [{ name: { type: "user", file: configFile }, version: "v1", config: {} }] };
  });
  const options = { executable, dataDirectory: root };
  const before = await modelContextSettings(options);
  assert.deepEqual(before.agents.map(agent => [agent.name, agent.model]), [["explorer", null], ["reviewer", "gpt-parent-model"]]);
  await modelContextSettings(options, contexts, {}, {}, undefined, { reviewer: "gpt-child-model", explorer: "gpt-child-model" });
  assert.equal(await readFile(path.join(directory, "reviewer.toml"), "utf8"), reviewer.replace('model = "gpt-parent-model"', 'model = "gpt-child-model"'));
  assert.equal(await readFile(path.join(directory, "explorer.toml"), "utf8"), 'model = "gpt-child-model"\n' + explorer);
  assert.deepEqual((await modelContextSettings(options)).agents.map(agent => agent.model), ["gpt-child-model", "gpt-child-model"]);
  await modelContextSettings(options, contexts, {}, {}, undefined, undefined, undefined, { reviewer: "max", explorer: "medium" });
  assert.equal(await readFile(path.join(directory, "reviewer.toml"), "utf8"), reviewer.replace('model = "gpt-parent-model"', 'model = "gpt-child-model"').replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "max"'));
  assert.equal(await readFile(path.join(directory, "explorer.toml"), "utf8"), 'model = "gpt-child-model"\n' + explorer.replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "medium"'));
  assert.deepEqual((await modelContextSettings(options)).agents.map(agent => agent.reasoningEffort), ["medium", "max"]);
  await modelContextSettings(options, contexts, {}, {}, undefined, { reviewer: "", explorer: "" }, undefined, { reviewer: "", explorer: "" });
  assert.equal(await readFile(path.join(directory, "explorer.toml"), "utf8"), '\n' + explorer.replace('model_reasoning_effort = "low" ', ''));
  assert.equal(await readFile(path.join(directory, "reviewer.toml"), "utf8"), reviewer.replace('model = "gpt-parent-model" ', '').replace('model_reasoning_effort = "high"', ''));
  assert.deepEqual((await modelContextSettings(options)).agents.map(agent => [agent.model, agent.reasoningEffort]), [[null, null], [null, null]]);
  assert.equal(await readFile(configFile, "utf8"), originalConfig);
});

test("subagent model and reasoning defaults read, save and reset without changing model overrides", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-subagent-model-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const contexts = { "gpt-parent-model": 96000 };
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: { models: [{ slug: "gpt-parent-model", context_window: 128000 }, { slug: "gpt-child-model", context_window: 64000,
      supported_reasoning_levels: [{ effort: "high" }] }] },
    contextWindows: contexts, originalCatalog: null, catalogSource: "external",
  }));
  const executable = await fixtureCodex(root, [{ slug: "gpt-parent-model" }, { slug: "gpt-child-model" }]);
  const config = { model: "gpt-parent-model", model_catalog_json: catalogPath, agents: { max_threads: 4 } };
  const writes = [];
  t.mock.method(CodexAppServer.prototype, "request", async (method, params) => {
    if (method === "config/read") return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
    assert.equal(method, "config/batchWrite");
    assert.equal(params.expectedVersion, "v1");
    assert.equal(params.reloadUserConfig, true);
    writes.push(params.edits);
    for (const edit of params.edits) {
      assert.ok(["agents.default_subagent_model", "agents.default_subagent_reasoning_effort"].includes(edit.keyPath));
      const key = edit.keyPath.slice("agents.".length);
      if (edit.value === null) delete config.agents[key];
      else config.agents[key] = edit.value;
    }
    return { status: "ok" };
  });
  const options = { executable, dataDirectory: root };
  assert.equal((await modelContextSettings(options)).defaultSubagentModel, null);
  assert.equal((await modelContextSettings(options)).defaultSubagentReasoningEffort, null);
  const saved = await modelContextSettings(options, contexts, {}, {}, "gpt-child-model", undefined, "high");
  assert.equal(saved.defaultSubagentModel, "gpt-child-model");
  assert.equal(saved.defaultSubagentReasoningEffort, "high");
  assert.equal((await modelContextSettings(options)).defaultSubagentModel, "gpt-child-model");
  assert.equal((await modelContextSettings(options, contexts, {}, {})).defaultSubagentReasoningEffort, "high");
  const reset = await modelContextSettings(options, contexts, {}, {}, "", undefined, "");
  assert.equal(reset.defaultSubagentModel, null);
  assert.equal(reset.defaultSubagentReasoningEffort, null);
  assert.equal((await modelContextSettings(options)).defaultSubagentModel, null);
  assert.equal(config.model, "gpt-parent-model");
  assert.equal(config.agents.max_threads, 4);
  assert.deepEqual(JSON.parse(await readFile(catalogPath)).models.map(model => [model.slug, model.context_window]), [["gpt-child-model", 64000], ["gpt-parent-model", 96000]]);
  assert.deepEqual(writes, [[{ keyPath: "agents.default_subagent_model", value: "gpt-child-model", mergeStrategy: "replace" },
    { keyPath: "agents.default_subagent_reasoning_effort", value: "high", mergeStrategy: "replace" }],
    [{ keyPath: "agents.default_subagent_model", value: null, mergeStrategy: "replace" },
      { keyPath: "agents.default_subagent_reasoning_effort", value: null, mergeStrategy: "replace" }]]);
  await assert.rejects(modelContextSettings(options, contexts, {}, {}, "unknown-model"), /不在当前模型目录/);
  assert.equal(writes.length, 2);
});

test("resetting a native Sol catalog uses 500K and keeps the corrected catalog active", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-context-default-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const model = { slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000, base_instructions: "preserved" };
  const executable = await fixtureCodex(root, [model]);
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: { models: [model] }, contextWindows: { "gpt-6.1-sol": 600000 }, originalCatalog: null, catalogSource: "native",
  }));
  let config = { model_catalog_json: catalogPath, model_provider: "probe", model_providers: { probe: { name: "Probe" } } };
  t.mock.method(CodexAppServer.prototype, "request", async (method, params) => {
    if (method === "config/read") return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
    assert.equal(method, "config/batchWrite");
    config.model_catalog_json = params.edits[0].value;
    return { status: "ok" };
  });
  const options = { executable, dataDirectory: root };
  assert.equal((await modelContextSettings(options)).models[0].contextWindow, 500000);
  const reset = await modelContextSettings(options, {}, {}, {});
  assert.deepEqual(reset.contextWindows, {});
  assert.equal(config.model_catalog_json, catalogPath);
  const generated = JSON.parse(await readFile(catalogPath));
  assert.deepEqual(generated.models[0], { ...model, context_window: 500000, priority: 0 });
  assert.equal((await modelContextSettings(options)).models[0].contextWindow, 500000);
  const preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  const adapter = createUltrafastCatalogAdapter({ ...options, preferencesFile,
    createClient: () => new CodexAppServer({ executable }), report() {},
  });
  t.after(() => adapter.close());
  await adapter.sync();
  assert.equal(JSON.parse(await readFile(catalogPath)).models[0].context_window, 500000);
  assert.ok(JSON.parse(await readFile(catalogPath)).models[0].service_tiers.some(tier => tier.id === "ultrafast"));
  await modelContextSettings(options, { "gpt-6.1-sol": 400000 }, {}, {});
  assert.equal(JSON.parse(await readFile(catalogPath)).models[0].context_window, 400000);
});

test("legacy native defaults refresh on read while explicit Sol overrides stay intact", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-context-legacy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const native = { models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000 }] };
  const executable = path.join(root, "codex");
  await writeFile(executable, JSON.stringify(native));
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: native, contextWindows: { "gpt-6.1-sol": 600000 }, originalCatalog: null,
  }));
  t.mock.method(CodexAppServer.prototype, "request", async method => {
    assert.equal(method, "config/read", "opening settings must not write Codex configuration");
    const config = { model_catalog_json: catalogPath };
    return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
  });
  const result = await modelContextSettings({ executable, dataDirectory: root });
  assert.equal(result.models.find(model => model.slug === "gpt-6.1-sol").contextWindow, 500000);
  assert.equal(result.contextWindows["gpt-6.1-sol"], 600000);
  assert.equal(JSON.parse(await readFile(path.join(root, "model-context.json"))).catalogSource, undefined);
});

test("Sol default correction preserves external catalogs and newer native values", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-context-source-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "model-context-catalog.json");
  const executable = await fixtureCodex(root, [{ slug: "gpt-6.1-sol" }]);
  let config = { model_catalog_json: catalogPath, model_provider: "probe", model_providers: {} };
  t.mock.method(CodexAppServer.prototype, "request", async (method, params) => {
    if (method === "config/read") return { config, layers: [{ name: { type: "user", file: path.join(root, "config.toml") }, version: "v1", config }] };
    assert.equal(method, "config/batchWrite");
    config.model_catalog_json = params.edits[0].value;
    return { status: "ok" };
  });
  for (const source of ["file", "url", "native-new"]) {
    config = { model_catalog_json: catalogPath, model_provider: "probe", model_providers: source === "url" ? { probe: { model_catalog_url: "http://127.0.0.1:9/unused" } } : {} };
    const contextWindow = source === "native-new" ? 544000 : 272000;
    const originalCatalog = source === "file" ? path.join(root, "external.json") : null;
    await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: { models: [{ slug: "gpt-6.1-sol", context_window: contextWindow, max_context_window: 872000 }] }, contextWindows: {}, originalCatalog, catalogSource: source === "native-new" ? "native" : "external",
    }));
    const reset = await modelContextSettings({ executable, dataDirectory: root }, {}, {}, {});
    assert.equal(reset.models[0].contextWindow, contextWindow);
    assert.equal(config.model_catalog_json, originalCatalog);
  }
  config = { model_catalog_json: catalogPath, model_provider: "changed-provider", model_providers: {} };
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({
    catalog: { models: [{ slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000 }] },
    contextWindows: {}, originalCatalog: null, catalogSource: "external",
  }));
  const afterProviderChange = await modelContextSettings({ executable, dataDirectory: root });
  assert.equal(afterProviderChange.models[0].contextWindow, 272000);
  await modelContextSettings({ executable, dataDirectory: root }, { "gpt-6.1-sol": 400000 }, {}, {});
  assert.equal(JSON.parse(await readFile(catalogPath)).models[0].context_window, 400000);
});

test("model discovery reads only the persisted user setting and propagates read failures", async () => {
  for (const value of [undefined, false, true]) {
    const client = { async request(method, params) {
      assert.equal(method, "config/read");
      assert.deepEqual(params, { includeLayers: true });
      return { config: { features: { api_key_model_discovery: true } }, layers: [
        { name: { type: "user", file: "/fixture/config.toml", profile: "other" }, version: "v1", config: { features: { api_key_model_discovery: true } } },
        { name: { type: "user", file: "/fixture/config.toml" }, version: "v1", config: { features: { api_key_model_discovery: value } } },
      ] };
    } };
    assert.equal(await readModelDiscovery(client), value ?? null);
  }
  await assert.rejects(readModelDiscovery({ async request() { throw new Error("read failed"); } }), /read failed/);
  await assert.rejects(readModelDiscovery({ async request() { return { layers: [] }; } }), /无法定位/);
});

test("catalog preserves native metadata and only adds supported Ultrafast models", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "custom-alias", "GPT-6 Astra", "GPT-6.1 Sol", "gpt-6.2-astra", "gpt-6.2-sol", "GPT-6.2 Astra", "GPT-6.2 Sol"].map(slug => ({
    slug, base_instructions: 'Native instructions with a quoted brace: "}"', service_tiers: [{ id: "priority" }],
  }));
  const original = { models, extra: "preserved" };
  const binary = path.join(root, "codex");
  await writeFile(binary, Buffer.concat([Buffer.from([0, 255]), Buffer.from(JSON.stringify(original)), Buffer.from([0])]));
  assert.deepEqual(await readBundledModelCatalog(binary), original);
  const patched = withUltrafastCatalog(original);
  assert.equal(patched.extra, original.extra);
  assert.equal(patched.models[0].base_instructions, models[0].base_instructions);
  assert.deepEqual(patched.models.map(m => m.service_tiers.some(tier => tier.id === "ultrafast")), [true, true, false, false, true, true, true, true, true, true]);
  assert.deepEqual(patched.models.map(model => model.slug), models.map(model => model.slug));
  assert.ok(patched.models.every(model => model.service_tiers.some(tier => tier.id === "priority")));
  assert.equal(original.models[0].service_tiers.length, 1);
  assert.deepEqual(withUltrafastCatalog(patched), patched);
});

test("provider catalog preserves an existing endpoint and restores only its own config field", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-catalog-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  const executable = path.join(root, "codex");
  const native = { slug: "gpt-6-astra", service_tiers: [], default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] };
  await writeFile(executable, JSON.stringify({ models: [native] }));
  let authorization;
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ models: [
      { slug: "gpt-6-astra", base_instructions: "custom instructions", service_tiers: [], default_reasoning_level: null, supported_reasoning_levels: [] },
      { slug: "claude-opus-5" }, { slug: "gpt-provider-only" },
    ] }));
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
  assert.deepEqual(catalog.models.map(model => model.slug), ["gpt-6-astra"]);
  assert.equal(catalog.models[0].base_instructions, "custom instructions");
  assert.equal(catalog.models[0].default_reasoning_level, "low");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, native.supported_reasoning_levels);
  assert.deepEqual(catalog.models[0].service_tiers.map(t => t.id), ["priority", "ultrafast"]);
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
  assert.deepEqual((await (await fetch(url)).json()).models[0].service_tiers.map(t => t.id), ["priority", "ultrafast"]);
});

test("official Ultrafast preserves native auth catalogs and restores owned global paths", async t => {
  for (const [mode, explicit, external] of [["chatgpt", false, false], ["apiKey", true, false], ["chatgpt", true, true]]) {
    await t.test(`${mode} ${external ? "external catalog" : explicit ? "explicit openai" : "default provider"}`, async t => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-official-ultrafast-")));
      t.after(() => rm(root, { recursive: true, force: true }));
      const source = { models: [
        { slug: "gpt-6-astra", base_instructions: "original instructions", extra: { capability: true },
          service_tiers: [{ id: "priority", name: "Existing Fast", description: "keep this" }] },
        { slug: "gpt-other", service_tiers: [] },
      ] };
      const executable = await fixtureCodex(root, source.models);
      const preferencesFile = path.join(root, "preferences.json"), configFile = path.join(root, "config.toml");
      await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
      await writeFile(configFile, "");
      const original = path.join(root, "original-catalog.json");
      if (external) await writeFile(original, JSON.stringify(source));
      const userConfig = { auth_mode: mode, cli_auth_credentials_store: "keyring", unrelated: "keep",
        ...(explicit ? { model_provider: "openai" } : {}), ...(external ? { model_catalog_json: original } : {}) };
      const before = structuredClone(userConfig);
      const options = { executable, dataDirectory: root, preferencesFile, report() {},
        processEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, TMPDIR: root },
        createClient: () => ({ close() {}, async request(method, params) {
          if (method === "config/read") return { config: userConfig, layers: [{ name: { type: "user", file: configFile }, version: "v1", config: userConfig }] };
          assert.equal(method, "config/batchWrite", "official catalog must not read or change login credentials");
          for (const edit of params.edits) {
            assert.equal(edit.keyPath, "model_catalog_json");
            if (edit.value === null) delete userConfig.model_catalog_json;
            else userConfig.model_catalog_json = edit.value;
          }
          return { status: "ok" };
        } }),
      };
      t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network request"); });
      let adapter = createUltrafastCatalogAdapter(options);t.after(() => adapter.close());
      await adapter.sync();const generated = userConfig.model_catalog_json;
      assert.notEqual(generated, original);assert.equal(userConfig.model_providers, undefined);
      assert.equal(userConfig.model_provider, before.model_provider);assert.equal(userConfig.auth_mode, mode);
      assert.deepEqual(JSON.parse(await readFile(generated)), withUltrafastCatalog(source));
      if (external) assert.deepEqual(JSON.parse(await readFile(original)), source);
      await adapter.close();adapter = createUltrafastCatalogAdapter(options);await adapter.sync();
      await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));await adapter.sync();
      assert.deepEqual(userConfig, before);assert.deepEqual(JSON.parse(await readFile(generated)), source);
      await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));await adapter.sync();
      assert.deepEqual(JSON.parse(await readFile(generated)), withUltrafastCatalog(source));
      userConfig.model_catalog_json = original;
      await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));await adapter.sync();
      assert.equal(userConfig.model_catalog_json, original, "closing must preserve a user replacement");
    });
  }
});

test("official managed context catalog keeps its original source while Ultrafast toggles", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-official-context-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { models: [{ slug: "gpt-6-astra", context_window: 128000, base_instructions: "source", service_tiers: [] }] };
  const executable = await fixtureCodex(root, source.models), preferencesFile = path.join(root, "preferences.json");
  const configFile = path.join(root, "config.toml"), catalogPath = path.join(root, "model-context-catalog.json");
  await writeFile(configFile, "");await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: true }));
  await writeFile(catalogPath, JSON.stringify(source));
  await writeFile(path.join(root, "model-context.json"), JSON.stringify({ catalog: source, originalCatalog: null,
    catalogSource: "native", contextWindows: { "gpt-6-astra": 96000 } }));
  const config = { model_catalog_json: catalogPath };
  const request = async method => {
    assert.equal(method, "config/read", "existing Panel context path must not change");
    return { config, layers: [{ name: { type: "user", file: configFile }, version: "v1", config }] };
  };
  t.mock.method(CodexAppServer.prototype, "request", request);
  const options = { executable, dataDirectory: root, preferencesFile, cwd: root,
    processEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root }, createClient: () => ({ request, close() {} }) };
  const adapter = createUltrafastCatalogAdapter(options);t.after(() => adapter.close());
  await adapter.sync();await modelContextSettings(options, { "gpt-6-astra": 96000 }, {}, {});
  let generated = JSON.parse(await readFile(catalogPath));
  assert.equal(generated.models[0].context_window, 96000);assert.ok(generated.models[0].service_tiers.some(t => t.id === "ultrafast"));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "model-context.json"))).catalog, source);
  await writeFile(preferencesFile, JSON.stringify({ customProviderUltrafast: false }));await adapter.sync();
  generated = JSON.parse(await readFile(catalogPath));assert.equal(generated.models[0].context_window, 96000);assert.deepEqual(generated.models[0].service_tiers, []);
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
test("real Codex main model list uses official efforts and numeric order with explicit effort requests", {
  skip: !process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE,
  timeout: 60_000,
}, async t => {
  const executable = process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-main-model-core-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), home = path.join(root, "home"), codexHome = path.join(root, "codex"), dataDirectory = path.join(root, "panel");
  await Promise.all([workspace, home, codexHome, dataDirectory].map(directory => mkdir(directory)));
  const processEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: root, OTEL_SDK_DISABLED: "true" };
  const official = await readBundledModelCatalog(executable);
  const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-sol"].map((slug, priority) => {
    const model = official.models.find(model => model.slug === slug);
    assert.ok(model, `the supplied CLI must include ${slug}`);
    return { ...model, priority, default_reasoning_level: null, supported_reasoning_levels: [] };
  });
  const source = { models: [...models, { slug: "gpt-image-1", supported_reasoning_levels: [] }] };
  const bodies = [];
  const api = createServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1/models?")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(source));
      return;
    }
    assert.equal(request.url, "/v1/responses");
    let text = ""; for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.setHeader("Content-Type", "text/event-stream");
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
      id: `resp_main_${bodies.length}`, object: "response", created_at: 0, status: "completed", model: "gpt-6.1-sol", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } })}\n\n`);
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => { api.closeAllConnections(); api.close(); });
  const catalogPath = path.join(dataDirectory, "model-context-catalog.json"), configFile = path.join(codexHome, "config.toml");
  await writeFile(catalogPath, JSON.stringify({ models }));
  await writeFile(path.join(dataDirectory, "model-context.json"), JSON.stringify({ catalog: source,
    contextWindows: {}, originalCatalog: null, catalogSource: "external", selectedModels: models.map(model => model.slug) }));
  await writeFile(configFile, `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n[features]\napi_key_model_discovery = true\n[model_providers.probe]\nname = "Local main-model test only"\nbase_url = "http://127.0.0.1:${api.address().port}/v1"\nwire_api = "responses"\nexperimental_bearer_token = "fixture-token"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const beforeClient = new CodexAppServer({ executable, processEnv, cwd: workspace });
  try {
    const before = await beforeClient.request("model/list", { includeHidden: true });
    assert.deepEqual(before.data.find(model => model.model === "gpt-6.1-sol").supportedReasoningEfforts, []);
  } finally { await beforeClient.close(); }
  const settings = await modelContextSettings({ executable, processEnv, cwd: workspace, dataDirectory, refreshCatalog: true });
  assert.equal(settings.catalogChanged, true);
  const client = new CodexAppServer({ executable, processEnv, cwd: workspace });
  t.after(() => client.close());
  const listing = await client.request("model/list", { includeHidden: true });
  assert.deepEqual(listing.data.map(model => model.model), ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-astra"]);
  const sol = listing.data.find(model => model.model === "gpt-6.1-sol");
  assert.equal(sol.defaultReasoningEffort, "low");
  assert.deepEqual(sol.supportedReasoningEfforts.map(level => level.reasoningEffort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  const { thread } = await client.startThread({ cwd: workspace, model: sol.model, modelProvider: "probe", approvalPolicy: "never", sandbox: "read-only" });
  for (const effort of ["high", "max"]) {
    let unsubscribe, timer;
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Local main-model turn timed out")), 10_000);
      unsubscribe = client.subscribe(event => { if (event.method === "turn/completed") resolve(); });
    });
    try {
      await client.startTurn({ threadId: thread.id, model: sol.model, effort, input: [{ type: "text", text: "Reply OK. Do not use tools." }] });
      await completed;
      assert.equal(bodies.at(-1).reasoning.effort, effort);
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  assert.equal(parse(await readFile(configFile, "utf8")).model_reasoning_effort, "ultra");
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, "model-context.json"))).catalog, source);
});

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
  await setModelDiscovery(client, true);
  assert.equal(parse(await readFile(configFile, "utf8")).features.api_key_model_discovery, true);
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
  await setModelDiscovery(client, false);
  const removed = parse(await readFile(configFile, "utf8"));
  assert.equal(removed.features?.api_key_model_discovery, undefined);
  assert.equal(removed.model_provider, "probe");
  assert.equal(removed.model_providers.probe.name, "Local test only");
});

test("real OpenAI default and explicit providers load and restore managed Ultrafast catalogs", {
  skip: !process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE,
  timeout: 60_000,
}, async t => {
  const executable = process.env.CODEX_PANEL_TEST_CODEX_EXECUTABLE;
  for (const explicit of [false, true]) await t.test(explicit ? "explicit openai" : "default openai", async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-official-core-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace=path.join(root,"workspace"), home=path.join(root,"home"), codexHome=path.join(root,"codex"), dataDirectory=path.join(root,"data");
    await Promise.all([workspace,home,codexHome,dataDirectory].map(directory=>mkdir(directory)));
    const api=createServer((request,response)=>{response.writeHead(502).end("external requests are disabled");});
    api.on("connect",(_request,socket)=>socket.destroy());
    api.listen(0,"127.0.0.1");await once(api,"listening");
    t.after(()=>{api.closeAllConnections();api.close();});
    const origin=`http://127.0.0.1:${api.address().port}`;
    const processEnv={PATH:process.env.PATH,HOME:home,USERPROFILE:home,CODEX_HOME:codexHome,TMPDIR:root,OTEL_SDK_DISABLED:"true",
      OPENAI_API_KEY:"fixture-local-only",HTTP_PROXY:origin,HTTPS_PROXY:origin,ALL_PROXY:origin,NO_PROXY:"127.0.0.1,localhost,::1"};
    const configFile=path.join(codexHome,"config.toml"), preferencesFile=path.join(root,"preferences.json");
    // 不发起推理；本机拒绝代理同时阻断 CLI 的后台外网检查。
    const original=`model = "gpt-6-astra"\n${explicit?'model_provider = "openai"\n':''}cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n[features]\napi_key_model_discovery = false\n`;
    await writeFile(configFile,original);
    await writeFile(path.join(codexHome,"auth.json"),JSON.stringify({auth_mode:"apikey",OPENAI_API_KEY:"fixture-local-only"}));
    const authBefore=await readFile(path.join(codexHome,"auth.json"),"utf8");
    await writeFile(preferencesFile,JSON.stringify({customProviderUltrafast:true}));
    const createClient=()=>new CodexAppServer({executable,processEnv,cwd:workspace});
    const adapter=createUltrafastCatalogAdapter({executable,processEnv,cwd:workspace,dataDirectory,preferencesFile,createClient,report(){}});
    t.after(()=>adapter.close());await adapter.sync();
    const client=createClient();t.after(()=>client.close());
    const listing=await client.request("model/list",{includeHidden:true});
    assert.ok(listing.data.find(model=>model.model==="gpt-6-astra").serviceTiers.some(tier=>tier.id==="ultrafast"));await client.close();
    const active=parse(await readFile(configFile,"utf8"));assert.equal(active.model_provider,explicit?"openai":undefined);assert.equal(active.model_providers,undefined);
    await writeFile(preferencesFile,JSON.stringify({customProviderUltrafast:false}));await adapter.sync();
    assert.equal(parse(await readFile(configFile,"utf8")).model_catalog_json,undefined);
    assert.equal(await readFile(path.join(codexHome,"auth.json"),"utf8"),authBefore);
    assert.deepEqual(parse(await readFile(configFile,"utf8")),parse(original));
  });
});

test("supported catalog models receive both speed tiers without duplicating existing metadata", () => {
  const fast = {id: "priority", name: "Custom Fast"};
  const catalog = {models: [{slug: "GPT-6 Astra", service_tiers: []}, {slug: "gpt-6.1-sol", service_tiers: [fast]}]};
  const result = withUltrafastCatalog(catalog);
  assert.deepEqual(result.models[0].service_tiers.map(t => t.id), ["priority", "ultrafast"]);
  assert.equal(result.models[1].service_tiers[0], fast);
  assert.deepEqual(withUltrafastCatalog(result), result);
});
