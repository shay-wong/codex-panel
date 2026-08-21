import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { managedInjectorCommandMatches } from "./codex-injector-runtime.mjs";

const allowedActions = new Set(["status", "open", "interrupt-thread", "shutdown"]);
const maximumMessageBytes = 64 * 1024;
const requestTimeoutMs = 3_000;

function isMissing(error) {
  return error?.code === "ENOENT";
}

export function injectorControlSocketPath(runtimeFile, startupToken = null, platform = process.platform) {
  if (platform === "win32") {
    assertIdentifier(startupToken, "Panel startup token");
    const identifier = createHash("sha256")
      .update(`${path.resolve(runtimeFile)}\0${startupToken}`)
      .digest("hex")
      .slice(0, 32);
    return `\\\\.\\pipe\\codex-panel-${identifier}`;
  }
  return path.join(path.dirname(path.resolve(runtimeFile)), ".codex-panel.sock");
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,100}$/i.test(value)) {
    throw new Error(`${label} must be an identifier`);
  }
}

function assertLoopbackPanelURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
  ) {
    throw new Error("Panel runtime URL must use the IPv4 loopback interface");
  }
}

async function assertPrivateRegularFile(filePath) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("Panel runtime descriptor must be a regular file");
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error("Panel runtime descriptor belongs to another user");
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error("Panel runtime descriptor permissions must be user-only");
  }
}

export async function publishInjectorRuntime(runtimeFile, descriptor) {
  const resolvedRuntimeFile = path.resolve(runtimeFile);
  const controlSocket = injectorControlSocketPath(resolvedRuntimeFile, descriptor.startupToken);
  if (descriptor.controlSocket !== controlSocket) {
    throw new Error("Panel control socket path does not match the runtime descriptor");
  }
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) {
    throw new Error("Panel runtime PID must be a positive integer");
  }
  assertIdentifier(descriptor.startupToken, "Panel startup token");
  assertLoopbackPanelURL(descriptor.url);
  if (descriptor.transport !== "pipe" && descriptor.transport !== "tcp") {
    throw new Error("Panel runtime transport must be pipe or tcp");
  }
  const payload = {
    version: 2,
    pid: descriptor.pid,
    url: descriptor.url,
    controlSocket,
    startupToken: descriptor.startupToken,
    transport: descriptor.transport,
    ...(Number.isInteger(descriptor.port) ? { port: descriptor.port } : {}),
  };
  const temporaryPath = `${resolvedRuntimeFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(resolvedRuntimeFile), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, resolvedRuntimeFile);
  await chmod(resolvedRuntimeFile, 0o600);
  return payload;
}

async function readInjectorRuntimeDescriptor(runtimeFile, { allowLegacy = false } = {}) {
  const resolvedRuntimeFile = path.resolve(runtimeFile);
  await assertPrivateRegularFile(resolvedRuntimeFile);
  const descriptor = JSON.parse(await readFile(resolvedRuntimeFile, "utf8"));
  if (allowLegacy && descriptor?.version === 1) {
    if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) {
      throw new Error("Panel runtime descriptor has an invalid PID");
    }
    assertLoopbackPanelURL(descriptor.url);
    return descriptor;
  }
  if (descriptor?.version !== 2) {
    throw new Error("Unsupported Panel runtime descriptor version");
  }
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) {
    throw new Error("Panel runtime descriptor has an invalid PID");
  }
  assertIdentifier(descriptor.startupToken, "Panel startup token");
  assertLoopbackPanelURL(descriptor.url);
  if (descriptor.transport !== "pipe" && descriptor.transport !== "tcp") {
    throw new Error("Panel runtime descriptor has an invalid transport");
  }
  if (descriptor.controlSocket !== injectorControlSocketPath(resolvedRuntimeFile, descriptor.startupToken)) {
    throw new Error("Panel control socket path is not launcher-managed");
  }
  return descriptor;
}

export async function readInjectorRuntime(runtimeFile) {
  return readInjectorRuntimeDescriptor(runtimeFile);
}

export function readProcessCommand(pid) {
  const command = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "/bin/ps";
  const args = process.platform === "win32"
    ? [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $args[0])).CommandLine",
      String(pid),
    ]
    : ["-ww", "-p", String(pid), "-o", "command="];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Managed Panel injector ${pid} is not running`);
  }
  return result.stdout.trim();
}

async function assertManagedRuntimeOwnership(descriptor, ownership) {
  const readCommand = ownership?.readCommand ?? readProcessCommand;
  const command = await readCommand(descriptor.pid);
  if (!managedInjectorCommandMatches(command, {
    nodePath: ownership?.nodePath,
    injectorPath: ownership?.injectorPath,
    startupToken: descriptor.startupToken,
  })) {
    throw new Error(`Refusing to control unowned Panel injector ${descriptor.pid}`);
  }
}

async function signalManagedInjector(descriptor, ownership, signal) {
  await assertManagedRuntimeOwnership(descriptor, ownership);
  const killProcess = ownership?.killProcess ?? ((pid, targetSignal) => (
    process.kill(pid, targetSignal)
  ));
  killProcess(descriptor.pid, signal);
}

function exchangeControlMessage(controlSocket, request, timeoutMs = requestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: controlSocket });
    let settled = false;
    let buffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error("Panel injector control request timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maximumMessageBytes) {
        finish(new Error("Panel injector control response is too large"));
        return;
      }
      const boundary = buffer.indexOf("\n");
      if (boundary === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, boundary));
        if (response?.ok !== true) {
          finish(new Error(response?.error || "Panel injector control request failed"));
          return;
        }
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

