import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { parsePanelAutomationHostRequest } from "../shared/panel-automation.mjs";

const sourceUrl = new URL("../inject/codex-panel.user.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const webStyles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const webApp = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("injection is an idempotent IIFE guarded by its current source hash", () => {
  assert.match(source, /^\(\(\) => \{/);
  assert.match(source, /const VERSION = "0\.6\.13"/);
  assert.match(source, /const SOURCE_HASH = window\.__CODEX_PANEL_SOURCE_HASH__/);
  assert.match(source, /const SENTINEL_KEY = "__codexPanelInjection__"/);
  assert.match(source, /previous\?\.sourceHash === SOURCE_HASH/);
  assert.match(source, /previous\.refresh\(\);\s*return;/);
  assert.match(source, /sourceHash: SOURCE_HASH/);
  assert.match(source, /window\[SENTINEL_KEY\] = api/);
});

test("embedded page supports ordinary loopback and authenticated opaque modes", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:47823\/\?host=codex/);
  assert.match(source, /window\.__CODEX_PANEL_URL__/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__/);
  assert.match(source, /nextFrame\.name = frameName/);
  assert.match(source, /nextFrame\.src = "about:blank"/);
  assert.match(source, /requestHost\("load-frame", \{ frameName, frameCapability: capability \}\)/);
  assert.match(source, /frameCapability = privateFrame \? crypto\.randomUUID\(\) : ""/);
  assert.match(source, /nextFrame\.setAttribute\("sandbox", "allow-scripts/);
  assert.match(source, /panelOrigin = panelUrl\.origin/);
  assert.match(source, /frameOrigin = privateFrame \? "null" : panelUrl\.origin/);
  assert.match(source, /nextFrame\.src = panelUrl\.href/);
  assert.doesNotMatch(source, /allow-same-origin/);
});

test("entry clones the native Plugins row and the page covers the complete Codex workspace", () => {
  assert.match(source, /const PLUGIN_LABELS = \["插件", "外掛程式", "plugins"\]/);
  assert.match(source, /if \(plugin\) return plugin;/);
  assert.match(source, /return directButtons\.length >= 3/);
  assert.match(source, /const button = reference\.cloneNode\(true\)/);
  assert.match(source, /reference\.after\(entry\)/);
  assert.match(source, /document\.querySelector\("\.app-shell-main-content-frame"\)/);
  assert.match(source, /const surface = viewport\?\.parentElement/);
  assert.match(source, /surface\.appendChild\(page\)/);
  assert.match(source, /#\$\{PAGE_ID\} \{[\s\S]*?top: 0;/);
  assert.doesNotMatch(source, /--codex-panel-top-offset/);
  assert.match(source, /child\.setAttribute\(HIDDEN_ATTRIBUTE, "true"\)/);
  assert.match(source, /page\.hidden = false/);
  assert.doesNotMatch(source, /codex-panel-overlay/);
  assert.doesNotMatch(source, /codex-panel-toolbar/);
  assert.doesNotMatch(source, /aria-modal/);
});

test("conversation content frames can host Panel when they include the native header", () => {
  const findPageHostSource = source.slice(
    source.indexOf("function findPageHost"),
    source.indexOf("function findPageMount"),
  );
  const conversationFrame = {
    kind: "conversation-frame",
    getBoundingClientRect: () => ({ top: 0, width: 1_000, height: 800 }),
  };
  const viewport = {
    children: [conversationFrame],
    getBoundingClientRect: () => ({ top: 0, width: 1_000, height: 800 }),
  };
  const nativeHeader = {
    getBoundingClientRect: () => ({ bottom: 48 }),
  };
  const document = {
    querySelector: (selector) => {
      if (selector === "[data-app-shell-main-content-layout]") return viewport;
      if (selector === "main > header") return nativeHeader;
      return null;
    },
  };
  const findPageHost = vm.runInNewContext(`(${findPageHostSource})`, { document });

  assert.equal(findPageHost().kind, "conversation-frame");
});

test("opening Panel suppresses native selection and contextual header until close", () => {
  assert.match(source, /aside nav\[role="navigation"\] \[aria-current\]/);
  assert.match(source, /node\.removeAttribute\("aria-current"\)/);
  assert.match(source, /NATIVE_SELECTED_ATTRIBUTE/);
  assert.match(source, /app-shell-header-context-menu-surface/);
  assert.match(source, /restoreNativeSelection\(\)/);
  assert.match(source, /function onDocumentClick[\s\S]*closePanel\(false\);/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => closePanel\(false\), 0\)/);
});

test("the embedded header fills the native titlebar without clipping or a full-page no-drag region", () => {
  assert.match(source, /top: 0;/);
  assert.match(source, /z-index: 31 !important/);
  assert.doesNotMatch(source, /headerRightInset/);
  assert.doesNotMatch(source, /NATIVE_HEADER_RIGHT_INSET/);
  assert.doesNotMatch(source, /clip-path: polygon/);
  assert.doesNotMatch(source, /codex-panel-titlebar-fill/);
  assert.doesNotMatch(source, /#\$\{PAGE_ID\} \{[^}]*-webkit-app-region: no-drag !important;/);
  assert.doesNotMatch(source, /#\$\{FRAME_ID\} \{[^}]*-webkit-app-region: no-drag !important;/);
  assert.match(source, /const NO_DRAG_LEFT_ID = "codex-panel-no-drag-left"/);
  assert.match(source, /const NO_DRAG_RIGHT_ID = "codex-panel-no-drag-right"/);
  assert.match(source, /window\.addEventListener\("resize", scheduleRefresh\)/);
});

test("only the empty embedded header spacer is draggable", () => {
  assert.match(webApp, /<div ref=\{dragRegionRef\} className="workspace-drag-region" aria-hidden="true" \/>/);
  assert.match(webApp, /type: "panel:drag-region"/);
  assert.match(source, /const DRAG_REGION_ID = "codex-panel-drag-region"/);
  assert.match(source, /message\.type === "panel:drag-region"/);
  assert.match(source, /function updateDragRegion\(payload\)/);
  assert.match(source, /#\$\{DRAG_REGION_ID\} \{[\s\S]*?-webkit-app-region: drag;/);
  assert.doesNotMatch(webStyles, /\.app-shell\.embedded \.workspace-header \{\s*-webkit-app-region: no-drag;/);
  assert.match(
    webStyles,
    /\.app-shell\.embedded \.workspace-drag-region \{\s*-webkit-app-region: drag;/,
  );
  assert.match(
    webStyles,
    /\.app-shell\.embedded \.workspace-header \.header-actions,[\s\S]*?-webkit-app-region: no-drag;/,
  );
});

test("the embedded header clears the macOS window controls when the Codex sidebar is collapsed", () => {
  assert.match(source, /const MACOS_TITLEBAR_SAFE_LEFT = 80/);
  assert.match(source, /function titlebarLeftInset\(\)/);
  assert.match(source, /if \(nativeSidebarCollapsed\(\)\) return MACOS_TITLEBAR_SAFE_LEFT/);
  assert.match(source, /MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft/);
  assert.match(source, /titlebarLeftInset: titlebarLeftInset\(\)/);
  assert.match(webApp, /--codex-titlebar-left-inset/);
  assert.match(webStyles, /padding-left: calc\(16px \+ var\(--codex-titlebar-left-inset, 0px\)\)/);
});

test("the embedded header exposes Codex's native sidebar expansion when collapsed", () => {
  assert.match(source, /\[data-app-shell-sidebar-trigger="true"\]/);
  assert.match(source, /function nativeSidebarCollapsed\(\)/);
  assert.match(source, /sidebarCollapsed: nativeSidebarCollapsed\(\)/);
  assert.match(source, /message\.type === "panel:expand-sidebar"/);
  assert.match(source, /function expandNativeSidebar\(\)[\s\S]*?trigger\.click\(\)/);
  assert.match(webApp, /embedded && hostContext\?\.sidebarCollapsed/);
  assert.match(webApp, /type: "panel:expand-sidebar"/);
  assert.match(webApp, /className="detail-back-button codex-sidebar-expand-button"/);
  assert.match(webApp, /<LinearIcon name="codexSidebarExpand" \/>/);
  assert.match(webStyles, /\.codex-sidebar-expand-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test("opening asks the resident launcher to ensure the service and rebuilds failed frames", () => {
  assert.match(source, /const HOST_REQUEST_MESSAGE = "__codexPanelHostRequestV1"/);
  assert.match(source, /return requestHost\("ensure"\)/);
  assert.match(source, /result\.restarted/);
  assert.match(source, /loadPanelFrame\(\)/);
  assert.match(source, /waitForFrameReady\(\)/);
  assert.match(source, /function onHostBridgeMessage/);
  assert.match(source, /function hasLiveHostBinding/);
  assert.match(source, /HOST_HEARTBEAT_MAX_AGE_MS/);
});

test("the injected iframe can be cache-busted without reloading the Codex shell", () => {
  assert.match(source, /const FRAME_REFRESH_PARAM = "__codex_panel_refresh"/);
  assert.match(source, /function reloadFrame\(\)/);
  assert.match(source, /loadPanelFrame\(true\)/);
  assert.match(source, /reloadFrame,/);
});

test("private Panel uses CDP while ordinary Panel retains loopback permission", () => {
  assert.match(source, /requestHostLoadFrame\(frameRequest\)/);
  assert.match(source, /if \(usesPrivateFrame\(\)\) await requestHostLoadFrame\(frameRequest\)/);
  assert.match(source, /local-network-access; loopback-network; local-network/);
  assert.match(source, /if \(!usesPrivateFrame\(\)\)[\s\S]*?panel:frame-awaiting-challenge[\s\S]*?postFrameChallenge\(\)/);
});

test("reopening reuses a ready cache-busted iframe without showing the startup placeholder", () => {
  assert.match(source, /function frameMatchesPanelUrl\(panelUrl\)/);
  assert.match(source, /loadedUrl\.searchParams\.delete\(FRAME_REFRESH_PARAM\)/);
  assert.match(source, /expectedUrl\.searchParams\.delete\(FRAME_REFRESH_PARAM\)/);
  const prepareSource = source.slice(
    source.indexOf("async function preparePanel"),
    source.indexOf("function restoreNativeContent"),
  );
  assert.match(prepareSource, /const canReuseFrame = Boolean\([\s\S]*frameMatchesPanelUrl\(panelUrl\)/);
  assert.match(prepareSource, /if \(canReuseFrame\) showFrame\(\);\s*else showLoading\(\);/);
  assert.match(
    prepareSource,
    /if \(!frameReady \|\| result\.restarted \|\| !frameMatchesPanelUrl\(panelUrl\)\) \{\s*showLoading\(\);/,
  );
  assert.doesNotMatch(prepareSource, /async function preparePanel\(generation\) \{\s*showLoading\(\);/);
});

test("iframe messages require both the exact origin and source window", () => {
  assert.match(
    source,
    /event\.source !== frame\.contentWindow \|\| event\.origin !== frameOrigin/,
  );
  assert.match(source, /message\.type === "panel:open-thread"/);
  assert.match(source, /message\.type === "panel:create-thread"/);
  assert.match(source, /message\.capability !== frameCapability/);
  assert.match(source, /message\.challenge !== frameChallenge/);
  assert.match(source, /postMessage\(message, frameOrigin === "null" \? "\*" : frameOrigin\)/);
});

test("custom iframe origins are display-only and cannot cross the native Codex boundary", () => {
  assert.match(source, /function isTrustedPanelOrigin\(origin = panelOrigin \|\| frameOrigin\)/);
  assert.match(source, /return Boolean\(origin\) && origin === managedPanelOrigin\(\)/);
  const postHostContextSource = source.slice(
    source.indexOf("function postHostContext"),
    source.indexOf("function findThreadRow"),
  );
  assert.match(postHostContextSource, /type: "panel:theme"/);
  assert.match(postHostContextSource, /if \(!isTrustedPanelOrigin\(\)\) return/);
  assert.match(postHostContextSource, /type: "panel:host-context"/);
  assert.ok(
    postHostContextSource.indexOf('type: "panel:theme"')
      < postHostContextSource.indexOf("if (!isTrustedPanelOrigin()) return"),
  );
  assert.ok(
    postHostContextSource.indexOf("if (!isTrustedPanelOrigin()) return")
      < postHostContextSource.indexOf('type: "panel:host-context"'),
  );

  const frameMessageSource = source.slice(
    source.indexOf("function onFrameMessage"),
    source.indexOf("function updateDragRegion"),
  );
  assert.match(frameMessageSource, /message\.type === "panel:drag-region"[\s\S]*?return/);
  assert.match(frameMessageSource, /if \(!isTrustedPanelOrigin\(\)\) return/);
  assert.ok(
    frameMessageSource.indexOf('message.type === "panel:drag-region"')
      < frameMessageSource.indexOf("if (!isTrustedPanelOrigin()) return"),
  );
  for (const type of ["panel:open-thread", "panel:expand-sidebar", "panel:automation-request", "panel:create-thread"]) {
    assert.ok(
      frameMessageSource.indexOf("if (!isTrustedPanelOrigin()) return")
        < frameMessageSource.indexOf(`message.type === "${type}"`),
      `${type} must require the managed Panel origin`,
    );
  }
});

test("the iframe automation contract is forwarded through the fixed host binding", () => {
  assert.match(source, /message\.type === "panel:automation-request"/);
  assert.match(source, /function handleAutomationRequest\(payload\)/);
  assert.match(source, /requestHost\(\s*"automation",\s*buildAutomationHostPayload\(payload\),\s*\)/);
  assert.match(source, /operation: payload\.operation/);
  assert.match(source, /panelProjectId: payload\.panelProjectId/);
  assert.match(source, /codexProjectId: payload\.codexProjectId/);
  assert.match(source, /workspacePath: payload\.workspacePath/);
  assert.match(source, /skillPath: payload\.skillPath/);
  assert.match(source, /model: payload\.model/);
  assert.match(source, /reasoningEffort: payload\.reasoningEffort/);
  assert.match(source, /type: "panel:automation-response"/);
  assert.match(source, /requestId,\s*ok: true,\s*item: response\.item/);
  assert.match(source, /items: response\.items/);
  assert.match(source, /requestId,\s*ok: false,\s*error:/);
  assert.match(source, /type: HOST_REQUEST_MESSAGE/);
  assert.match(source, /capability: HOST_CAPABILITY/);
  assert.match(source, /payload: \{ \.\.\.payload, id, action \}/);
});

test("complete App automation payloads cross the injected forwarder into the current parser", () => {
  const functionSource = source.slice(
    source.indexOf("function buildAutomationHostPayload"),
    source.indexOf("\n\n  async function handleAutomationRequest"),
  );
  assert.ok(functionSource.startsWith("function buildAutomationHostPayload"));
  const buildAutomationHostPayload = vm.runInNewContext(`(${functionSource})`);
  const basePayload = {
    requestId: "request-1",
    panelProjectId: "local",
    codexProjectId: "codex-project",
    projectName: "Local",
    workspacePath: "/tmp/local-project",
    skillPath: "/tmp/manage-panel/SKILL.md",
    automationId: "automation-1",
    enabledByUser: true,
    quotaAware: true,
    intervalMinutes: 10,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };

  for (const operation of ["list", "pause", "ensure-active", "apply-policy"]) {
    const forwarded = {
      id: `host-${operation}`,
      action: "automation",
      ...buildAutomationHostPayload({ ...basePayload, operation }),
    };
    assert.deepEqual(
      parsePanelAutomationHostRequest(forwarded),
      forwarded,
      `${operation} must retain model and reasoningEffort`,
    );
  }

});

test("stored automation policies are reconciled before returning automation state", () => {
  assert.match(
    injectorSource,
    /request\.operation === "list"[\s\S]*?reconcileStoredAutomationPolicy\([\s\S]*?request\.panelProjectId,[\s\S]*?return stored \?\? reconcilePanelAutomation\(request, rpc\)/,
  );
  assert.match(
    injectorSource,
    /request\.operation === "apply-policy"[\s\S]*?updateAndApplyQuotaPolicy\(request, rpc\)[\s\S]*?: reconcilePanelAutomation\(request, rpc\)/,
  );
});

test("only the managed Panel iframe can request native automation", () => {
  assert.match(
    source,
    /if \(!isTrustedPanelOrigin\(\)\) \{\s*postToFrame\(\{\s*type: "panel:automation-response"/,
  );
});

test("issues open an unsent native Codex composer in the exact workspace with a Skill mention", () => {
  assert.match(source, /function createThreadForTask\(payload\)/);
  assert.match(source, /\[data-app-action-sidebar-select-project\]/);
  assert.match(source, /data-codex-composer/);
  assert.match(source, /type: "electron-set-active-workspace-root"/);
  assert.match(source, /root: workspacePath/);
  assert.doesNotMatch(source, /prefillPrompt: prompt/);
  assert.match(source, /requestHostTaskComposerPrefill\(\{/);
  assert.match(source, /requestHost\("prefill-task-composer"/);
  assert.match(source, /function waitForPreparedComposer\(identifier, skillPath\)/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /mention\.getAttribute\("skill-mention-path"\) === skillPath/);
  assert.doesNotMatch(source, /submit\.click\(\)/);
  assert.match(source, /type: "panel:thread-prepared"/);
  assert.doesNotMatch(source, /function waitForCreatedThread/);
  assert.match(source, /type: "panel:thread-created"/);
  assert.match(webApp, /panel:thread-created/);
  assert.match(webApp, /function issueThreadInstruction\(task: Task, handoff: string \| null\)/);
  assert.match(webApp, /`e-panel Continue work on issue \$\{task\.identifier\}: \$\{task\.title\}`/);
  assert.match(webApp, /use panelctl to read the latest issue content and every comment/);
  assert.match(webApp, /Latest conversation handoff for immediate context/);
  assert.match(
    webApp,
    /const prompt = `\[\$manage-panel\]\(\$\{managePanelSkillPath\}\) \$\{instruction\}`/,
  );
  assert.match(webApp, /skillName: "manage-panel"/);
  assert.match(webApp, /skillDisplayName: "Manage Panel"/);
  assert.match(webApp, /skillPath: managePanelSkillPath/);
  assert.match(webApp, /instruction,/);
  assert.match(webApp, /type: "panel:create-thread"/);
  assert.match(webApp, /type: "panel:open-thread",\s*payload: binding/);
  assert.match(source, /await waitForRemoteProject\(requestedProjectId, codexHostId, targetRoot\)/);
  assert.match(source, /type: "panel:thread-created",\s*payload: \{ taskId, threadId: startedThreadId \}/);
  assert.match(source, /type: "panel:thread-prepared", payload: \{ taskId \}/);
});

test("the standalone web page opens linked Codex tasks through the app deep link", () => {
  assert.match(webApp, /window\.location\.assign\(`codex:\/\/threads\/\$\{encodeURIComponent\(threadId\.trim\(\)\)\}`\)/);
});

test("the injected app opens an existing local Codex task instead of a new composer", () => {
  const openThreadSource = source.slice(
    source.indexOf("async function openThread"),
    source.indexOf("function projectRowById"),
  );
  assert.match(openThreadSource, /if \(row\?\.isConnected\) \{\s*row\.click\?\.\(\);\s*return;/);
  assert.match(openThreadSource, /await dispatchHostMessage\(\{\s*type: "navigate-to-route",\s*path: routeForThread\(normalizedThreadId\)/);
  assert.match(source, /return `\/local\/\$\{encodeURIComponent\(threadId\)\}`/);
  assert.doesNotMatch(source, /return `\/thread\/\$\{encodeURIComponent\(threadId\)\}`/);
  assert.doesNotMatch(openThreadSource, /focusComposerNonce/);
});

test("host navigation follows Codex's renderer message bus", () => {
  assert.match(source, /function dispatchHostMessage\(message\)/);
  assert.match(source, /window\.postMessage\(message, window\.location\.origin\)/);
  assert.doesNotMatch(source, /new CustomEvent\("codex-message-from-view"/);
});

test("command-menu native destinations close Panel without global history interception", () => {
  const labelsStart = source.indexOf("const NATIVE_PAGE_LABELS");
  const labelsEnd = source.indexOf("\n\n  const previous", labelsStart);
  const handlerStart = source.indexOf("function handleNativeDestinationCommand");
  const handlerEnd = source.indexOf("\n\n  function onCommandMenuSelect", handlerStart);
  assert.notEqual(labelsStart, -1, "native destination labels must exist");
  assert.ok(labelsEnd > labelsStart, "native destination labels must be extractable");
  assert.notEqual(handlerStart, -1, "native destination handler must exist");
  assert.ok(handlerEnd > handlerStart, "native destination handler must be extractable");
  assert.match(source, /const NATIVE_DESTINATION_COMMAND_LABELS = \[/);
  assert.doesNotMatch(source, /installNativeHistoryInterceptor/);
  assert.doesNotMatch(source, /historyInterceptors/);

  const nativeDestinationLabels = vm.runInNewContext(
    `(() => { ${source.slice(labelsStart, labelsEnd)}; return NATIVE_DESTINATION_COMMAND_LABELS; })()`,
  );
  const traditionalChineseDestinations = [
    "外掛程式",
    "網站",
    "工作站",
    "已排程",
    "Pull Request",
    "程序管理工具",
  ];
  for (const label of traditionalChineseDestinations) {
    assert.ok(
      nativeDestinationLabels.includes(label.toLowerCase()),
      `production labels must include ${label}`,
    );
  }

  let active = true;
  let destroyed = false;
  let closeCount = 0;
  const timers = [];
  const window = {
    location: { pathname: "/local/current" },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  };
  const handleNativeDestinationCommand = vm.runInNewContext(
    `(${source.slice(handlerStart, handlerEnd)})`,
    {
      get active() {
        return active;
      },
      get destroyed() {
        return destroyed;
      },
      NATIVE_DESTINATION_COMMAND_LABELS: nativeDestinationLabels,
      closePanel: () => {
        active = false;
        closeCount += 1;
      },
      normalizedLabel: (value) => String(value || "").trim().toLowerCase(),
      window,
    },
  );
  const target = (label, global = true) => {
    const item = { getAttribute: (name) => name === "data-value" ? label : null };
    return {
      closest: (selector) => selector === '.global-command-menu-dialog [cmdk-item][role="option"]' && global
        ? item
        : null,
    };
  };

  for (const label of [
    "切换到聊天",
    "设置",
    "插件",
    ...traditionalChineseDestinations,
  ]) {
    active = true;
    assert.equal(handleNativeDestinationCommand(target(label)), true, label);
  }
  assert.equal(closeCount, 3 + traditionalChineseDestinations.length);

  active = true;
  assert.equal(handleNativeDestinationCommand(target("切换到深色主题")), false);
  timers.shift()();
  assert.equal(closeCount, 3 + traditionalChineseDestinations.length);
  assert.equal(active, true);

  assert.equal(handleNativeDestinationCommand(target("打开其他原生页面")), false);
  window.location.pathname = "/native-page";
  timers.shift()();
  assert.equal(closeCount, 4 + traditionalChineseDestinations.length);
  assert.equal(active, false);

  active = true;
  assert.equal(handleNativeDestinationCommand(target("设置", false)), false);
  assert.equal(timers.length, 0);
  assert.equal(active, true);

  destroyed = true;
  assert.match(source, /document\.addEventListener\("cmdk-item-select", onCommandMenuSelect, true\)/);
  assert.match(source, /document\.removeEventListener\("cmdk-item-select", onCommandMenuSelect, true\)/);
});

test("the standalone web page opens unlinked issues as prefilled empty Codex tasks", () => {
  assert.match(webApp, /const query = new URLSearchParams\(\)/);
  assert.match(webApp, /query\.set\("path", workspacePath\)/);
  assert.match(webApp, /query\.set\("prompt", prompt\)/);
  assert.match(webApp, /window\.location\.assign\(`codex:\/\/new\?/);
});

test("host context captures all Codex projects even when the sidebar section is collapsed", () => {
  assert.match(source, /function readCodexProjects\(metadata = codexProjectMetadata\)/);
  assert.match(source, /projectKind: "remote", workspacePath, hostId/);
  assert.match(source, /\[data-app-action-sidebar-project-row\]/);
  assert.match(source, /data-app-action-sidebar-project-id/);
  assert.match(source, /function findProjectsSection\(\)/);
  assert.match(source, /data-app-action-sidebar-section-collapsed/);
  assert.match(source, /async function captureHostContext\(\)/);
  assert.match(source, /while \(!section && Date\.now\(\) < sectionDeadline\)/);
  assert.match(source, /isTrustedPanelOrigin\(panelUrl\.origin\)\s*\? captureHostContext\(\)\s*:\s*Promise\.resolve\(null\)/);
  assert.match(source, /let lastNativeThreadId = ""/);
  assert.match(source, /clickedThreadId.*lastNativeThreadId/s);
  assert.match(source, /const currentThreadId = activeThreadId \|\| runningThreadId \|\| lastNativeThreadId/);
  assert.match(source, /const threadId = currentThreadId \|\| lastNativeThreadId \|\| normalizeThreadId\(threadIdFromLocation\(\)\)/);
  assert.match(source, /replace\(\/\^\(\?:local\|cloud\):\/i, ""\)/);
  assert.match(source, /function findTasksSection\(\)/);
});

test("cleanup removes observers, listeners, timers and owned DOM", () => {
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /window\.removeEventListener\("message", onFrameMessage\)/);
  assert.match(source, /document\.removeEventListener\("click", onDocumentClick, true\)/);
  assert.match(source, /window\.removeEventListener\("popstate", onNativeRouteChange\)/);
  assert.match(source, /window\.clearTimeout\(reattachTimer\)/);
  assert.match(source, /data-codex-panel-owned/);
  assert.match(source, /delete window\[SENTINEL_KEY\]/);
});

test("host integration stays thin", () => {
  assert.match(source, /new MutationObserver\(scheduleRefresh\)/);
  assert.match(source, /type: "panel:host-context"/);
  assert.match(source, /type: "panel:theme"/);
  assert.match(source, /type: "navigate-to-route"/);
  assert.doesNotMatch(source, /__codexSessionDeleteBridge/);
  assert.doesNotMatch(source, /import\s*\(/);
  assert.doesNotMatch(source, /window\.fetch\s*=/);
});
