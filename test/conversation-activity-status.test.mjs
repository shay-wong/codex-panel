import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationActivityStatus } from "../web/src/taskConversations.ts";

test("native activity uses live progress rather than the placeholder idle status", () => {
  const thread = { purpose: "formal", codexThreadId: "local:thread-1", status: "idle" };
  assert.equal(conversationActivityStatus(thread, { "thread-1": { running: true } }), "running");
  assert.equal(conversationActivityStatus(thread, { "thread-1": { running: false } }), "idle");
  assert.equal(conversationActivityStatus(thread, {}), "unknown");
  assert.equal(conversationActivityStatus(thread, { "thread-1": null }), "unknown");
  assert.equal(conversationActivityStatus({ ...thread, purpose: "temporary", status: "failed" }, {}), "failed");
});
