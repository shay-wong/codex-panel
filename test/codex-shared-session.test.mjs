import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startSharedSessionGateway } from "../scripts/codex-shared-session.mjs";

async function setup(context, request, callbacks = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "panel-shared-session-"));
  const initialize = { userAgent: "codex/fixture", codexHome: dataDirectory, platformFamily: "unix", platformOs: "macos" };
  const gateway = await startSharedSessionGateway({ dataDirectory, executable: process.execPath, request, initializeResult: async () => initialize, ...callbacks });
  context.after(async () => { await gateway.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const connect = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${gateway.descriptor.port}`, {
      headers: { Authorization: `Bearer ${gateway.descriptor.token}` },
    });
    await once(client, "open");
    const received = [];
    client.on("message", bytes => received.push(JSON.parse(bytes.toString())));
    const rpc = async (message) => {
      const response = new Promise(resolve => {
        const onMessage = bytes => {
          const result = JSON.parse(bytes.toString());
          if (result.id === message.id) { client.off("message", onMessage); resolve(result); }
        };
        client.on("message", onMessage);
      });
      client.send(JSON.stringify(message));
      return response;
    };
    return { client, rpc, received };
  };
  return { gateway, initialize, connect };
}

test("shared CLI authenticates, initializes and rejoins the native App thread", async (context) => {
  const requests = [];
  const { gateway, initialize, connect } = await setup(context, async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: params.threadId }, resumed: true };
  });
  const first = await connect();
  assert.deepEqual(await first.rpc({ id: 1, method: "thread/list" }), {
    id: 1, error: { code: -32002, message: "连接尚未初始化" },
  });
  assert.deepEqual(await first.rpc({ id: "init", method: "initialize", params: {} }), { id: "init", result: initialize });
  assert.equal((await first.rpc({ id: 2, method: "initialize" })).error.code, -32600);
  const resumed = await first.rpc({ id: 3, method: "thread/resume", params: { threadId: "same-thread" } });
  assert.equal(resumed.result.thread.id, "same-thread");
  const second = await connect();
  await second.rpc({ id: 1, method: "initialize" });
  await second.rpc({ id: 2, method: "thread/resume", params: { threadId: "same-thread" } });
  assert.deepEqual(requests, [
    { method: "thread/resume", params: { threadId: "same-thread" } },
    { method: "thread/resume", params: { threadId: "same-thread" } },
  ]);
  const firstEvent = once(first.client, "message");
  const secondEvent = once(second.client, "message");
  const notification = { method: "item/agentMessage/delta", params: { threadId: "same-thread", delta: "hello" } };
  gateway.publish(notification);
  assert.deepEqual(JSON.parse((await firstEvent)[0]), notification);
  assert.deepEqual(JSON.parse((await secondEvent)[0]), notification);
  assert.equal((await first.rpc({ id: 4, method: "thread/unsubscribe", params: { threadId: "same-thread" } })).result.status, "unsubscribed");
  assert.equal(requests.length, 2);
  const nextEvent = once(second.client, "message");
  gateway.publish(notification);
  await nextEvent;
  assert.equal(first.received.filter(message => message.method === notification.method).length, 1);
  assert.equal((await stat(gateway.descriptorPath)).isFile(), true);
  if (process.platform !== "win32") assert.equal((await stat(gateway.descriptorPath)).mode & 0o777, 0o600);
  const descriptor = JSON.parse(await readFile(gateway.descriptorPath, "utf8"));
  assert.equal(descriptor.token, gateway.descriptor.token);
});

test("shared CLI rejects unauthenticated and browser connections", async (context) => {
  const { gateway } = await setup(context, async () => ({}));
  for (const headers of [{}, { Authorization: `Bearer ${gateway.descriptor.token}`, Origin: "https://example.com" }]) {
    const client = new WebSocket(`ws://127.0.0.1:${gateway.descriptor.port}`, { headers });
    client.on("error", () => {});
    const [, response] = await once(client, "unexpected-response");
    assert.equal(response.statusCode, 401);
    client.terminate();
  }
});

test("resume subscribes before native events and rolls back a failed resume", async (context) => {
  let gateway;
  ({ gateway } = await setup(context, async (method, params) => {
    gateway.publish({ method: "thread/status/changed", params: { threadId: params.threadId, status: { type: "idle" } } });
    throw Object.assign(new Error("fixture resume failed"), { code: -32001, data: { reason: "fixture" } });
  }));
  const client = new WebSocket(`ws://127.0.0.1:${gateway.descriptor.port}`, {
    headers: { Authorization: `Bearer ${gateway.descriptor.token}` },
  });
  await once(client, "open");
  const messages = [];
  client.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
  let response = once(client, "message");
  client.send(JSON.stringify({ id: 1, method: "initialize" }));
  await response;
  response = new Promise(resolve => {
    const onMessage = bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id === 2) { client.off("message", onMessage); resolve(message); }
    };
    client.on("message", onMessage);
  });
  client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-failed" } }));
  assert.deepEqual((await response).error, { code: -32001, message: "fixture resume failed", data: { reason: "fixture" } });
  assert.equal(messages.filter(message => message.method === "thread/status/changed").length, 1);
  gateway.publish({ method: "thread/status/changed", params: { threadId: "thread-failed", status: { type: "idle" } } });
  // 后续普通通知用于冲刷同一 WebSocket，确认失败会话未继续收取更新。
  response = once(client, "message");
  gateway.publish({ method: "account/updated", params: {} });
  await response;
  assert.equal(messages.filter(message => message.method === "thread/status/changed").length, 1);
});

test("native retention is shared and released only after the last CLI leaves", async (context) => {
  const retained = [];
  const released = [];
  const { gateway, connect } = await setup(context,
    async (method, params) => ({ thread: { id: params.threadId } }), {
      retainThread: async threadId => retained.push(threadId),
      releaseThread: async threadId => released.push(threadId),
    });
  const first = await connect();
  const second = await connect();
  await Promise.all([first.rpc({ id: 1, method: "initialize" }), second.rpc({ id: 1, method: "initialize" })]);
  await Promise.all([first.rpc({ id: 2, method: "thread/resume", params: { threadId: "kept" } }), second.rpc({ id: 2, method: "thread/resume", params: { threadId: "kept" } })]);
  assert.deepEqual(retained, ["kept"]);
  await first.rpc({ id: 3, method: "thread/unsubscribe", params: { threadId: "kept" } });
  assert.deepEqual(released, []);
  await gateway.close();
  assert.deepEqual(released, ["kept"]);
});

test("native privileged verification is not exposed through the shared socket", async (context) => {
  const requests = [];
  const { connect } = await setup(context, async method => { requests.push(method); return {}; });
  const client = await connect();
  await client.rpc({ id: 1, method: "initialize" });
  for (const method of ["userVerification/enroll", "userVerification/delete", "userVerification/verify", "userVerification/cancel"]) {
    assert.equal((await client.rpc({ id: method, method })).error.code, -32600);
  }
  await client.rpc({ id: 2, method: "userVerification/status" });
  assert.deepEqual(requests, ["userVerification/status"]);
});

test("shared sessions reject new or forked threads before creating anything", async context => {
  const requests = [];
  const { connect } = await setup(context, async method => { requests.push(method); return {}; });
  const { rpc } = await connect();
  await rpc({ id: 1, method: "initialize" });
  for (const method of ["thread/start", "thread/fork"]) {
    const response = await rpc({ id: method, method, params: {} });
    assert.equal(response.error.code, -32600);
    assert.match(response.error.message, /请先在 Codex App/);
  }
  assert.deepEqual(requests, []);
});
