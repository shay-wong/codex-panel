import assert from "node:assert/strict";
import { test } from "node:test";
import { readSharedSessionInitialization } from "../scripts/codex-shared-session-native.mjs";

test("shared CLI initialization reads native metadata without reinitializing the App", async () => {
  const previous = globalThis.window;
  const listeners = new Set();
  let request;
  const fixtureWindow = {
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
    electronBridge: { sendMessageFromView(message) {
      request = message;
      queueMicrotask(() => { for (const listener of listeners) listener({ source: null,
        data: { type: "codex-app-server-initialized", hostId: "local", appServerVersion: "0.169.0" } }); });
    } },
  };
  globalThis.window = fixtureWindow;
  const load = () => ({ appServices: {
    executionPaths: { readHomePaths: async hostId => { assert.equal(hostId, "local"); return { codexHome: "/fixture/codex" }; } },
    appInfo: { getSystemInfo: async () => ({ platform: "darwin" }) },
  } });
  load.m = { fixture: function () { return "setAppHost setAppServices appServices:"; } };
  try {
    assert.deepEqual(await readSharedSessionInitialization(load), {
      userAgent: "codex/0.169.0", codexHome: "/fixture/codex", platformFamily: "unix", platformOs: "macos",
    });
    assert.deepEqual(request, { type: "request-app-server-state" });
    assert.equal(listeners.size, 0);
  } finally { globalThis.window = previous; }
});

test("native conversation lease is retained once and disposed without changing history", async () => {
  const previous = globalThis.__codexPanelSharedConversationLeases__;
  delete globalThis.__codexPanelSharedConversationLeases__;
  const calls = [];
  const pending = Promise.resolve({ [Symbol.dispose]() { calls.push("lease-dispose"); } });
  pending[Symbol.dispose] = () => calls.push("pending-dispose");
  const manager = {
    retainActiveConversation(id) { calls.push(id); return pending; },
    async resumeConversation(params) { calls.push(`resume:${params.conversationId}`); return { status: "ready" }; },
    [Symbol.dispose]() { calls.push("manager-dispose"); },
  };
  const load = () => ({ appServices: { appServerManagers: { open: async () => ({ status: "ready", manager }) } } });
  load.m = { fixture: function () { return "setAppHost setAppServices appServices:"; } };
  const { retainSharedConversation } = await import("../scripts/codex-shared-session-native.mjs");
  try {
    await retainSharedConversation(load, "thread-fixture", true);
    await retainSharedConversation(load, "thread-fixture", true);
    await retainSharedConversation(null, "thread-fixture", false);
    await retainSharedConversation(null, "thread-fixture", false);
    assert.deepEqual(calls, ["thread-fixture", "resume:thread-fixture", "pending-dispose", "lease-dispose", "manager-dispose"]);
  } finally { globalThis.__codexPanelSharedConversationLeases__ = previous; }
});
