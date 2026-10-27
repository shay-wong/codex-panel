import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { reconcilePanelAutomation } from "../shared/panel-automation.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function requestCodexAutomationViaCdp(");
const functionSource = source.slice(start, source.indexOf("async function requestCodexAppServerViaCdp(", start));

function harness(service) {
  const fetches = [];
  let listener;
  const request = vm.runInNewContext(`(() => {
    const codexAutomationMethods = new Set(["list-automations", "automation-create", "automation-update", "automation-run-now", "inbox-items"]);
    let codexAutomationRequestSequence = 0;
    ${functionSource}
    return requestCodexAutomationViaCdp;
  })()`, { process: { pid: 1 } });
  const cdp = {
    async send(method, { expression }) {
      assert.equal(method, "Runtime.evaluate");
      try {
        const value = await vm.runInNewContext(expression.replaceAll("import(url)", "importModule(url)"), {
          URL, location: { href: "app://-/index.html" },
          performance: { getEntriesByType: () => [{ name: "app://-/assets/app-shared-fixture.js" }] },
          document: { querySelectorAll: () => [] },
          importModule: async () => ({ renamedExport: service ? { localAutomations: service } : {} }),
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
        return { result: { value } };
      } catch (error) {
        return { exceptionDetails: { exception: { description: error.message } } };
      }
    },
  };
  return { fetches, rpc: (method, body) => request(cdp, undefined, method, body) };
}

test("legacy Panel automation migration lists and pauses through the current native service", async () => {
  const calls = [];
  const service = {
    async list() { calls.push("list"); return { items: [{ id: "fixture-automation", name: "Taskboard 自动认领 · fixture", status: "ACTIVE" }] }; },
    async update(spec) { calls.push(JSON.parse(JSON.stringify(spec))); return { item: { ...spec } }; },
  };
  const { rpc, fetches } = harness(service);
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
});

test("older hosts keep the fetch path and native update failures are never retried", async () => {
  const legacy = harness(null);
  assert.deepEqual(JSON.parse(JSON.stringify(await legacy.rpc("list-automations", {}))), { items: [] });
  assert.equal(legacy.fetches.length, 1);
  const failed = harness({ list() {}, update() { throw new Error("Fixture write rejected"); } });
  await assert.rejects(failed.rpc("automation-update", { id: "fixture", status: "PAUSED" }), /Fixture write rejected/);
  assert.equal(failed.fetches.length, 0);
});
