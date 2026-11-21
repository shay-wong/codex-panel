import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const select = vm.runInNewContext(`${source.slice(source.indexOf("function isCodexTarget("), source.indexOf("export async function waitForRendererReady("))}; isCodexTarget`, {URL});

test("detached ChatGPT windows cannot displace the main Codex renderer", () => {
  const target = url => ({type:"page",title:"ChatGPT",url});
  assert.equal(select(target("app://-/detached-window.html?initialRoute=%2Fdetached-window")), false);
  assert.equal(select(target("app://-/detached-window.html")), false);
  assert.equal(select(target("app://-/index.html?initialRoute=/detached-window")), false);
  assert.equal(select(target("app://-/index.html?initialRoute=%2Favatar-overlay")), false);
  assert.equal(select(target("app://-/index.html?initialRoute=%2Fglobal-dictation")), false);
  assert.equal(select(target("app://-/index.html")), true);
  assert.equal(select(target("app://-/index.html?initialRoute=%2Fthreads%2Ftest")), true);
});

test("standalone and prewarmed Page windows are excluded without excluding main-window Pages", () => {
  const target = url => ({ type: "page", title: "ChatGPT", url });
  for (const suffix of ["&prewarm=1", "&start=1", ""]) {
    const route = `/space/local-page-fixture?window=page${suffix}`;
    assert.equal(select(target(`app://-/index.html?initialRoute=${encodeURIComponent(route)}`)), false);
  }
  assert.equal(select(target("app://-/space/local-page-fixture?window=page")), false);
  assert.equal(select(target(`app://-/index.html?initialRoute=${encodeURIComponent("/space/local-page-fixture")}`)), true);
  assert.equal(select(target("app://-/index.html")), true);
});

test("TCP and pipe discover avatar windows separately from Panel windows", async () => {
  const targets = [
    { id: "main", targetId: "main", type: "page", title: "ChatGPT", url: "app://-/index.html" },
    { id: "pet", targetId: "pet", type: "page", title: "ChatGPT", url: "app://-/index.html?initialRoute=%2Favatar-overlay" },
    { id: "page", targetId: "page", type: "page", title: "ChatGPT", url: "app://-/space/fixture?window=page" },
  ];
  const selectors = source.slice(source.indexOf("async function codexTargets("), source.indexOf("export async function waitForRendererReady("));
  const runtimes = source.slice(source.indexOf("function tcpCdpRuntime("), source.indexOf("function codexDebuggingPorts("));
  const { tcpCdpRuntime, pipeCdpRuntime } = vm.runInNewContext(`${selectors}\n${runtimes}; ({ tcpCdpRuntime, pipeCdpRuntime })`, {
    URL, fetchJson: async () => targets, validatedLoopbackCdpWebSocketUrl: url => url,
  });
  for (const runtime of [tcpCdpRuntime(9229), pipeCdpRuntime({ targets: async () => targets })]) {
    assert.equal((await runtime.targets()).map(target => target.id).join(","), "main");
    assert.equal((await runtime.avatarTargets()).map(target => target.id).join(","), "pet");
  }
});

