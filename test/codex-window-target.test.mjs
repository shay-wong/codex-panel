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
