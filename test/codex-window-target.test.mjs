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
    console: { error() {} },
    waitForRendererReady: async () => {},
    readPetAnimations: async () => [{ petId: "fixture" }],
    panelDataDirectory: "/fixture/data",
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
  events.get("Page.loadEventFired")();
  assert.equal(connections.get("pet").petAnimationsRevision, undefined);
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
});

test("imported pet packs update main and avatar connections without reloading", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-pet-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "pet-animations"), index = path.join(directory, "index.json");
  await mkdir(directory);
  await writeFile(index, "[]");
  let packs = [], reads = 0;
  const start = source.indexOf("async function syncPetAnimations(");
  const end = source.indexOf("async function prepareNativeAdapters(", start);
  const sync = vm.runInNewContext(`${source.slice(start, end)}; syncPetAnimations`, {
    stat, path, console,
    readPetAnimations: async dataDirectory => { assert.equal(dataDirectory, root); reads++; return packs; },
  });
  const commands = [];
  const connections = ["main", "avatar"].map(name => {
    const page = vm.createContext({ __codexPanelPetAnimations__: { setPacks(next) { this.packs = next; } } });
    return { name, page, send: async (method, params) => {
      commands.push(method);
      return { result: { value: vm.runInContext(params.expression, page) } };
    } };
  });
  await sync(root, connections);
  assert.equal(reads, 1);
  await sync(root, connections);
  assert.equal(reads, 1, "unchanged registrations need no resource reread");
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

test("quota preparation recovering on a mount retry reloads once before reusing the document", async () => {
  const { reconcileInjectionRuntime } = await import("../scripts/codex-injector-runtime.mjs");
  const start = source.indexOf("async function prepareNativeAdapters(");
  const end = source.indexOf("async function injectAll(", start);
  const page = { window: {} };
  let reloads = 0;
  const preparations = ["", "window.__codexPanelProviderQuotaV1__ = { prepared: true };", "window.__codexPanelProviderQuotaV1__ = { prepared: true };"];
  const status = () => ({ sourceHash: "current", startupToken: "manager", entryMounted: true,
    providerModulesPrepared: page.window.__codexPanelProviderQuotaV1__?.prepared === true });
  const cdp = { send: async () => ({}), on() {}, close() {} };
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectTarget`, {
    installPanelHostBinding: () => ({ install: async () => {}, publishHeartbeat: async () => {} }),
    prepareCodexRspack: async () => null,
    waitForRendererReady: async () => {}, panelEnvironment: () => "fixture",
    prepareCodexProviderQuotaFix: async () => preparations.shift(),
    prepareCodexProviderUltrafast: async () => [],
    prepareCodexDotEntry: async (_cdp, modules) => ({ modules, prepared: false }),
    prepareCodexThreadTabs: async (_cdp, modules) => modules,
    readInjectionStatus: async () => status(), reconcileInjectionRuntime,
    registerInjectionSource: async () => "registered",
    reloadRenderer: async () => { reloads++; page.window = {}; },
    evaluateInjectionSource: async (_cdp, currentSource) => vm.runInNewContext(currentSource, page),
    publishInjectionScriptIdentifier: async () => {}, waitForInjectionStatus: async () => status(),
    unregisterQuotaPolicyCdp() {}, console: { error() {} },
  });
  for (const expectedReloads of [0, 1, 1]) {
    await inject({ connect: async () => cdp }, {}, "// panel source", "current", false, null, true, {}, true, "manager", () => {}, () => {}, () => {});
    assert.equal(reloads, expectedReloads);
  }
});

test("a connected window retries missing tabs and applies the recovered menu once", async () => {
  const { reconcileInjectionRuntime } = await import("../scripts/codex-injector-runtime.mjs");
  const start = source.indexOf("async function prepareNativeAdapters(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  let now = 0, attempts = 0, reloads = 0, registeredSource = "", registration = 0;
  const events = new Map();
  const published = [];
  const cdp = { send: async () => ({}), on: (event, callback) => events.set(event, callback), close() {} };
  const status = () => ({ sourceHash: "current", entryMounted: true, providerModulesPrepared: true, scriptIdentifier: String(registration) });
  const { injectAll } = vm.runInNewContext(`${source.slice(start, end)}; ({injectAll})`, {
    Date: { now: () => now }, URL, console: { error() {} },
    installPanelHostBinding: () => ({ install: async () => {}, publishHeartbeat: async () => {} }),
    prepareCodexRspack: async () => null,
    waitForRendererReady: async () => {}, panelEnvironment: () => "fixture",
    prepareCodexProviderUltrafast: async () => [],
    prepareCodexDotEntry: async (_cdp, modules) => ({ modules, prepared: false }),
    prepareCodexThreadTabs: async (_cdp, modules) => ++attempts < 3 ? modules : [{ url: "primary", source: "menu" }],
    prepareCodexProviderQuotaFix: async (_cdp, _preferences, _report, modules) => modules.length ? "// recovered menu" : "// existing adapters",
    readInjectionStatus: async () => status(), reconcileInjectionRuntime,
    registerInjectionSource: async (_cdp, text) => { registeredSource = text; return String(++registration); },
    reloadRenderer: async () => { reloads++; await events.get("Page.loadEventFired")?.(); },
    evaluateInjectionSource: async () => {},
    publishInjectionScriptIdentifier: async (_cdp, identifier) => published.push(identifier),
    waitForInjectionStatus: async () => status(), unregisterQuotaPolicyCdp() {},
  });
  const connections = new Map();
  const runtime = { targets: async () => [{ id: "main" }], connect: async () => cdp };
  const run = () => injectAll(runtime, "// panel source", "current", false, null, connections, true, {}, true, "token", () => {}, () => {}, () => {});
  await run();
  assert.equal(connections.get("main"), cdp, "Panel connects even when the tabs preparation fails");
  assert.equal(attempts, 1);
  await run();
  assert.equal(attempts, 1, "polls before the retry interval do not reread modules");
  now = 5_000;
  await run();
  assert.equal(attempts, 2);
  assert.equal(reloads, 0, "failed reads do not reload the page");
  now = 10_000;
  await run();
  assert.equal(attempts, 3);
  assert.equal(reloads, 1);
  assert.match(registeredSource, /recovered menu\n\/\/ panel source/);
  assert.equal(cdp.retryThreadTabs, null);
  await events.get("Page.loadEventFired")();
  assert.equal(published.at(-1), "2", "later loads publish the updated script registration");
  now = 15_000;
  await run();
  assert.equal(attempts, 3, "successful recovery stops retries");
  assert.equal(reloads, 1);
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