test("avatar injection handles late windows and reconnects without mounting Panel", async () => {
  const { reconcileInjectionRuntime } = await import("../scripts/codex-injector-runtime.mjs");
  const start = source.indexOf("async function readAvatarInjectionStatus(");
  const end = source.indexOf("async function prepareNativeAdapters(", start);
  let page = vm.createContext({}), registeredSource = "", registration = 0, reloads = 0, connects = 0;
  let targets = [];
  const commands = [], preparations = [];
  const events = new Map();
  const connections = new Map();
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectAvatarTargets`, {
    console: { error() {} }, path,
    waitForRendererReady: async () => {},
    readPetAnimations: async () => [{ petId: "fixture" }],
    panelDataDirectory: "/fixture/data",
    panelEnvironment: () => undefined,
    prepareCodexRspack: async (...args) => {
      preparations.push(args);
      return { prepared: { pets: true }, source: "globalThis.__codexPanelRspack__={};globalThis.__codexPanelPetAnimations__={};" };
    },
    reconcileInjectionRuntime,
    registerInjectionSource: async (_cdp, text) => { registeredSource = text; return String(++registration); },
    reloadRenderer: async () => { reloads++; page = vm.createContext({}); vm.runInContext(registeredSource, page); },
    evaluateInjectionSource: async (_cdp, text) => vm.runInContext(text, page),
  });
  const runtime = {
    avatarTargets: async () => targets,
    connect: async () => {
      connects++;
      return {
        closed: false,
        on(name, handler) { events.set(name, handler); },
        close() { this.closed = true; },
        send: async (method, params) => {
          commands.push(method);
          return method === "Runtime.evaluate"
            ? { result: { value: vm.runInContext(params.expression, page) } }
            : {};
        },
      };
    },
  };
  const run = (hash = "first") => inject(runtime, hash, connections, "/fixture/ChatGPT.app", true);
  assert.equal((await run()).length, 0);
  targets = [{ id: "pet", url: "app://-/index.html?initialRoute=%2Favatar-overlay" }];
  assert.equal((await run()).length, 1);
  assert.equal(connections.size, 1);
  assert.equal(reloads, 1);
  connections.get("pet").petAnimationsRevision = "old";
  connections.get("pet").petSoundsEnabled = false;
  events.get("Page.loadEventFired")();
  assert.equal(connections.get("pet").petAnimationsRevision, undefined);
  assert.equal(connections.get("pet").petSoundsEnabled, undefined);
  assert.equal((await run()).length, 0);
  assert.equal(connects, 1);
  connections.get("pet").close();
  assert.equal((await run()).length, 1);
  assert.equal(reloads, 1, "the existing bootstrap survives an injector reconnect");
  assert.equal((await run("updated")).length, 1);
  assert.equal(reloads, 2, "a changed source installs the new bootstrap");
  const retained = connections.get("pet");
  targets = [];
  assert.equal((await run("updated")).length, 0);
  assert.equal(connections.size, 0);
  assert.equal(retained.closed, true);
  assert.equal(page.__codexPanelPetAnimationsInjectionHash__, "updated");
  assert.equal(page.__codexPanelInjection__, undefined);
  assert.equal(page.__CODEX_PANEL_HOST_CAPABILITY__, undefined);
  assert.equal(commands.includes("Runtime.addBinding"), false);
  assert.equal(commands.filter(command => command === "Page.removeScriptToEvaluateOnNewDocument").length, 2);
  assert(preparations.every(([, appPath, preferences, , options]) => appPath === "/fixture/ChatGPT.app" && preferences === undefined && options.petsOnly && options.petAnimations[0].petId === "fixture"));
  assert(preparations.every(([, , , , options]) => options.cacheDirectory === path.join("/fixture/data", "codex-adapters")));
  assert(preparations.every(([, , , , options]) => !Object.hasOwn(options, "adapterRevision")), "runtime updates leave adaptation identity to its planners");
});

test("stopping during avatar preparation closes its pending connection and cannot retain it later", async () => {
  const start = source.indexOf("async function readAvatarInjectionStatus(");
  const end = source.indexOf("async function prepareNativeAdapters(", start);
  let finish, notify;
  const pending = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { notify = resolve; });
  const cdp = { closed: false, on() {}, close() { this.closed = true; }, async send() {
    if (this.closed) throw new Error("CDP closed");
    return {};
  } };
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectAvatarTargets`, {
    console: { error() {} }, path, panelDataDirectory: "/fixture/data", panelEnvironment: () => undefined,
    waitForRendererReady: async () => {}, readPetAnimations: async () => [],
    prepareCodexRspack: async () => { notify(); await pending; return { prepared: { pets: true }, source: "// pet" }; },
  });
  const connections = new Map();
  const runtime = { avatarTargets: async () => [{ id: "pet" }], connect: async () => cdp };
  const run = inject(runtime, "current", connections, "/fixture/ChatGPT.app", true);
  await started;
  assert.equal(connections.get("pet"), cdp, "cleanup owns CDP before preparation completes");
  connections.forEach(connection => connection.close());
  connections.clear();
  finish();
  assert.equal((await run).length, 0);
  assert.equal(connections.size, 0);
  assert.equal(cdp.closed, true);
  const late = { ...cdp, closed: false };
  assert.equal((await inject({ ...runtime, connect: async () => late }, "current", connections, "/fixture/ChatGPT.app", true, () => false)).length, 0);
  assert.equal(late.closed, true, "a connection opening after shutdown is immediately closed");
});

