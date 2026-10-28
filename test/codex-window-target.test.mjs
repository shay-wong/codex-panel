import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("unmounted entries never report successful injection", async () => {
  const start = source.indexOf("async function injectTarget(");
  const end = source.indexOf("async function injectAll(", start);
  for (const attachExisting of [true, false]) {
    let closed = false;
    const cdp = {send:async () => ({}),on(){},close(){closed=true;}};
    const inject = vm.runInNewContext(`${source.slice(start,end)}; injectTarget`, {
      installPanelHostBinding:()=>({install:async()=>{},publishHeartbeat:async()=>{}}),
      waitForRendererReady:async()=>{},prepareCodexProviderQuotaFix:async()=>"",panelEnvironment:()=>null,
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
  const start = source.indexOf("async function injectTarget(");
  const end = source.indexOf("async function injectAll(", start);
  const page = { window: {} };
  let reloads = 0;
  const preparations = ["", "window.__codexPanelProviderQuotaV1__ = { prepared: true };", "window.__codexPanelProviderQuotaV1__ = { prepared: true };"];
  const status = () => ({ sourceHash: "current", startupToken: "manager", entryMounted: true,
    providerModulesPrepared: page.window.__codexPanelProviderQuotaV1__?.prepared === true });
  const cdp = { send: async () => ({}), on() {}, close() {} };
  const inject = vm.runInNewContext(`${source.slice(start, end)}; injectTarget`, {
    installPanelHostBinding: () => ({ install: async () => {}, publishHeartbeat: async () => {} }),
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
  const start = source.indexOf("async function injectTarget(");
  const end = source.indexOf("async function currentInjectionSource(", start);
  let now = 0, attempts = 0, reloads = 0, registeredSource = "", registration = 0;
  const events = new Map();
  const published = [];
  const cdp = { send: async () => ({}), on: (event, callback) => events.set(event, callback), close() {} };
  const status = () => ({ sourceHash: "current", entryMounted: true, providerModulesPrepared: true, scriptIdentifier: String(registration) });
  const { injectAll } = vm.runInNewContext(`${source.slice(start, end)}; ({injectAll})`, {
    Date: { now: () => now }, URL, console: { error() {} },
    installPanelHostBinding: () => ({ install: async () => {}, publishHeartbeat: async () => {} }),
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
