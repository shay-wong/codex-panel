import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  closeInjectorControlServer,
  injectorControlSocketPath,
  publishInjectorRuntime,
  readInjectorRuntime,
  sendInjectorControlRequest,
  startInjectorControlServer,
  stopManagedInjector,
} from "../scripts/codex-injector-control.mjs";

test("the injector control endpoint requires the manager token and stays private", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const startupToken = "manager-token";
  const controlSocket = injectorControlSocketPath(runtimeFile, startupToken);
  let opened = 0;
  let stopped = 0;
  const interrupted = [];
  const server = await startInjectorControlServer({
    controlSocket,
    startupToken,
    handlers: {
      status: async () => ({ ready: true }),
      open: async () => ({ opened: ++opened }),
      "interrupt-thread": async (request) => {
        interrupted.push([request.threadId, request.codexHostId]);
        return { interrupted: true };
      },
      shutdown: async () => ({ stopping: ++stopped }),
    },
  });
  context.after(async () => closeInjectorControlServer(server));

  await publishInjectorRuntime(runtimeFile, {
    pid: process.pid,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "pipe",
  });
  const socketMode = process.platform === "win32" ? null : (await stat(controlSocket)).mode & 0o777;
  const descriptorMode = (await stat(runtimeFile)).mode & 0o777;
  if (process.platform !== "win32") {
    assert.equal(socketMode, 0o600);
    assert.equal(descriptorMode, 0o600);
  }
  assert.deepEqual(await readInjectorRuntime(runtimeFile), {
    version: 2,
    pid: process.pid,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "pipe",
  });

  const ownership = {
    nodePath: process.execPath,
    injectorPath: "/tmp/codex-injector.mjs",
    readCommand: async () => (
      `${process.execPath} /tmp/codex-injector.mjs --watch --cdp-pipe --startup-token manager-token`
    ),
  };
  assert.deepEqual(await sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "status",
    payload: { action: "shutdown", startupToken: "forged-token" },
    ownership,
  }), { ready: true });
  assert.deepEqual(await sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "open",
    ownership,
  }), { opened: 1 });
  assert.deepEqual(await sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "interrupt-thread",
    payload: { threadId: "thread-1", codexHostId: "local" },
    ownership,
  }), { interrupted: true });
  assert.deepEqual(interrupted, [["thread-1", "local"]]);
  await assert.rejects(
    sendInjectorControlRequest({
      runtimeFile,
      startupToken: "wrong-token",
      action: "status",
      ownership,
    }),
    /startup token/i,
  );
});

test("Windows control endpoints are private named pipes derived from the runtime and token", () => {
  const first = injectorControlSocketPath("C:\\Panel\\launcher-runtime.json", "manager-token", "win32");
  assert.match(first, /^\\\\\.\\pipe\\codex-panel-[a-f0-9]{32}$/);
  assert.equal(first, injectorControlSocketPath("C:\\Panel\\launcher-runtime.json", "manager-token", "win32"));
  assert.notEqual(first, injectorControlSocketPath("C:\\Panel\\launcher-runtime.json", "other-token", "win32"));
});

test("the Windows named pipe action boundary only accepts native interruption", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cp-wa-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const startupToken = "manager-token";
  const controlSocket = injectorControlSocketPath(runtimeFile, startupToken);
  const server = await startInjectorControlServer({
    controlSocket,
    startupToken,
    actions: ["interrupt-thread"],
    handlers: {
      status: async () => ({ ready: true }),
      "interrupt-thread": async () => ({ interrupted: true }),
    },
  });
  context.after(async () => closeInjectorControlServer(server));
  await publishInjectorRuntime(runtimeFile, {
    pid: process.pid,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "pipe",
  });
  const ownership = {
    nodePath: process.execPath,
    injectorPath: "/tmp/codex-injector.mjs",
    readCommand: async () => (
      `${process.execPath} /tmp/codex-injector.mjs --watch --cdp-pipe --startup-token manager-token`
    ),
  };

  assert.deepEqual(await sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "interrupt-thread",
    ownership,
  }), { interrupted: true });
  await assert.rejects(sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "status",
    ownership,
  }), /Unsupported Panel control action/);
});

test("the control client keeps the socket open for asynchronous handler replies", {
  skip: process.platform === "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-async-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const controlSocket = injectorControlSocketPath(runtimeFile);
  const startupToken = "manager-token";
  const server = await startInjectorControlServer({
    controlSocket,
    startupToken,
    handlers: {
      status: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ready: true };
      },
      open: async () => ({}),
      shutdown: async () => ({}),
    },
  });
  context.after(async () => closeInjectorControlServer(server));
  await publishInjectorRuntime(runtimeFile, {
    pid: process.pid,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "pipe",
  });

  assert.deepEqual(await sendInjectorControlRequest({
    runtimeFile,
    startupToken,
    action: "status",
    ownership: {
      nodePath: process.execPath,
      injectorPath: "/tmp/codex-injector.mjs",
      readCommand: async () => (
        `${process.execPath} /tmp/codex-injector.mjs --watch --startup-token manager-token`
      ),
    },
  }), { ready: true });
});