test("imported pet packs and sound preferences update both windows without reloading animations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-pet-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "pet-animations"), index = path.join(directory, "index.json");
  await mkdir(directory);
  await writeFile(index, "[]");
  let packs = [], reads = 0, preferencesFile;
  const start = source.indexOf("async function syncPetAnimations(");
  const end = source.indexOf("async function prepareNativeAdapters(", start);
  const sync = vm.runInNewContext(`${source.slice(start, end)}; syncPetAnimations`, {
    stat, path, console, readFile,
    panelEnvironment: key => { assert.equal(key, "PREFERENCES_FILE"); return preferencesFile; },
    readPetAnimations: async dataDirectory => { assert.equal(dataDirectory, root); reads++; return packs; },
  });
  const commands = [];
  const connections = ["main", "avatar"].map(name => {
    const page = vm.createContext({ __codexPanelPetAnimations__: {
      packUpdates: 0, soundUpdates: 0,
      setPacks(next) { this.packs = next; this.packUpdates++; },
      setSoundEnabled(enabled) { this.soundEnabled = enabled; this.soundUpdates++; },
    } });
    return { name, page, send: async (method, params) => {
      commands.push(method);
      return { result: { value: vm.runInContext(params.expression, page) } };
    } };
  });
  await sync(root, connections);
  assert.equal(reads, 1);
  for (const connection of connections) assert.equal(connection.page.__codexPanelPetAnimations__.soundEnabled, true);
  await sync(root, connections);
  assert.equal(reads, 1, "unchanged registrations need no resource reread");
  preferencesFile = path.join(root, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({ petSounds: false }));
  await sync(root, connections);
  assert.equal(reads, 1, "muting does not reread or restart the current animation");
  for (const connection of connections) {
    const runtime = connection.page.__codexPanelPetAnimations__;
    assert.equal(runtime.soundEnabled, false);
    assert.equal(runtime.soundUpdates, 2);
    assert.equal(runtime.packUpdates, 1);
  }
  await sync(root, connections);
  for (const connection of connections) assert.equal(connection.page.__codexPanelPetAnimations__.soundUpdates, 2);
  packs = [{ petId: "imported", spritesheetUrl: "data:image/png;base64,fixture" }];
  await writeFile(index, JSON.stringify([{ petId: "imported" }]));
  await sync(root, connections);
  assert.equal(reads, 2, "one resource read supplies all live windows");
  for (const connection of connections) assert.equal(connection.page.__codexPanelPetAnimations__.packs[0].petId, "imported");
  connections[1].petAnimationsRevision = undefined;
  await sync(root, connections);
  assert.equal(reads, 3, "a reloaded document receives the current resources");
  packs = [];
  await rm(index);
  await sync(root, connections);
  for (const connection of connections) assert.equal(connection.page.__codexPanelPetAnimations__.packs.length, 0);
  assert.equal(commands.every(method => method === "Runtime.evaluate"), true);
});

test("unmounted entries never report successful injection", async () => {
  const start = source.indexOf("async function prepareNativeAdapters(");
  const end = source.indexOf("async function injectAll(", start);
  for (const attachExisting of [true, false]) {
    let closed = false;
    const cdp = {send:async () => ({}),on(){},close(){closed=true;}};
    const inject = vm.runInNewContext(`${source.slice(start,end)}; injectTarget`, {
      installPanelHostBinding:()=>({install:async()=>{},publishHeartbeat:async()=>{}}),
      path, panelDataDirectory: "/fixture/data",
      prepareCodexRspack:async()=>null,
      waitForRendererReady:async()=>{},prepareCodexProviderQuotaFix:async()=>"",panelEnvironment:()=>null,
      prepareNativeAdapters:async()=>({source:"",threadTabsPrepared:false}),
      prepareCodexProviderUltrafast:async()=>[],
      prepareCodexDotEntry:async(_cdp,modules)=>({modules,prepared:false}),
      prepareCodexThreadTabs:async(_cdp,modules)=>modules,
      readInjectionStatus:async()=>({}),reconcileInjectionRuntime:async()=>({scriptIdentifier:"1",shouldRemainOpen:false}),
      waitForInjectionStatus:async()=>({entryMounted:false,sourceHash:"current",frameUrl:null}),
      registerInjectionSource:async()=>"1",reloadRenderer:async()=>{},evaluateInjectionSource:async()=>{},
      publishInjectionScriptIdentifier:async()=>{},unregisterQuotaPolicyCdp(){},
    });
    await assert.rejects(inject({connect:async()=>cdp},{},"source","current",false,null,true,{},attachExisting,"token",()=>{},()=>{},()=>{}), /入口尚未挂载/);
    assert.equal(closed,true);
  }
});

