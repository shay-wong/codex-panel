import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  injectionReadinessMatches,
  reconcileInjectionRuntime,
  residentInjectorCommandMatches,
  restartResidentInjector,
  sameFrameDocumentUrl,
} from "../scripts/codex-injector-runtime.mjs";

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  panelProjectId: "local",
  codexProjectId: "codex-project",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-panel/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    reloadRenderer: async () => calls.push(["reload"]),
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["reload"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    reloadRenderer: async () => calls.push(["reload"]),
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["reload"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("attach reloads the renderer and restores an open page even when the source is current", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: true,
      scriptIdentifier: "current-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "replacement-registration";
    },
    reloadRenderer: async () => calls.push(["reload"]),
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "replacement-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "current-registration"],
    ["register", "current-source"],
    ["reload"],
    ["evaluate", "current-source"],
    ["publish", "replacement-registration"],
    ["open"],
  ]);
});

test("resident discovery is scoped to the exact current injector path and port", () => {
  const projectRoot = "/workspace/codex-panel";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
    "107 node /Users/example/Library/Application Support/Codex Panel/runtime/scripts/codex-injector.mjs --watch --port 9231",
    "108 node /workspace/another-clone/scripts/codex-injector.mjs --watch --port 9229",
  ].join("\n");
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    port: 9231,
    defaultPort: 9229,
  }), [101]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    port: 9229,
    defaultPort: 9229,
  }), [105]);
  assert.equal(
    residentInjectorCommandMatches(
      `node ${injectorPath} --watch --port 9231`,
      injectorPath,
    ),
    true,
  );
  assert.equal(
    residentInjectorCommandMatches(
      "node /workspace/another-clone/scripts/codex-injector.mjs --watch --port 9231",
      injectorPath,
    ),
    false,
  );
  assert.equal(
    residentInjectorCommandMatches("node scripts/codex-injector.mjs --watch", injectorPath),
    false,
  );
  assert.equal(
    residentInjectorCommandMatches(
      `node ${injectorPath} --watch --port 9229`,
      injectorPath,
      9231,
      9229,
    ),
    false,
  );
});

test("renderer readiness requires the current source, manager token, mounted entry, and fresh heartbeat", () => {
  const expected = {
    expectedSourceHash: "current-source",
    expectedStartupToken: "manager-token",
    now: 10_000,
    maxHeartbeatAgeMs: 5_000,
  };
  const ready = {
    sourceHash: "current-source",
    startupToken: "manager-token",
    entryMounted: true,
    heartbeatAt: 9_000,
  };

  assert.equal(injectionReadinessMatches(ready, expected), true);
  assert.equal(injectionReadinessMatches({ ...ready, entryMounted: false }, expected), false);
  assert.equal(injectionReadinessMatches({ ...ready, sourceHash: "stale" }, expected), false);
  assert.equal(injectionReadinessMatches({ ...ready, startupToken: "other" }, expected), false);
  assert.equal(injectionReadinessMatches({ ...ready, heartbeatAt: 4_999 }, expected), false);
});

test("refresh stops every stale resident before starting one token-verified replacement", async () => {
  const calls = [];
  const startupToken = "replacement-token";
  const replacement = await restartResidentInjector(9231, {
    findResidents: () => [4321, 5432],
    stopResident: async (pid) => calls.push(["stop", pid]),
    createStartupToken: () => startupToken,
    startResident: (port, token) => {
      calls.push(["start", port, token]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid, token) => calls.push(["ready", port, pid, token]),
  });

  assert.deepEqual(replacement, {
    previousPids: [4321, 5432],
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["stop", 5432],
    ["start", 9231, startupToken],
    ["ready", 9231, 9876, startupToken],
  ]);
});

test("resident frame matching accepts Panel route queries but rejects other documents", () => {
  assert.equal(sameFrameDocumentUrl(
    "http://127.0.0.1:47823/?host=codex&project=local&issue=LOCAL-1",
    "http://127.0.0.1:47823/?host=codex",
  ), true);
  assert.equal(sameFrameDocumentUrl(
    "http://127.0.0.1:47824/?host=codex",
    "http://127.0.0.1:47823/?host=codex",
  ), false);
  assert.equal(sameFrameDocumentUrl(
    "chrome-error://chromewebdata/",
    "http://127.0.0.1:47823/?host=codex",
  ), false);
});