export async function sendInjectorControlRequest({
  runtimeFile,
  startupToken = null,
  action,
  payload = {},
  ownership,
}) {
  if (!allowedActions.has(action)) throw new Error(`Unsupported Panel control action: ${action}`);
  const descriptor = await readInjectorRuntime(runtimeFile);
  if (startupToken && startupToken !== descriptor.startupToken) {
    throw new Error("Panel startup token does not match the managed injector");
  }
  await assertManagedRuntimeOwnership(descriptor, ownership);
  return exchangeControlMessage(descriptor.controlSocket, {
    ...payload,
    action,
    startupToken: startupToken || descriptor.startupToken,
  }, action === "interrupt-thread" ? 15_000 : requestTimeoutMs);
}

function processIsRunning(pid, killProcess = process.kill) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilProcessStops(pid, timeoutMs, killProcess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid, killProcess)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsRunning(pid, killProcess);
}

export async function stopManagedInjector({
  runtimeFile,
  ownership,
  gracefulTimeoutMs = 3_000,
  terminateTimeoutMs = 5_000,
  killTimeoutMs = 1_000,
}) {
  let descriptor;
  try {
    descriptor = await readInjectorRuntimeDescriptor(runtimeFile, { allowLegacy: true });
  } catch (error) {
    if (isMissing(error)) return { stopped: false, reason: "not-running" };
    throw error;
  }
  if (descriptor.version === 1) {
    return { stopped: false, reason: "legacy-descriptor", pid: descriptor.pid };
  }
  const killProcess = ownership?.killProcess ?? process.kill;
  if (!processIsRunning(descriptor.pid, killProcess)) {
    await removeInjectorRuntime(runtimeFile, descriptor);
    return { stopped: false, reason: "stale-descriptor", pid: descriptor.pid };
  }
  try {
    await assertManagedRuntimeOwnership(descriptor, ownership);
  } catch {
    await removeInjectorRuntime(runtimeFile, descriptor);
    return { stopped: false, reason: "stale-ownership", pid: descriptor.pid };
  }
  try {
    await exchangeControlMessage(descriptor.controlSocket, {
      action: "shutdown",
      startupToken: descriptor.startupToken,
    });
  } catch {}
  if (await waitUntilProcessStops(descriptor.pid, gracefulTimeoutMs, killProcess)) {
    await removeInjectorRuntime(runtimeFile, descriptor);
    return { stopped: true, pid: descriptor.pid, signal: null };
  }
  await signalManagedInjector(descriptor, ownership, "SIGTERM");
  if (await waitUntilProcessStops(descriptor.pid, terminateTimeoutMs, killProcess)) {
    await removeInjectorRuntime(runtimeFile, descriptor);
    return { stopped: true, pid: descriptor.pid, signal: "SIGTERM" };
  }
  await signalManagedInjector(descriptor, ownership, "SIGKILL");
  if (!(await waitUntilProcessStops(descriptor.pid, killTimeoutMs, killProcess))) {
    throw new Error(`Timed out stopping managed Panel injector ${descriptor.pid}`);
  }
  await removeInjectorRuntime(runtimeFile, descriptor);
  return { stopped: true, pid: descriptor.pid, signal: "SIGKILL" };
}

async function removeStaleSocket(controlSocket) {
  if (process.platform === "win32") return;
  try {
    const details = await lstat(controlSocket);
    if (!details.isSocket() || details.isSymbolicLink()) {
      throw new Error("Refusing to replace a non-socket Panel control path");
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new Error("Panel control socket belongs to another user");
    }
    await unlink(controlSocket);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function startInjectorControlServer({
  controlSocket,
  startupToken,
  handlers,
  actions = allowedActions,
}) {
  const resolvedControlSocket = process.platform === "win32" ? controlSocket : path.resolve(controlSocket);
  assertIdentifier(startupToken, "Panel startup token");
  const acceptedActions = new Set(actions);
  if ([...acceptedActions].some((action) => !allowedActions.has(action))) {
    throw new Error("Unsupported Panel control action");
  }
  if (process.platform !== "win32") {
    await mkdir(path.dirname(resolvedControlSocket), { recursive: true, mode: 0o700 });
  }
  await removeStaleSocket(resolvedControlSocket);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    const reply = (payload) => {
      socket.end(`${JSON.stringify(payload)}\n`);
    };
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maximumMessageBytes) {
        reply({ ok: false, error: "Panel injector control request is too large" });
        return;
      }
      const boundary = buffer.indexOf("\n");
      if (boundary === -1) return;
      socket.removeAllListeners("data");
      try {
        const request = JSON.parse(buffer.slice(0, boundary));
        if (request?.startupToken !== startupToken) {
          throw new Error("Panel startup token was rejected");
        }
        if (!acceptedActions.has(request.action) || typeof handlers?.[request.action] !== "function") {
          throw new Error("Unsupported Panel control action");
        }
        reply({ ok: true, result: await handlers[request.action](request) });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolvedControlSocket, resolve);
  });
  if (process.platform !== "win32") await chmod(resolvedControlSocket, 0o600);
  return { server, sockets, controlSocket: resolvedControlSocket };
}

export async function closeInjectorControlServer(control) {
  if (!control) return;
  for (const socket of control.sockets) socket.destroy();
  await new Promise((resolve) => control.server.close(resolve));
  if (process.platform !== "win32") {
    try {
      await unlink(control.controlSocket);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export async function removeInjectorRuntime(runtimeFile, { pid, startupToken } = {}) {
  try {
    const descriptor = await readInjectorRuntime(runtimeFile);
    if (descriptor.pid !== pid || descriptor.startupToken !== startupToken) return false;
    await unlink(path.resolve(runtimeFile));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