test("an unavailable secondary window cannot hide a connected main window", async () => {
  const start = source.indexOf("async function injectAll(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  const connected = { closed: false, close() {} };
  for (const ids of [["unavailable", "main"], ["main", "unavailable"]]) {
    const inject = vm.runInNewContext(`${source.slice(start, end)}; injectAll`, {
      injectTarget: async (_runtime, target) => {
        if (target.id === "unavailable") throw new Error("entry not mounted");
        return { result: { entryMounted: true }, connection: connected };
      },
      unregisterQuotaPolicyCdp() {}, console: { error() {} }, URL,
    });
    const connections = new Map();
    const runtime = { targets: async () => ids.map(id => ({ id })) };
    const run = () => inject(runtime, "source", "hash", false, null, connections, true, {}, true, "token", () => {}, () => {}, () => {});
    assert.equal((await run()).length, 1);
    assert.equal(connections.get("main"), connected);
    assert.equal((await run()).length, 0, "retrying another window must retain the connected main window");
    runtime.targets = async () => [{ id: "unavailable" }];
    await assert.rejects(run(), /entry not mounted/, "losing every main window must still report unavailable");
  }
});

async function adapterHarness(prepare, initial = {}) {
  const { reconcileInjectionRuntime } = await import("../scripts/codex-injector-runtime.mjs");
  const start = source.indexOf("async function prepareNativeAdapters(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  const createPage = values => {
    const context = vm.createContext(values);
    context.window = context;
    return context;
  };
  let page = createPage(initial), registeredSource = "", registration = 0, now = 0;
  const events = new Map(), published = [], statuses = [], live = [], logs = [];
  const result = { reloads: 0, preparations: 0 };
  const status = () => ({ sourceHash: page.panelHash, entryMounted: page.entry === true, pageVisible: false,
    scriptIdentifier: String(registration), nativeAdaptersRevision: page.__codexPanelNativeAdaptersRevision__,
    nativeAdaptersPrepared: page.__codexPanelNativeAdaptersPrepared__ ?? page.__codexPanelRspack__?.prepared ?? {} });
  const cdp = { closed: false, send: async () => ({}), on: (event, callback) => events.set(event, callback), close() { this.closed = true; } };
  const injectAll = vm.runInNewContext(`${source.slice(start, end)}; injectAll`, {
    Date: { now: () => now }, URL, path, Buffer, writeFile, console: { error: message => logs.push(message) },
    panelDataDirectory: "/fixture/data", readPetAnimations: async () => [], panelEnvironment: () => undefined,
    installPanelHostBinding: () => ({ install: async () => {}, publishHeartbeat: async () => {} }),
    prepareCodexRspack: async (_cdp, appPath, _preferences, _report, options) => {
      result.preparations++;
      assert.equal(appPath, "/fixture/ChatGPT.app");
      assert.equal(options.cacheDirectory, path.join("/fixture/data", "codex-adapters"));
      assert.equal(Object.hasOwn(options, "adapterRevision"), false, "Panel runtime code does not determine adaptation identity");
      return prepare(options, result.preparations);
    },
    applyCodexRspackFeature: async (_cdp, plan) => { live.push(plan); return Object.keys(plan.nativeServices ?? {}).length ? ["nativeServices"] : []; },
    waitForRendererReady: async () => {}, readInjectionStatus: async () => status(), reconcileInjectionRuntime,
    registerInjectionSource: async (_cdp, text) => { registeredSource = text; return String(++registration); },
    reloadRenderer: async () => { result.reloads++; page = createPage({}); vm.runInContext(registeredSource, page); await events.get("Page.loadEventFired")?.(); },
    evaluateInjectionSource: async (_cdp, text) => vm.runInContext(text, page),
    publishInjectionScriptIdentifier: async (_cdp, identifier) => published.push(identifier),
    waitForInjectionStatus: async () => status(), unregisterQuotaPolicyCdp() {},
    emitLauncherEvent: (event, details) => statuses.push(JSON.parse(JSON.stringify({ event, ...details }))),
  });
  const connections = new Map();
  const runtime = { targets: async () => [{ id: "main" }], connect: async () => cdp };
  return { ...result, result, cdp, live, logs, events, published, statuses, connections,
    source: () => registeredSource, advance: value => { now = value; },
    run: (screenshotPath = null, attachExisting = true) => injectAll(runtime, 'globalThis.panelHash="current";globalThis.entry=true;', "current", false, screenshotPath, connections, true, {}, attachExisting, "token", () => {}, () => {}, () => {}, "/fixture/ChatGPT.app"),
  };
}

function adapterResult(prepared, errors = {}) {
  return { source: `globalThis.__codexPanelRspack__={prepared:${JSON.stringify(prepared)}};`, prepared, errors };
}

test("a newly launched watched window writes its requested screenshot and releases the connection on write failure", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-watch-screenshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const harness = await adapterHarness(async () => adapterResult({ tabs: true }));
  harness.cdp.send = async (method, params) => {
    if (method !== "Page.captureScreenshot") return {};
    assert.equal(params.format, "png");
    return { data: pngHeader.toString("base64") };
  };
  const filename = path.join(directory, "main.png");
  const [result] = await harness.run(filename, false);
  assert.equal(result.screenshot, filename);
  assert.deepEqual(await readFile(filename), pngHeader);
  await harness.cdp.nativeAdaptersTask;
  harness.connections.clear();
  await assert.rejects(harness.run(path.join(directory, "missing", "main.png"), false), { code: "ENOENT" });
  assert.equal(harness.cdp.closed, true);
  assert.equal(harness.connections.size, 0);
});

