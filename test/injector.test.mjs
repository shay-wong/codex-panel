import assert from "node:assert/strict";
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

import { launchCodex, waitForCodexTargets } from "../scripts/codex-injector.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("cold launch tracks the Codex application process instead of an open helper", async (t) => {
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
  await writeFile(executablePath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
`);
  await chmod(executablePath, 0o755);

  const child = launchCodex(appPath, 9347);
  const [exitCode] = await once(child, "exit");

  assert.equal(exitCode, 0);
  assert.equal(child.spawnfile, executablePath);
  assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), [
    "--remote-debugging-port=9347",
    "--remote-allow-origins=http://127.0.0.1:9347",
  ]);
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
      () => launchCodex(appPath, 9347),
      /Unable to read CFBundleExecutable from .*Info\.plist: .+/,
    );
  });
}

test("the launcher waits for and selects a delayed main Codex renderer", async (t) => {
  let listRequests = 0;
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
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/codex-avatar-overlay",
        }, {
          id: "codex-main",
          type: "page",
          title: "Codex",
          url: "app://-/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/codex-main",
        }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === "object");
  const targets = await waitForCodexTargets(address.port, 1_000);

  assert.equal(listRequests, 3);
  assert.deepEqual(targets.map((target) => target.id), ["codex-main"]);
});

test("the resident injector supervises the fixed local Panel service", () => {
  assert.match(source, /function createPanelSupervisor/);
  assert.match(source, /await isReachable\(panelHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
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

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
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
