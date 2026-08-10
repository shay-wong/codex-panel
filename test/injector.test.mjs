import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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

test("the CDP bridge accepts service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexPanelHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
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

test("Swift manager lifecycle commands return before normal launch setup", () => {
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
});

test("private CDP pipe launch and renderer recovery remain enabled", () => {
  assert.match(source, /--remote-debugging-pipe/);
  assert.match(source, /new CdpPipeBrowser\(child\)/);
  assert.match(source, /pipeCdpRuntime\(launched\.browser\)/);
  assert.match(source, /Page\.setBypassCSP/);
  assert.match(source, /frameReady: window\.__codexPanelInjection__\?\.ready === true/);
  assert.match(source, /hostBridge\.publishHeartbeat\(\)/);
  assert.match(source, /let openPending = options\.open && firstResults\.length === 0/);
  assert.match(source, /if \(idleAfterNormalExit\) continue/);
});

test("injector cleanup never terminates the launched ChatGPT process", () => {
  const cleanupSource = source.slice(
    source.indexOf("  const cleanup = () =>", source.indexOf("async function main")),
    source.indexOf("  try {", source.indexOf("  const cleanup = () =>", source.indexOf("async function main"))),
  );
  assert.match(cleanupSource, /launchedCodex\?\.unref\(\)/);
  assert.doesNotMatch(cleanupSource, /launchedCodex\.kill/);
});