test("the status control preserves a controlled reload when CDP loses its execution context", async () => {
  const start = source.indexOf("          status: async () => {");
  const end = source.indexOf("          open: async () => {", start);
  const lostContext = new Error("Execution context was destroyed");
  let applying = true;
  const query = vm.runInNewContext(`({${source.slice(start, end)}}).status`, {
    cdpRuntime: {}, sourceHash: "current", options: { startupToken: "fixture" },
    applyingNativeAdapters: () => applying,
    inspectRuntimeInjectionReadiness: async () => { throw lostContext; },
  });
  assert.deepEqual({ ...await query() }, { ready: false, applyingNativeAdapters: true });
  applying = false;
  await assert.rejects(query(), error => error === lostContext);
});

test("Panel connects before adaptation, publishes feature progress, and applies successes with one final reload", async () => {
  let finish, options;
  const pending = new Promise(resolve => { finish = resolve; });
  const harness = await adapterHarness(async progress => { options = progress; return pending; });
  assert.equal((await harness.run()).length, 1);
  assert.equal(harness.connections.get("main"), harness.cdp);
  assert.equal(harness.result.reloads, 0, "base connection must not reload while adaptation is pending");
  await Promise.resolve();
  options.onProgress({ phase: "read", asset: "fixture.js", completed: 2, total: 4 });
  assert.equal(harness.statuses.at(-1).progress, 50);
  options.onProgress({ phase: "adapt", feature: "quota", moduleId: "provider", completed: 2, total: 10, percent: 12.5 });
  options.onProgress({ phase: "adapt", feature: "tabs", moduleId: "workspace", completed: 3, total: 10, percent: 20 });
  const progress = harness.statuses.at(-1);
  assert.equal(progress.event, "nativeAdaptersStatus");
  assert.equal(progress.progress, 20, 'the worker aggregate takes priority over one module’s progress');
  assert.equal(progress.features.length, 2, "parallel modules retain their separate progress");
  assert.match(progress.features[0].message, /2\/10.*provider/);
  options.onFeaturePrepared({ feature: "nativeServices", plan: { prepared: {}, errors: {}, nativeServices: { desktopServices: { id: "services", exportName: "app" } } } });
  assert(harness.statuses.at(-1).features.some(feature => feature.feature === "nativeServices" && feature.phase === "prepared"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.live.length, 1, "services become available before the entire plan finishes");
  assert(harness.statuses.some(status => status.features.some(feature => feature.feature === "nativeServices" && feature.phase === "ready")));
  assert.equal(harness.statuses.at(-1).progress, 20, 'feature notifications preserve the aggregate');
  options.onProgress({ phase: "compose", completed: 1, total: 4 });
  assert.equal(harness.statuses.at(-1).progress, 25);
  options.onProgress({ phase: "write" });
  assert.equal(harness.statuses.at(-1).progress, null, 'unmeasured stages use an activity indicator');
  assert.equal(harness.result.reloads, 0);
  finish(adapterResult({ quota: true, tabs: false, pets: true }, { tabs: "Native thread factory missing" }));
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.reloads, 1, "all completed patches share one final reload even when tabs fail");
  assert.equal(harness.cdp.threadTabsPhase, "failed");
  assert.equal(harness.statuses.at(-1).phase, "partial");
  assert.equal(harness.statuses.at(-1).progress, null);
  assert(harness.statuses.at(-1).features.some(feature => feature.feature === "quota" && feature.phase === "ready"));
  assert.equal(harness.statuses.some(status => status.event === "waitingForCodex"), false);
});