test("a runtime descriptor cannot redirect the manager token to another socket", {
  skip: process.platform === "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-path-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const foreignSocket = path.join(directory, "foreign.sock");
  const foreignServer = net.createServer((socket) => socket.end('{"ok":true}\n'));
  await new Promise((resolve, reject) => {
    foreignServer.once("error", reject);
    foreignServer.listen(foreignSocket, resolve);
  });
  context.after(() => new Promise((resolve) => foreignServer.close(resolve)));
  await chmod(foreignSocket, 0o600);
  await writeFile(runtimeFile, `${JSON.stringify({
    version: 2,
    pid: process.pid,
    url: "http://127.0.0.1:47823",
    controlSocket: foreignSocket,
    startupToken: "manager-token",
    transport: "pipe",
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    sendInjectorControlRequest({
      runtimeFile,
      startupToken: "manager-token",
      action: "status",
      ownership: {
        nodePath: process.execPath,
        injectorPath: "/tmp/codex-injector.mjs",
        readCommand: async () => (
          `${process.execPath} /tmp/codex-injector.mjs --watch --cdp-pipe --startup-token manager-token`
        ),
      },
    }),
    /control socket path/i,
  );
  assert.match(await readFile(runtimeFile, "utf8"), /foreign\.sock/);
});

test("legacy runtime descriptors defer to exact resident cleanup during upgrade", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-legacy-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  await writeFile(runtimeFile, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    url: "http://127.0.0.1:47823",
  })}\n`, { mode: 0o600 });

  assert.deepEqual(await stopManagedInjector({
    runtimeFile,
    ownership: {
      nodePath: process.execPath,
      injectorPath: "/tmp/codex-injector.mjs",
      readCommand: async () => {
        throw new Error("legacy descriptors must not control a process directly");
      },
    },
  }), {
    stopped: false,
    reason: "legacy-descriptor",
    pid: process.pid,
  });
  assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).version, 1);
});

test("a reused stale runtime PID is discarded without signaling the unrelated process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-stale-pid-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const startupToken = "stale-manager-token";
  const controlSocket = injectorControlSocketPath(runtimeFile, startupToken);
  const stalePID = 99_998;
  await publishInjectorRuntime(runtimeFile, {
    pid: stalePID,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "tcp",
    port: 9_229,
  });

  const signals = [];
  assert.deepEqual(await stopManagedInjector({
    runtimeFile,
    ownership: {
      nodePath: "/trusted/node",
      injectorPath: "/trusted/codex-injector.mjs",
      readCommand: async () => "/unrelated/process --still-running",
      killProcess: (_pid, signal) => {
        if (signal !== 0) signals.push(signal);
      },
    },
  }), {
    stopped: false,
    reason: "stale-ownership",
    pid: stalePID,
  });
  assert.deepEqual(signals, []);
  await assert.rejects(readFile(runtimeFile, "utf8"), { code: "ENOENT" });
});

test("managed shutdown revalidates ownership immediately before every signal", {
  skip: process.platform === "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-control-signals-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const controlSocket = injectorControlSocketPath(runtimeFile);
  const startupToken = "manager-token";
  const server = await startInjectorControlServer({
    controlSocket,
    startupToken,
    handlers: {
      status: async () => ({}),
      open: async () => ({}),
      shutdown: async () => ({ stopping: true }),
    },
  });
  context.after(async () => closeInjectorControlServer(server));
  await publishInjectorRuntime(runtimeFile, {
    pid: 99_999,
    url: "http://127.0.0.1:47823",
    controlSocket,
    startupToken,
    transport: "tcp",
    port: 9_229,
  });

  let commandReads = 0;
  const signals = [];
  await assert.rejects(stopManagedInjector({
    runtimeFile,
    gracefulTimeoutMs: 1,
    terminateTimeoutMs: 1,
    killTimeoutMs: 1,
    ownership: {
      nodePath: "/trusted/node",
      injectorPath: "/trusted/codex-injector.mjs",
      readCommand: async () => {
        commandReads += 1;
        if (commandReads === 3) return "/untrusted/node unrelated.mjs --watch";
        return "/trusted/node /trusted/codex-injector.mjs --watch --startup-token manager-token";
      },
      killProcess: (_pid, signal) => {
        if (signal !== 0) signals.push(signal);
      },
    },
  }), /Refusing to control unowned Panel injector/);

  assert.equal(commandReads, 3);
  assert.deepEqual(signals, ["SIGTERM"]);
});
