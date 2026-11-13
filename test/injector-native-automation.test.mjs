import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { buildPanelAutomationSpec, panelAutomationPolicyOperation, reconcilePanelAutomation } from "../shared/panel-automation.mjs";
import { findCodexRspackRequire } from "../scripts/codex-update.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function requestCodexAutomationViaCdp(");
const functionSource = source.slice(start, source.indexOf("async function requestCodexAppServerViaCdp(", start));

function harness(service, { discovery = "legacy", delayStartup = false } = {}) {
  const fetches = [];
  const imports = [];
  const reads = [];
  let listener;
  let published = delayStartup ? undefined : service;
  const load = () => ({ appServices: published ? { localAutomations: published } : undefined });
  load.m = {};
  const installRegistry = () => {
    load.m.nativeServices = function (module, exports, require) {
      require.d(exports, { appServices: () => service }, { setAppHost() {}, setAppServices() {} });
    };
  };
  if (!delayStartup) installRegistry();
  const request = vm.runInNewContext(`(() => {
    const codexAutomationMethods = new Set(["list-automations", "automation-create", "automation-update", "automation-run-now", "inbox-items"]);
    let codexAutomationRequestSequence = 0;
    ${functionSource}
    return requestCodexAutomationViaCdp;
  })()`, { process: { pid: 1 }, findCodexRspackRequire });
  const mainEntry = "app://-/assets/348410.fixture.js";
  const page = vm.createContext({
    URL, location: { href: "app://-/index.html" },
    ...(discovery === "rspack" ? { __codexPanelRspack__: {
      require: load,
      findModule: () => ({ id: "nativeServices" }),
    } } : {}),
    performance: { getEntriesByType: () => discovery === "legacy"
      ? [{ name: "app://-/assets/app-shared-fixture.js" }] : [] },
    document: { querySelectorAll: selector => discovery === "startup"
      && selector === 'script[type="module"][src]' ? [{ src: mainEntry }] : [] },
    fetch: async url => {
      reads.push(url);
      assert.equal(url, mainEntry);
      return { ok: true, text: async () => "export { load as __webpack_require__ };" };
    },
    importModule: async url => {
      imports.push(url);
      if (url === mainEntry) {
        if (delayStartup) {
          setTimeout(installRegistry, 5);
          setTimeout(() => { published = service; }, 10);
        }
        return { __webpack_require__: load };
      }
      return { renamedExport: service ? { localAutomations: service } : {} };
    },
    window: {
      setTimeout, clearTimeout,
      addEventListener: (_type, fn) => { listener = fn; },
      removeEventListener() {},
      electronBridge: { sendMessageFromView(message) {
        fetches.push(message);
        listener({ data: { type: "fetch-response", requestId: message.requestId, status: 200, bodyJsonString: '{"items":[]}' } });
        return Promise.resolve();
      } },
    },
  });
  const cdp = {
    async send(method, { expression }) {
      assert.equal(method, "Runtime.evaluate");
      try {
        const value = await vm.runInContext(expression.replaceAll("import(url)", "importModule(url)"), page);
        return { result: { value } };
      } catch (error) {
        return { exceptionDetails: { exception: { description: error.message } } };
      }
    },
  };
  return { fetches, imports, reads, rpc: (method, body) => request(cdp, undefined, method, body) };
}