test("reconnecting to an already adapted version reuses the document without another reload", async () => {
  const prepared = { quota: true, tabs: true };
  const harness = await adapterHarness(async () => adapterResult(prepared), {
    __codexPanelNativeAdaptersRevision__: "current", __codexPanelRspack__: { prepared },
  });
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.preparations, 1);
  assert.equal(harness.result.reloads, 0);
  assert.equal(harness.cdp.retryThreadTabs, null);
  assert.equal(harness.statuses.at(-1).phase, "ready");
});

test("legacy ESM adapters retain their successful readiness across reconnection", async () => {
  const prepared = { quota: false, tabs: true, dot: true };
  const harness = await adapterHarness(async () => ({ source: "// ESM adapters without Rspack runtime", prepared, errors: {} }));
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.reloads, 1);
  harness.connections.clear();
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.reloads, 1, "ESM readiness uses the common installed snapshot");
});

test("the third automatic retry stays loading until its actual result is known", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const harness = await adapterHarness(async (_options, attempt) => attempt < 4
    ? adapterResult({ tabs: false }, { tabs: "missing" }) : pending);
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  for (const now of [5_000, 10_000]) {
    harness.advance(now);
    await harness.run();
    await harness.cdp.nativeAdaptersTask;
  }
  harness.advance(15_000);
  await harness.run();
  assert.equal(harness.cdp.threadTabsRetries, 3);
  assert.equal(harness.cdp.threadTabsPhase, "loading");
  assert.equal(harness.logs.some(log => log.includes("after 3 retries")), false);
  finish(adapterResult({ tabs: true }));
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.cdp.threadTabsPhase, "prepared");
  assert.equal(harness.cdp.retryThreadTabs, null);
});

test("closing the first main window publishes the surviving window’s completed adaptation", async () => {
  const start = source.indexOf("async function injectAll(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  const statuses = [], connections = new Map();
  let targets = [{ id: "first" }, { id: "second" }];
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectAll`, {
    URL, console: { error() {} }, unregisterQuotaPolicyCdp() {},
    emitLauncherEvent: (_event, status) => statuses.push(status.phase),
    injectTarget: async (_runtime, target) => {
      const connection = { closed: false, nativeAdaptersStatus: { phase: target.id === "first" ? "partial" : "ready", message: "", features: [] }, close() { this.closed = true; } };
      connection.startNativeAdapters = () => connection.onNativeAdaptersStatus();
      return { result: {}, connection };
    },
  });
  const run = () => inject({ targets: async () => targets }, "", "current", false, null, connections, true, {}, true, "token", () => {}, () => {}, () => {});
  await run();
  assert.equal(statuses.at(-1), "partial");
  targets = [{ id: "second" }];
  await run();
  assert.equal(statuses.at(-1), "ready");
});

test("a connected window retries missing tabs without blocking polls and applies recovery once", async () => {
  const harness = await adapterHarness(async (_options, attempt) => attempt < 3
    ? adapterResult({ tabs: false }, { tabs: "Native thread module missing" })
    : adapterResult({ tabs: true }));
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.preparations, 1);
  assert.equal(harness.result.reloads, 0, "failed modules do not trigger a reload");
  await harness.run();
  assert.equal(harness.result.preparations, 1);
  harness.advance(5_000);
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.preparations, 2);
  assert.equal(harness.result.reloads, 0);
  harness.advance(10_000);
  await harness.run();
  await harness.cdp.nativeAdaptersTask;
  assert.equal(harness.result.preparations, 3);
  assert.equal(harness.result.reloads, 1);
  assert.equal(harness.cdp.retryThreadTabs, null);
  await harness.events.get("Page.loadEventFired")();
  assert.equal(harness.published.at(-1), "4", "later loads publish the final script registration");
  harness.advance(15_000);
  await harness.run();
  assert.equal(harness.result.preparations, 3);
  assert.equal(harness.result.reloads, 1);
});


test("background menu retries stop after three failures while retaining Panel", async () => {
  const start = source.indexOf("async function injectAll(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  let now = 0, attempts = 0;
  const logs = [];
  const connection = { closed: false, threadTabsRetryAt: 5_000,
    retryThreadTabs: async () => { attempts++; if (attempts === 2) throw Error("temporary failure"); return false; } };
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectAll`, {
    Date: { now: () => now }, URL, console: { error: message => logs.push(message) },
  });
  const connections = new Map([["main", connection]]);
  for (now = 0; now <= 30_000; now += 1_000) {
    await inject({ targets: async () => [{ id: "main" }] }, "source", "hash", false, null, connections, true);
  }
  assert.equal(attempts, 3);
  assert.equal(connection.retryThreadTabs, null);
  assert.equal(connections.get("main"), connection);
  assert.equal(logs.filter(message => message.includes("after 3 retries")).length, 1);
});


