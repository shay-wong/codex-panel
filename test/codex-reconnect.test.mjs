import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");

test("a broken discovery candidate does not hide another running Codex port", async () => {
  const code = source.slice(source.indexOf("async function discoverCodexPort("), source.indexOf("function processCwd("));
  const discover = vm.runInNewContext(`${code}; discoverCodexPort`, {
    codexDebuggingPorts: () => [41001, 41002],
    isReachable: async () => true,
    codexTargets: async port => { if (port === 41001) throw new Error("connection closed"); return [{}]; },
  });
  assert.equal(await discover(41001), 41002);
});

test("resident injector replaces the stale connection and publishes the recovered port", async () => {
  const start = source.indexOf("        if (!options.cdpPipe && options.attachExisting && !(await isReachable(cdpVersionUrl)))");
  const end = source.indexOf("        const results = await injectAll(", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const connections = new Map([["old", { close() { calls.push("connection closed"); } }]]);
  const avatarConnections = new Map([["old-avatar", { close() { calls.push("avatar closed"); } }]]);
  const run = vm.runInNewContext(`async () => {
    let cdpVersionUrl = "http://127.0.0.1:41001/json/version";
    let cdpRuntime = {close() { calls.push("runtime closed"); }};
    let codexProcess = {pid: 123};
    ${source.slice(start, end)}
    return { cdpVersionUrl, codexProcess, port: cdpRuntime.port };
  }`, {
    calls, injectedTargets: connections, avatarConnections,
    options: {cdpPipe:false, attachExisting:true, port:41001, startupToken:"test"},
    isReachable: async () => false, discoverCodexPort: async () => 41002,
    unregisterRoutableCodexConnection: () => calls.push("route removed"),
    unregisterQuotaPolicyCdp: () => calls.push("quota removed"),
    tcpCdpRuntime: port => ({port}), console: {error() {}},
    panelRuntimeFile:"/disposable/runtime.json", panelBaseUrl:"http://127.0.0.1:42000",
    injectorControlSocketPath: () => "/disposable/control.sock", process:{pid:1},
    publishInjectorRuntime: async (_file, record) => calls.push(record.port),
  });
  const result = await run();
  assert.equal(result.port, 41002);
  assert.equal(result.codexProcess, null);
  assert.equal(result.cdpVersionUrl, "http://127.0.0.1:41002/json/version");
  assert.equal(connections.size, 0);
  assert.equal(avatarConnections.size, 0);
  assert.deepEqual(calls, ["route removed","quota removed","connection closed","avatar closed","runtime closed",41002]);
});
