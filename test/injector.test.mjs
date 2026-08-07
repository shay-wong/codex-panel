import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as injectorModule from "../scripts/codex-injector.mjs";

const {
  codexExecutablePath,
  launchCodex,
  reloadRenderer,
  validatedCdpWebSocketUrl,
  waitForCodexTargets,
  waitForRendererReady,
} = injectorModule;

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("cold launch detaches the Codex application from the injector lifecycle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-launch-"));
  const appPath = path.join(directory, "Fake Codex.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Fake Codex");
  const capturePath = path.join(directory, "args.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Fake Codex</string>
  <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  const quotedCapturePath = `'${capturePath.replaceAll("'", `'\\''`)}'`;
  await writeFile(executablePath, `#!/bin/sh
printf '%s\\n' "$@" > ${quotedCapturePath}
while :; do /bin/sleep 1; done
`);
  await chmod(executablePath, 0o755);

  let launchedPid = null;
  const launcher = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { launchCodex } from ${JSON.stringify(new URL("../scripts/codex-injector.mjs", import.meta.url).href)};
const child = launchCodex(process.argv[1], Number(process.argv[2]));
process.stdout.write(String(child.pid));`,
    executablePath,
    "9347",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let launcherOutput = "";
  let launcherError = "";
  launcher.stdout.on("data", (chunk) => { launcherOutput += chunk; });
  launcher.stderr.on("data", (chunk) => { launcherError += chunk; });
  const launcherExit = once(launcher, "exit");
  t.after(() => {
    try {
      launcher.kill("SIGKILL");
    } catch {}
    if (launchedPid) {
      try {
        process.kill(launchedPid, "SIGTERM");
      } catch {}
    }
  });

  let timeout;
  const [launcherExitCode] = await Promise.race([
    launcherExit,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("launcher parent did not exit after unref")), 2_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(launcherExitCode, 0, launcherError);
  launchedPid = Number(launcherOutput.trim());
  assert.ok(Number.isInteger(launchedPid) && launchedPid > 0);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(capturePath, "utf8");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.doesNotThrow(() => process.kill(launchedPid, 0));

  const processGroup = await new Promise((resolve, reject) => {
    const ps = spawn("/bin/ps", ["-o", "pgid=", "-p", String(launchedPid)]);
    let output = "";
    ps.stdout.on("data", (chunk) => { output += chunk; });
    ps.once("error", reject);
    ps.once("exit", (code) => {
      if (code === 0) resolve(Number(output.trim()));
      else reject(new Error(`ps exited with status ${code}`));
    });
  });

  assert.equal(processGroup, launchedPid);
  assert.deepEqual((await readFile(capturePath, "utf8")).trimEnd().split("\n"), [
    "--remote-debugging-port=9347",
    "--remote-allow-origins=http://127.0.0.1:9347",
    "--disable-features=LocalNetworkAccessForSubframeNavigations",
  ]);
  process.kill(launchedPid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(launchedPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      launchedPid = null;
      break;
    }
  }
  assert.equal(launchedPid, null);
});

for (const [caseName, plistContents] of [
  [
    "missing CFBundleExecutable",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
</dict></plist>
`,
  ],
  ["malformed Info.plist", "not a property list\n"],
]) {
  test(`cold launch rejects ${caseName} without a basename fallback`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-invalid-launch-"));
    const appPath = path.join(directory, "Fake Codex.app");
    const executablePath = path.join(appPath, "Contents", "MacOS", "Fake Codex");
    t.after(() => rm(directory, { recursive: true, force: true }));

    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "Info.plist"), plistContents);
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);

    assert.throws(
      () => codexExecutablePath(appPath),
      /Unable to read CFBundleExecutable from .*Info\.plist: .+/,
    );
  });
}

test("the launcher waits for and selects a delayed main Codex renderer", async (t) => {
  let listRequests = 0;
  let cdpPort;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/list");
    response.setHeader("content-type", "application/json");
    listRequests += 1;
    response.end(JSON.stringify(listRequests < 3
      ? []
      : [{
          id: "codex-avatar-overlay",
          type: "page",
          title: "Codex",
          url: "app://-/index.html?initialRoute=%2Favatar-overlay",
          webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/codex-avatar-overlay`,
        }, {
          id: "codex-main",
          type: "page",
          title: "Codex",
          url: "app://-/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/codex-main`,
        }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === "object");
  cdpPort = address.port;
  const targets = await waitForCodexTargets(address.port, 1_000);

  assert.equal(listRequests, 3);
  assert.deepEqual(targets.map((target) => target.id), ["codex-main"]);
});