test("macOS Codex launch does not inherit terminal language overrides", () => {
  const start = source.indexOf("export function launchCodex(");
  const end = source.indexOf("function launchedCodexExited(", start);
  const environment = { LANG: "en_US.UTF-8", LANGUAGE: "en", LC_ALL: "C.UTF-8", LC_CTYPE: "C.UTF-8", PATH: "/usr/bin", SAFE: "kept" };
  let launched;
  const launch = vm.runInNewContext(`${source.slice(start, end).replace("export ", "")}; launchCodex`, {
    process: { platform: "darwin", env: environment },
    path: { dirname: value => value.slice(0, value.lastIndexOf("/")), basename: value => value.slice(value.lastIndexOf("/") + 1), extname: () => ".app" },
    validatedCodexExecutablePath: value => value,
    independentCodexProfilePath: "/isolated/profile",
    withoutPanelLauncherEnvironment: value => ({ ...value }),
    spawn: (command, args, options) => { launched = { command, args, options }; return { unref() {} }; },
  });
  launch("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", 12345);
  assert.equal(launched.command, "/usr/bin/open");
  assert.deepEqual(launched.options.env, { PATH: "/usr/bin", SAFE: "kept" });
  assert.equal(environment.LANG, "en_US.UTF-8", "do not change the parent process environment");
  environment.CODEX_SPARKLE_ENABLED = "false";
  launch("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", 12345);
  assert.deepEqual(Array.from(launched.args.slice(0, 2)), ["--env", "CODEX_SPARKLE_ENABLED=false"]);
  assert.equal(launched.options.env.CODEX_SPARKLE_ENABLED, "false");
  delete environment.CODEX_SPARKLE_ENABLED;
  launch("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", 12345);
  assert.equal(launched.args.includes("--env"), false);
});

test("menu status distinguishes preparation from execution and manual retry resets the bounded queue", async () => {
  const start = source.indexOf('    let lastThreadTabsStatus = "";');
  const end = source.indexOf('    const publishManagedStatus =', start);
  let executed = false;
  const events = [];
  const connection = { closed: false, threadTabsPhase: "prepared", threadTabsError: "", threadTabsRetries: 3,
    prepareThreadTabs: async () => true, retryThreadTabs: null,
    send: async () => ({ result: { value: executed } }) };
  const targets = new Map([["main", connection]]);
  const { publish, retry } = vm.runInNewContext(`${source.slice(start, end)}; ({publish:publishThreadTabsStatus,retry:requestThreadTabsRetry})`, {
    injectedTargets: targets, emitLauncherEvent: (event, details) => events.push({event, ...details}),
  });
  await publish();
  assert.equal(events.at(-1).phase, "prepared");
  executed = true;
  await publish();
  assert.equal(events.at(-1).phase, "ready");
  connection.threadTabsPhase = "failed";
  connection.threadTabsError = "Native thread module missing: primary";
  await publish();
  assert.match(events.at(-1).message, /primary.*手动重试/);
  assert.equal(retry().queued, true);
  assert.equal(connection.threadTabsRetries, 0);
  assert.equal(connection.threadTabsRetryAt, 0);
  assert.equal(connection.retryThreadTabs, connection.prepareThreadTabs);
  assert.equal(events.at(-1).phase, "loading");
  connection.threadTabsRetries = 1;
  retry();
  assert.equal(connection.threadTabsRetries, 1, "duplicate clicks during loading do not extend retries");
  targets.clear();
  await publish();
  assert.equal(events.at(-1).phase, "waiting");
});
