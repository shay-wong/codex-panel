import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

const maximumMessageBytes = 16 * 1024 * 1024;

function notificationThreadId(params) {
  return params?.threadId ?? params?.thread?.id ?? null;
}

export async function startSharedSessionGateway({
  dataDirectory,
  executable,
  request,
  initializeResult,
  retainThread = async () => {},
  releaseThread = async () => {},
}) {
  if (!path.isAbsolute(dataDirectory) || !path.isAbsolute(executable)) {
    throw new Error("共享会话的数据目录和 CLI 路径必须是绝对路径");
  }
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const clients = new Map();
  const retainedThreads = new Map();
  const releasingThreads = new Set();
  const descriptorPath = path.join(dataDirectory, "shared-session.json");
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: maximumMessageBytes,
    perMessageDeflate: false,
    verifyClient({ req }, done) {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const authorized = req.headers.origin === undefined
        && supplied.length === authorization.length
        && timingSafeEqual(supplied, authorization);
      done(authorized, 401, "Unauthorized");
    },
  });
  await once(server, "listening");

  function send(client, message) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  async function subscribe(state, threadId) {
    let entry = retainedThreads.get(threadId);
    if (entry?.releasing) {
      await entry.releasing;
      return subscribe(state, threadId);
    }
    if (state.closed) throw new Error("共享 CLI 连接已经关闭");
    if (!entry) {
      entry = { states: new Set(), ready: Promise.resolve().then(() => retainThread(threadId)) };
      retainedThreads.set(threadId, entry);
    }
    entry.states.add(state);
    state.threads.add(threadId);
    try {
      await entry.ready;
    } catch (error) {
      for (const subscriber of entry.states) subscriber.threads.delete(threadId);
      entry.states.clear();
      if (retainedThreads.get(threadId) === entry) retainedThreads.delete(threadId);
      throw error;
    }
    if (state.closed || !state.threads.has(threadId)) throw new Error("共享 CLI 已退订此会话");
  }

  function unsubscribe(state, threadId) {
    if (!state.threads.delete(threadId)) return Promise.resolve(false);
    const entry = retainedThreads.get(threadId);
    if (!entry) return Promise.resolve(true);
    entry.states.delete(state);
    if (entry.states.size > 0) return Promise.resolve(true);
    // 最后一个 CLI 离开才释放原生保留标记；新订阅必须等待旧标记释放完成。
    entry.releasing ??= (async () => {
      try {
        try { await entry.ready; } catch { return; }
        await releaseThread(threadId);
      } finally {
        if (retainedThreads.get(threadId) === entry) retainedThreads.delete(threadId);
      }
    })();
    releasingThreads.add(entry.releasing);
    entry.releasing.finally(() => releasingThreads.delete(entry.releasing)).catch(() => {});
    return entry.releasing.then(() => true);
  }

  async function releaseClient(state) {
    state.closed = true;
    await Promise.all([...state.threads].map(threadId => unsubscribe(state, threadId)));
  }

  server.on("connection", (client) => {
    const state = { initialized: false, initializing: false, closed: false, threads: new Set() };
    clients.set(client, state);
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      releaseClient(state).catch(() => {});
    });
    client.on("message", async (bytes, isBinary) => {
      let message;
      try {
        if (isBinary) throw new Error("请求必须是 JSON 文本");
        message = JSON.parse(bytes.toString());
      } catch {
        send(client, { id: null, error: { code: -32700, message: "无效的 JSON 请求" } });
        return;
      }
      if (!message || Array.isArray(message) || typeof message.method !== "string") {
        send(client, { id: message?.id ?? null, error: { code: -32600, message: "无效的请求" } });
        return;
      }
      // App 已负责原生初始化和审批响应；CLI 的通知不能重复初始化该连接。
      if (!Object.hasOwn(message, "id")) return;
      const { id, method, params } = message;
      if (typeof id !== "string" && typeof id !== "number") {
        send(client, { id: null, error: { code: -32600, message: "无效的请求 ID" } });
        return;
      }
      const fail = (code, description, data) => send(client, {
        id, error: { code, message: description, ...(data === undefined ? {} : { data }) },
      });
      if (method === "initialize") {
        if (state.initialized || state.initializing) {
          fail(-32600, "连接已经初始化");
          return;
        }
        state.initializing = true;
        try {
          const result = await initializeResult();
          state.initialized = true;
          send(client, { id, result });
        } catch (error) {
          fail(-32603, error?.message ?? String(error));
        } finally {
          state.initializing = false;
        }
        return;
      }
      if (!state.initialized) {
        fail(-32002, "连接尚未初始化");
        return;
      }
      // 共享 CLI 来自 WebSocket，不能借 App 的 stdio 身份执行本机验证密钥操作。
      if (["userVerification/enroll", "userVerification/delete", "userVerification/verify", "userVerification/cancel"].includes(method)) {
        fail(-32600, "本机身份验证仅可在 Codex App 中完成");
        return;
      }
      // 创建走 App 原生流程，确保新会话的历史、审批和流归属同时就绪。
      if (method === "thread/start" || method === "thread/fork") {
        fail(-32600, "共享模式用于继续已有会话，请先在 Codex App 中创建或分叉会话，再从共享 CLI 选择。");
        return;
      }
      if (method === "thread/unsubscribe") {
        // 两端共用 App 的原生连接，CLI 退订不能移除 App 的订阅。
        try {
          const subscribed = await unsubscribe(state, params?.threadId);
          send(client, { id, result: { status: subscribed ? "unsubscribed" : "notSubscribed" } });
        } catch (error) { fail(-32603, error?.message ?? String(error)); }
        return;
      }
      const resumingThread = method === "thread/resume" ? params?.threadId : null;
      const subscribedBefore = state.threads.has(resumingThread);
      try {
        if (typeof resumingThread === "string") await subscribe(state, resumingThread);
        const result = await request(method, params);
        if (method === "thread/resume"
          && typeof result?.thread?.id === "string" && result.thread.id !== resumingThread) {
          await subscribe(state, result.thread.id);
        }
        send(client, { id, result });
      } catch (error) {
        if (resumingThread && !subscribedBefore) await unsubscribe(state, resumingThread).catch(() => {});
        fail(Number.isInteger(error?.code) ? error.code : -32603, error?.message ?? String(error), error?.data);
      }
    });
  });

  const descriptor = { version: 1, pid: process.pid, port: server.address().port, token, executable };
  const temporaryPath = `${descriptorPath}.${process.pid}.${token.slice(0, 8)}.tmp`;
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, descriptorPath);
  } catch (error) {
    server.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  let closing;
  return {
    descriptor,
    descriptorPath,
    publish(notification) {
      if (!notification || typeof notification.method !== "string") return;
      const threadId = notificationThreadId(notification.params);
      for (const [client, state] of clients) {
        if (state.initialized && (!threadId || state.threads.has(threadId))) {
          send(client, { method: notification.method, params: notification.params });
        }
        if (["thread/closed", "thread/archived", "thread/deleted"].includes(notification.method) && threadId) {
          unsubscribe(state, threadId).catch(() => {});
        }
      }
    },
    close() {
      closing ??= (async () => {
        const released = await Promise.allSettled([...clients.values()].map(releaseClient));
        for (const client of clients.keys()) client.terminate();
        await new Promise((resolve) => server.close(resolve));
        const remaining = await Promise.allSettled(releasingThreads);
        try {
          const saved = JSON.parse(await readFile(descriptorPath, "utf8"));
          if (saved.pid === process.pid && saved.token === token) await rm(descriptorPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const failed = [...released, ...remaining].find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      })();
      return closing;
    },
  };
}
