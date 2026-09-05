import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/panel-supervisor.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector authenticates its launcher-managed Panel service", () => {
  assert.match(supervisorSource, /function createPanelSupervisor/);
  assert.match(source, /CODEX_PANEL_INSTANCE_TOKEN/);
  assert.match(source, /createHmac\("sha256"/);
  assert.match(source, /x-codex-panel-challenge/);
  assert.match(source, /proof/);
  assert.match(source, /panelInstanceSecret/);
  assert.match(source, /Page\.setDocumentContent/);
  assert.match(runtimeSource, /request\.action === "load-frame"/);
  assert.match(supervisorSource, /ensureInFlight/);
  assert.match(supervisorSource, /await terminateManagedChild\(managedChild\)/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /__CODEX_PANEL_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.frameCapability/);
});

test("the CDP bridge accepts local prefill, SSH conversation, and attachment actions", () => {
  const appServerRequestSource = source.slice(
    source.indexOf("async function requestCodexAppServerViaCdp"),
    source.indexOf("async function applyPanelAutomationPolicy"),
  );
  assert.match(source, /const hostBindingName = "__codexPanelHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.action === "confirm-task-conversation"/);
  assert.match(runtimeSource, /request\.action === "start-task-conversation"/);
  assert.match(runtimeSource, /request\.action === "open-attachment"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 16_384/);
  assert.match(runtimeSource, /function validSkillReference\(skill\)/);
  assert.match(runtimeSource, /request\.skills === undefined[\s\S]*?validSkillReference\(\{/);
  assert.match(runtimeSource, /request\.skills\.every\(validSkillReference\)/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /async function confirmTaskConversationViaCdp/);
  assert.match(source, /async function startTaskConversationViaCdp/);
  assert.match(source, /function requestCodexAppServerViaCdp/);
  assert.doesNotMatch(appServerRequestSource, /contextId/);
  assert.match(source, /source: "panel_thread_create"/);
  assert.match(source, /"thread\/read"/);
  assert.match(source, /"thread\/name\/set"/);
  assert.match(source, /async function openAttachment/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /some\(\(candidate\) => candidate\.getClientRects\(\)\.length > 0\)\)\(\)/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /const stageDeadline = \(\) => Date\.now\(\) \+ 8_000/);
  assert.match(source, /compact\(editor\.textContent\)\.includes\(compact\(instruction\)\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(source, /Page\.createIsolatedWorld/);
  assert.match(source, /Runtime\.addBinding", \{\s*name: hostBindingName,\s*executionContextId:/);
  assert.match(source, /params\.executionContextId !== activeContextId/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponseMessage/);
  assert.match(source, /if \(keepAlive\) await hostBridge\.install\(\)/);
  assert.match(source, /hostBridge\.publishHeartbeat/);
  assert.match(source, /withoutPanelLauncherEnvironment\(process\.env\)/);
});

test("the CDP bridge exposes only the fixed Panel automation operations", () => {
  assert.match(source, /parsePanelAutomationHostRequest/);
  assert.match(source, /reconcilePanelAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*"automation-run-now",\s*"inbox-items",\s*\]\)/);
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

test("passive automation policy keeps idle pauses and only resumes quota pauses", () => {
  assert.match(source, /panelAutomationPolicyOperation/);
  assert.match(source, /previousQuotaState: current\.quota\?\.state/);
  assert.match(source, /enqueueQuotaPolicyMutation\(record, rpc, \{ explicit: true \}\)/);
  assert.match(
    source,
    /!explicit && result\.operation === "list" && result\.item\?\.status === "PAUSED"/,
  );
  assert.match(source, /enabledByUser: false/);
  assert.match(source, /record\.quota \? \{ quota: record\.quota \} : \{\}/);
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

test("the Windows launcher control pipe opens, checks, and stops the managed Panel", () => {
  assert.match(source, /createInterface\(\{ input: process\.stdin, terminal: false \}\)/);
  assert.match(source, /action === "open"/);
  assert.match(source, /action === "status"/);
  assert.match(source, /action === "stop"/);
  assert.match(source, /openPanelSignalQueued/);
  assert.match(source, /openPanelSignalOpened/);
  assert.match(source, /panelManagedStatus/);
  assert.match(source, /openedStatus\.pageVisible === true/);
  assert.match(source, /renderer did not confirm page visibility/);
  assert.match(source, /shouldOpen && \(!status\.pageVisible \|\| !status\.frameReady \|\| !frameLoaded\)/);
  assert.match(
    source,
    /controlServer = await startInjectorControlServer/,
  );
  assert.match(source, /injectorControlSocketPath\(panelRuntimeFile, options\.startupToken\)/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_PANEL_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexPanelInjection__\?\.sourceHash \|\| null/);
  assert.doesNotMatch(source, /window\.__codexTaskboardInjection__/);
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

test("the injected iframe selects ordinary or private service paths explicitly", () => {
  assert.match(source, /const privatePanelMode = Boolean\(panelInstanceToken && panelInstanceSecret\)/);
  assert.match(source, /const panelBaseUrl = privatePanelMode[\s\S]*?encodeURIComponent\(panelInstanceToken\)[\s\S]*?: panelOrigin/);
  assert.match(source, /const panelPageUrl = `\$\{panelBaseUrl\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_PANEL_URL__ = \$\{JSON\.stringify\(panelPageUrl\)\}/);
  assert.match(source, /window\.__CODEX_PANEL_PRIVATE_FRAME__ = \$\{JSON\.stringify\(privatePanelMode\)\}/);
});

test("Panel environment is primary and private identity is never generated implicitly", () => {
  assert.match(source, /process\.env\[`CODEX_PANEL_\$\{name\}`\][\s\S]*?process\.env\[`CODEX_TASKBOARD_\$\{name\}`\]/);
  assert.match(source, /const panelInstanceToken = panelEnvironment\("INSTANCE_TOKEN"\)/);
  assert.match(source, /const panelInstanceSecret = panelEnvironment\("INSTANCE_SECRET"\)/);
  assert.doesNotMatch(source, /INSTANCE_TOKEN[^\n]*randomUUID/);
  assert.doesNotMatch(source, /INSTANCE_SECRET[^\n]*randomBytes/);
  assert.match(source, /if \(!privatePanelMode\) return isReachable\(panelHealthUrl\)/);
  assert.match(source, /assertPanelServiceModeAvailable/);
  assert.match(source, /already running without the configured private identity/);
});

test("desktop manager lifecycle commands return before normal launch setup", () => {
  assert.match(source, /else if \(arg === "--discover-port"\) options\.discoverPort = true/);
  assert.match(source, /else if \(arg === "--status"\) options\.status = true/);
  assert.match(source, /else if \(arg === "--open-existing"\) options\.openExisting = true/);
  assert.match(source, /else if \(arg === "--stop-residents"\) options\.stopResidents = true/);
  assert.match(source, /else if \(arg === "--app-executable"\) options\.appExecutable = path\.resolve/);
  assert.match(source, /--status requires --startup-token/);
  assert.match(source, /--open-existing requires --startup-token/);
  assert.match(source, /residentInjectorCommandMatches\([\s\S]*?Refusing to stop unowned Panel injector/);
});

test("validated executable launch preserves TCP and pipe security flags", () => {
  assert.match(source, /function validatedCodexExecutablePath\(executablePath\)/);
  assert.match(source, /accessSync\(executablePath, constants\.X_OK\)/);
  assert.match(source, /export function launchCodex\(executablePath, port\)/);
  assert.match(source, /--remote-debugging-port=\$\{port\}/);
  assert.match(source, /--remote-debugging-pipe/);
  assert.match(source, /--disable-features=LocalNetworkAccessForSubframeNavigations/);

  const tcpLaunchStart = source.indexOf("export function launchCodex");
  const tcpLaunchEnd = source.indexOf("async function launchCodexWithPipe", tcpLaunchStart);
  const tcpLaunchSource = source.slice(tcpLaunchStart, tcpLaunchEnd);
  assert.match(tcpLaunchSource, /process\.platform === "win32"[\s\S]*?activateWindowsCodex/);
  assert.match(tcpLaunchSource, /spawn\(\s*"\/usr\/bin\/open"/);
  assert.match(tcpLaunchSource, /"-W",\s*"-n",\s*"-a",\s*applicationPath,\s*"--args"/);
  assert.doesNotMatch(tcpLaunchSource, /spawn\(\s*validatedCodexExecutablePath/);
});

test("private CDP pipe launch and renderer recovery remain enabled", () => {
  assert.match(source, /--remote-debugging-pipe/);
  assert.match(source, /new CdpPipeBrowser\(child\)/);
  assert.match(source, /pipeCdpRuntime\(launched\.browser\)/);
  assert.match(source, /Page\.setBypassCSP/);
  assert.match(source, /frameReady: window\.__codexPanelInjection__\?\.ready === true/);
  assert.match(source, /hostBridge\.publishHeartbeat\(\)/);
  assert.match(source, /openRuntimePanel[\s\S]*?injectionReadinessMatches\(status/);
  assert.match(source, /const hasOpenPending = \(\) => openedRequestGeneration < openRequestGeneration/);
  assert.match(source, /if \(idleAfterNormalExit\)[\s\S]*?if \(!hasOpenPending\(\)\) continue/);
});

test("managed private-CDP spawn failures wait for another open request", async () => {
  const launchStart = source.indexOf("function managedCodexSpawnFailure");
  const launchEnd = source.indexOf("class CdpConnection", launchStart);
  assert.notEqual(launchStart, -1);
  assert.notEqual(launchEnd, -1);

  const executable = String.raw`C:\Users\alice\AppData\Roaming\Codex Panel\codex-runtime\codex.exe`;
  const profile = String.raw`C:\Users\alice\AppData\Roaming\Codex Panel\codex-profile`;
  const launches = [];
  let spawnMode = "failure";
  let browserOpenCount = 0;
  class TestPipeBrowser {
    constructor(child) {
      this.child = child;
    }

    async open() {
      browserOpenCount += 1;
    }
  }
  const { launchCodexWithPipe } = vm.runInNewContext(
    `(() => {
      ${source.slice(launchStart, launchEnd)}
      return { launchCodexWithPipe };
    })()`,
    {
      CdpPipeBrowser: TestPipeBrowser,
      Error,
      once,
      validatedCodexExecutablePath: (appPath) => appPath,
      independentCodexProfilePath: profile,
      process: { env: { SAFE_VALUE: "kept", CODEX_PANEL_SECRET: "removed" } },
      spawn: (command, args, options) => {
        launches.push({ command, args, options });
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        if (spawnMode === "success") {
          child.pid = 376;
        } else {
          queueMicrotask(() => child.emit("error", Object.assign(
            new Error(`spawn ${command} EPERM`),
            {
              code: "EPERM",
              errno: -4048,
              syscall: `spawn ${command}`,
            },
          )));
        }
        return child;
      },
      withoutPanelLauncherEnvironment: (environment) => ({
        SAFE_VALUE: environment.SAFE_VALUE,
      }),
    },
  );

  await assert.rejects(launchCodexWithPipe(executable), (failure) => {
    assert.equal(failure.managedCodexSpawnFailure, true);
    assert.match(failure.message, /Managed Codex spawn failed/);
    assert.match(failure.message, /--user-data-dir=<panel-profile>/);
    assert.match(failure.message, /code=EPERM/);
    assert.match(failure.message, /errno=-4048/);
    assert.doesNotMatch(failure.message, /codex-profile/);
    return true;
  });
  assert.equal(browserOpenCount, 0);

  spawnMode = "success";
  const launched = await launchCodexWithPipe(executable);
  assert.equal(launched.child.pid, 376);
  assert.equal(browserOpenCount, 1);
  assert.equal(launches.at(-1).command, executable);
  assert.deepEqual(Array.from(launches.at(-1).args), [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--disable-features=LocalNetworkAccessForSubframeNavigations",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(launches.at(-1).options.env)),
    { SAFE_VALUE: "kept" },
  );

  assert.match(source, /if \(!options\.watch \|\| error\?\.managedCodexSpawnFailure !== true\) throw error/);
  assert.equal(source.match(/const launchRequestGeneration = openRequestGeneration;/g)?.length, 3);
  assert.equal(
    source.match(
      /openedRequestGeneration = Math\.max\(\s*openedRequestGeneration,\s*launchRequestGeneration,\s*\);/g,
    )?.length,
    3,
  );
  assert.match(source, /if \(!hasOpenPending\(\)\) continue;/);
  assert.match(source, /idleAfterNormalExit = true;\s*console\.error\(`Waiting for Codex launch:/);
});

test("CSP bypass is activated by one controlled renderer reload", () => {
  assert.match(
    source,
    /export async function waitForRendererReady\([\s\S]*?document\.readyState[\s\S]*?state\?\.href\?\.startsWith\("app:\/\/"\)/,
  );
  assert.match(
    source,
    /export async function reloadRenderer\([\s\S]*?Page\.loadEventFired[\s\S]*?Page\.reload/,
  );

  const injectionStart = source.indexOf("async function injectTarget");
  const injectionEnd = source.indexOf("async function injectAll", injectionStart);
  const injectionSource = source.slice(injectionStart, injectionEnd);
  assert.match(
    injectionSource,
    /waitForRendererReady\(cdp, 15_000\)[\s\S]*?Page\.setBypassCSP[\s\S]*?registerInjectionSource\(cdp, source\)[\s\S]*?reloadRenderer\(cdp, 15_000\)/,
  );
  assert.match(
    injectionSource,
    /reconcileInjectionRuntime\([\s\S]*?reloadRenderer: \(\) => reloadRenderer\(cdp, 15_000\)/,
  );
});

test("injector cleanup never terminates the launched ChatGPT process", () => {
  const cleanupSource = source.slice(
    source.indexOf("  const cleanup = () =>", source.indexOf("async function main")),
    source.indexOf("  try {", source.indexOf("  const cleanup = () =>", source.indexOf("async function main"))),
  );
  assert.match(cleanupSource, /launchedCodex\?\.unref\?\.\(\)/);
  assert.doesNotMatch(cleanupSource, /launchedCodex\.kill/);
});