for (const discovery of ["legacy", "rspack", "startup"]) test(`legacy automation migration lists and pauses through ${discovery} discovery`, async () => {
  const calls = [];
  const service = {
    async list() { calls.push("list"); return { items: [{ id: "fixture-automation", name: "Taskboard 自动认领 · fixture", status: "ACTIVE" }] }; },
    async update(spec) { calls.push(JSON.parse(JSON.stringify(spec))); return { item: { ...spec } }; },
  };
  const { rpc, fetches, reads, imports } = harness(service, { discovery, delayStartup: discovery === "startup" });
  const result = await reconcilePanelAutomation({
    operation: "pause", panelProjectId: "fixture", codexProjectId: "fixture-project",
    projectName: "Fixture", workspacePath: "/disposable/project", skillPath: "/disposable/skills/manage-panel/SKILL.md",
    automationId: "fixture-automation", intervalMinutes: 5, model: "gpt-5.5", reasoningEffort: "high",
  }, rpc);
  assert.equal(calls[0], "list");
  assert.equal(calls[1].id, "fixture-automation");
  assert.equal(calls[1].status, "PAUSED");
  assert.equal(result.item.status, "PAUSED");
  assert.equal(fetches.length, 0);
  if (discovery === "startup") {
    assert.deepEqual(reads, ["app://-/assets/348410.fixture.js"]);
    assert.deepEqual(imports, reads, "the existing entry registry is reused for the subsequent update");
  }
});

test("older hosts keep the fetch path and native update failures are never retried", async () => {
  const legacy = harness(null);
  assert.deepEqual(JSON.parse(JSON.stringify(await legacy.rpc("list-automations", {}))), { items: [] });
  assert.equal(legacy.fetches.length, 1);
  const failed = harness({ list() {}, update() { throw new Error("Fixture write rejected"); } }, { discovery: "rspack" });
  await assert.rejects(failed.rpc("automation-update", { id: "fixture", status: "PAUSED" }), /Fixture write rejected/);
  assert.equal(failed.fetches.length, 0);
});

test("saved quota policies restore through the native service before Panel bootstrap", async () => {
  const request = {
    operation: "apply-policy", panelProjectId: "fixture", codexProjectId: "fixture-project",
    projectName: "Fixture", workspacePath: "/disposable/project", skillPath: "/disposable/skills/manage-panel/SKILL.md",
    automationId: "fixture-automation", intervalMinutes: 5, model: "gpt-5.5", reasoningEffort: "high",
    enabledByUser: true, quotaAware: true,
  };
  const calls = [];
  const { rpc, fetches } = harness({
    async list() {
      calls.push("list");
      return { items: [{ ...buildPanelAutomationSpec(request), id: request.automationId, status: "PAUSED" }] };
    },
    async update(spec) { calls.push(spec.status); return { item: spec }; },
  }, { discovery: "startup", delayStartup: true });
  const policyFunctions = source.slice(source.indexOf("async function applyPanelAutomationPolicy("), source.indexOf("function storedAutomationPolicy("))
    + source.slice(source.indexOf("function enqueueQuotaPolicyMutation("), source.indexOf("async function updateAndApplyQuotaPolicy("))
    + source.slice(source.indexOf("async function enqueueCurrentQuotaPolicy("), source.indexOf("function normalizeWorkspaceRoot("));
  let persisted = 0;
  const restore = vm.runInNewContext(`(() => {
    const quotaPolicyRecords = new Map([[request.panelProjectId, { request, version: 1, quota: { state: "blocked" } }]]);
    const quotaPolicyQueues = new Map(), quotaPolicyRestorePromises = new Map(), restoredQuotaPolicyCdps = new Set();
    ${policyFunctions}
    return restoreQuotaPolicies;
  })()`, {
    request, reconcilePanelAutomation, panelAutomationPolicyOperation,
    readCodexQuotaStatus: async () => ({ state: "available" }),
    requestCodexAutomationViaCdp: (_cdp, _context, method, body) => rpc(method, body),
    ensureQuotaPoliciesLoaded: async () => {}, registerQuotaPolicyCdp() {}, currentQuotaPolicyCdp: () => ({}),
    persistQuotaPolicies: async () => { persisted++; }, scheduleQuotaPolicyCheck() {},
  });
  await restore({});
  assert.deepEqual(calls, ["list", "list", "ACTIVE"]);
  assert.equal(persisted, 1);
  assert.equal(fetches.length, 0);
});