test("CDP WebSocket URLs stay on the selected loopback endpoint", () => {
  assert.equal(
    validatedCdpWebSocketUrl("ws://127.0.0.1:9347/devtools/page/codex-main", 9347),
    "ws://127.0.0.1:9347/devtools/page/codex-main",
  );
  assert.equal(
    validatedCdpWebSocketUrl("ws://127.0.0.1:80/devtools/page/codex-main", 80),
    "ws://127.0.0.1/devtools/page/codex-main",
  );

  for (const candidate of [
    "wss://127.0.0.1:9347/devtools/page/codex-main",
    "ws://localhost:9347/devtools/page/codex-main",
    "ws://127.1:9347/devtools/page/codex-main",
    "ws://2130706433:9347/devtools/page/codex-main",
    "ws://192.0.2.10:9347/devtools/page/codex-main",
    "ws://127.0.0.1:9229/devtools/page/codex-main",
    "ws://user@127.0.0.1:9347/devtools/page/codex-main",
    "ws://127.0.0.1:9347/devtools/page/codex-main#fragment",
    "ws://127.0.0.1:9347/other/page/codex-main",
  ]) {
    assert.throws(
      () => validatedCdpWebSocketUrl(candidate, 9347),
      /selected loopback endpoint/,
    );
  }
});

test("initial renderer readiness waits for the completed app document", async () => {
  const states = [
    { readyState: "loading", href: "app://-/index.html" },
    { readyState: "complete", href: "app://-/index.html" },
  ];
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      return { result: { value: states.shift() } };
    },
  };

  const state = await waitForRendererReady(cdp, 1_000);

  assert.deepEqual(state, { readyState: "complete", href: "app://-/index.html" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.equal(calls[0].params.returnByValue, true);
});

test("reload waiter rejection is handled while the reload command is pending", async () => {
  const expected = new Error("renderer closed during reload");
  const calls = [];
  let rejectLoad;
  const cdp = {
    waitFor(method, timeoutMs) {
      calls.push({ method, timeoutMs });
      return new Promise((resolve, reject) => {
        rejectLoad = reject;
      });
    },
    send(method) {
      calls.push({ method });
      rejectLoad(expected);
      return new Promise((resolve) => setImmediate(resolve));
    },
  };

  await assert.rejects(reloadRenderer(cdp, 250), expected);
  assert.deepEqual(calls, [
    { method: "Page.loadEventFired", timeoutMs: 250 },
    { method: "Page.reload" },
  ]);
});

test("the resident injector supervises the fixed local Panel service", () => {
  assert.match(source, /function createPanelSupervisor/);
  assert.match(source, /await isReachable\(panelHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
});

test("the initial Panel open request is claimed only once after a renderer appears", () => {
  const request = injectorModule.createInitialOpenRequest(true);

  assert.equal(request.claim([]), false);
  assert.equal(request.claim([{ id: "main" }]), true);
  assert.equal(request.claim([{ id: "main" }]), false);
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexPanelHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installPanelHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexPanelHostHeartbeatV1/);
});

test("the CDP bridge exposes only the fixed Panel automation operations", () => {
  assert.match(source, /parsePanelAutomationHostRequest/);
  assert.match(source, /reconcilePanelAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexPanelHostStartupTokenV1/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_PANEL_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexPanelInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_PANEL_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("initial renderer injection reloads only after Codex bootstrap completes", () => {
  const readinessStart = source.indexOf(
    "    await waitForRendererReady(cdp, 15_000);",
  );
  const registration = source.indexOf(
    "    const scriptIdentifier = await registerInjectionSource(cdp, source);",
    readinessStart,
  );
  const reload = source.indexOf(
    "    await reloadRenderer(cdp, 15_000);",
    registration,
  );
  const evaluation = source.indexOf(
    "    await evaluateInjectionSource(cdp, source);",
    reload,
  );
  assert.notEqual(readinessStart, -1);
  assert.ok(registration > readinessStart);
  assert.ok(reload > registration);
  assert.ok(evaluation > reload);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
  assert.match(source, /target\.url\?\.includes\("initialRoute=%2Favatar-overlay"\)/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshPanelFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /panel\.reloadFrame\(\)/);
  assert.match(source, /__codex_panel_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const panelPageUrl = `\$\{panelOrigin\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_PANEL_URL__ = \$\{JSON\.stringify\(panelPageUrl\)\}/);
});
