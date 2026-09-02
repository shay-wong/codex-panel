import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { parsePanelAutomationHostRequest } from "../shared/panel-automation.mjs";

const sourceUrl = new URL("../inject/codex-panel.user.js", import.meta.url);
const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");
const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const webStyles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const webApp = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const createThreadSource = source.slice(
  source.indexOf("async function createThreadForTask"),
  source.indexOf("\n  function buildAutomationHostPayload"),
);
const openRemoteThreadSource = webApp.slice(
  webApp.indexOf("async function openRemoteTaskInThread"),
  webApp.indexOf("\n  async function openTaskInThread"),
);
const bindRemoteThreadSource = webApp.slice(
  webApp.indexOf("async function bindPreparedRemoteThread"),
  webApp.indexOf("\n  async function openRemoteTaskInThread"),
);

function hostRequestHarness({ heartbeatDelayMs, bindingWaitTimeoutMs = 100 }) {
  const start = source.indexOf("  function hasLiveHostBinding");
  const end = source.indexOf("\n  function requestHostEnsure", start);
  const functionSource = source.slice(start, end);
  return vm.runInNewContext(`(() => {
    let hostHeartbeatAt = 0;
    let hostRequestSequence = 0;
    const hostRequests = new Map();
    ${functionSource}
    return async () => {
      if (heartbeatDelayMs !== null) {
        window.setTimeout(() => { hostHeartbeatAt = Date.now(); }, heartbeatDelayMs);
      }
      const response = requestHost("prefill-task-composer", { instruction: "Plan" }, 100);
      const responder = window.setInterval(() => {
        const pending = hostRequests.entries().next().value;
        if (!pending) return;
        const [id, request] = pending;
        hostRequests.delete(id);
        request.resolve({ ok: true });
      }, 1);
      try {
        return await response;
      } finally {
        window.clearInterval(responder);
      }
    };
  })()`, {
    heartbeatDelayMs,
    HOST_CAPABILITY: "capability",
    HOST_HEARTBEAT_MAX_AGE_MS: 8_000,
    HOST_BINDING_READY_TIMEOUT_MS: bindingWaitTimeoutMs,
    HOST_REQUEST_TIMEOUT_MS: 100,
    HOST_REQUEST_MESSAGE: "host-request",
    window: {
      location: { origin: "app://-" },
      postMessage: () => {},
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    },
  });
}

function loadLatestAiChatHandoff() {
  const start = webApp.indexOf("function latestAiChatHandoff");
  const end = webApp.indexOf("\nfunction issueThreadInstruction", start);
  const functionSource = webApp.slice(start, end)
    .replace(/comments: Comment\[\]/, "comments")
    .replace(/text: \(chinese: string, english: string\) => string/, "text")
    .replace(/\): string \| null/, ")");
  return new Function(
    "AI_CHAT_HANDOFF_COMMENT_MARKER",
    "NATIVE_HANDOFF_CONTEXT_LIMIT",
    `${functionSource}\nreturn latestAiChatHandoff;`,
  )("<!-- codex-panel:ai-chat-handoff:v1 -->", 12_000);
}

function loadIssueThreadInstruction() {
  const start = webApp.indexOf("function issueThreadInstruction");
  const end = webApp.indexOf("\ninterface LocalRealtimeSyncProps", start);
  const functionSource = webApp.slice(start, end)
    .replace(/task: Task/, "task")
    .replace(/handoff: string \| null/, "handoff")
    .replace(/text: \(chinese: string, english: string\) => string/, "text")
    .replace(/\): string/, ")");
  return new Function(`${functionSource}\nreturn issueThreadInstruction;`)();
}

function loadRemoteTaskInstruction() {
  const start = webApp.indexOf("function remoteTaskInstruction");
  const end = webApp.indexOf("\n  function updateTaskFromRemoteThread", start);
  const functionSource = webApp.slice(start, end)
    .replace(/task: Task/, "task")
    .replace(/comments: Comment\[\]/, "comments")
    .replace(/text: \(chinese: string, english: string\) => string/, "text");
  return new Function(`${functionSource}\nreturn remoteTaskInstruction;`)();
}

function pendingThreadAssociationHarness({ pending, threadId, projectMatches = true }) {
  const start = source.indexOf("async function publishPendingThreadAssociation");
  const end = source.indexOf("\n  function dispatchHostMessage", start);
  const functionSource = source.slice(start, end);
  return vm.runInNewContext(`(() => {
    let pendingThreadAssociation = initialPending;
    let lastNativeThreadId = "";
    const messages = [];
    const hostRequests = [];
    function setPendingThreadAssociation(value) {
      pendingThreadAssociation = value;
    }
    ${functionSource}
    return {
      run: async () => {
        await publishPendingThreadAssociation();
        return { pendingThreadAssociation, lastNativeThreadId, messages, hostRequests };
      },
    };
  })()`, {
    initialPending: pending,
    isTrustedPanelOrigin: () => true,
    normalizeThreadId: (value) => String(value || "").replace(/^(?:local|cloud):/i, ""),
    threadIdFromLocation: () => threadId,
    findThreadRowInProject: () => projectMatches ? {} : null,
    requestHost: async (action, payload) => {
      pending.hostRequests?.push([action, payload]);
      return { confirmed: true };
    },
    postToFrame: (message) => pending.messages?.push(message),
    TASK_CONVERSATION_REQUEST_TIMEOUT_MS: 75_000,
  });
}

function loadMarkPendingThreadAssociationSubmitted() {
  const start = source.indexOf("function markPendingThreadAssociationSubmitted");
  const end = source.indexOf("\n  async function publishPendingThreadAssociation", start);
  const functionSource = source.slice(start, end);
  return (pending, event) => vm.runInNewContext(`(() => {
    let pendingThreadAssociation = pending;
    ${functionSource}
    markPendingThreadAssociationSubmitted(event);
    return pendingThreadAssociation;
  })()`, {
    pending,
    event,
    normalizedLabel: (value) => String(value || "").trim().toLowerCase(),
    SEND_LABELS: ["send", "发送", "傳送"],
    persistPendingThreadAssociation: () => {},
  });
}

function nativeControl({ textContent, left = 0, style = {}, onClick = () => {} }) {
  const rect = { left, top: 0, width: 120, height: 32 };
  return {
    attributes: {},
    click: onClick,
    contains(candidate) {
      return candidate === this;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    getBoundingClientRect: () => rect,
    hitAt: (x, y) => x >= rect.left && x <= rect.left + rect.width
      && y >= rect.top && y <= rect.top + rect.height,
    style: {
      display: "block",
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
      ...style,
    },
    textContent,
  };
}

function selectNativeWorktreeHarness({ triggers, item, now }) {
  const helperStart = source.indexOf("function isInteractiveElement");
  const helperEnd = source.indexOf("\n  function normalizeThreadId", helperStart);
  const selectStart = source.indexOf("async function selectNativeWorktree");
  const selectEnd = source.indexOf("\n  async function createThreadForTask", selectStart);
  const elements = [...triggers, item].filter(Boolean);
  const document = {
    elementFromPoint: (x, y) => elements.find((element) => (
      element.style.pointerEvents !== "none"
      && Number.parseFloat(element.style.opacity) > 0
      && element.hitAt(x, y)
    )) ?? null,
    querySelectorAll: (selector) => selector === '[role="menuitem"]'
      ? (item ? [item] : [])
      : triggers,
  };
  return vm.runInNewContext(`(async () => {
    ${source.slice(helperStart, helperEnd)}
    ${source.slice(selectStart, selectEnd)}
    await selectNativeWorktree();
  })()`, {
    Date: { now },
    document,
    NATIVE_WORKTREE_LABELS: ["新建本地工作树", "新增本機工作樹", "new local worktree"],
    normalizedLabel: (value) => String(value || "").trim().toLowerCase(),
    window: {
      getComputedStyle: (element) => element.style,
      setTimeout: (resolve) => resolve(),
    },
  });
}

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
  assert.match(source, /const PLUGIN_LABELS = \["插件", "外掛程式", "plugins", "プラグイン"\]/);
  assert.match(source, /if \(plugin\) return plugin;/);
  assert.match(source, /button\.getAttribute\(OWNED_ATTRIBUTE\) !== "true"/);
  assert.match(source, /rect\.bottom <= sectionTop/);
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

test("entry recognizes known Plugins labels and structurally anchors an unenumerated locale", () => {
  const normalizedLabelSource = source.slice(
    source.indexOf("function normalizedLabel"),
    source.indexOf("\n\n  function normalizeThreadId"),
  );
  const referenceSource = source.slice(
    source.indexOf("function buttonMatches"),
    source.indexOf("\n\n  function replaceEntryIcon"),
  );
  let currentButtons;
  let currentSection;
  const scroll = {
    querySelector: (selector) => selector === "[data-app-action-sidebar-section]" ? currentSection : null,
    querySelectorAll: (selector) => selector === "button" ? currentButtons : [],
  };
  const findReferenceButton = vm.runInNewContext(`(() => {
    const PLUGIN_LABELS = ["插件", "外掛程式", "plugins", "プラグイン"];
    const OWNED_ATTRIBUTE = "data-codex-panel-owned";
    ${normalizedLabelSource}
    ${referenceSource}
    return findReferenceButton;
  })()`, {
    document: { querySelector: () => scroll },
  });

  for (const textContent of ["插件", "外掛程式", "プラグイン", "Plugins"]) {
    const currentButton = {
      textContent,
      getAttribute: () => null,
      parentElement: {},
    };
    currentButtons = [currentButton];
    currentSection = null;
    assert.equal(findReferenceButton(), currentButton);
  }

  const topButton = (textContent, top, owned = false) => ({
    textContent,
    getAttribute: (name) => name === "data-codex-panel-owned" && owned ? "true" : null,
    getBoundingClientRect: () => ({ top, bottom: top + 30, height: 30 }),
    parentElement: {},
  });
  const unenumeratedPlugin = topButton("Приклучоци", 160);
  currentButtons = [
    topButton("Барања за повлекување", 100),
    topButton("Локации", 120),
    topButton("Закажано", 140),
    unenumeratedPlugin,
    topButton("Panel", 180, true),
  ];
  currentSection = { getBoundingClientRect: () => ({ top: 200 }) };
  assert.equal(findReferenceButton(), unenumeratedPlugin);
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

test("host requests wait briefly for the launcher bridge heartbeat", async () => {
  const request = hostRequestHarness({ heartbeatDelayMs: 20 });
  assert.equal((await request()).ok, true);
});

test("host requests report an initializing bridge only after the wait limit", async () => {
  const request = hostRequestHarness({ heartbeatDelayMs: null, bindingWaitTimeoutMs: 20 });
  await assert.rejects(request(), /Codex 桥接尚未就绪，请稍后重试/);
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

test("issues open an unsent native Codex composer in the confirmed project", () => {
  const createThreadSource = source.slice(
    source.indexOf("async function createThreadForTask"),
    source.indexOf("function buildAutomationHostPayload"),
  );
  assert.match(source, /async function createThreadForTask\(payload\)/);
  assert.match(source, /async function nativeProjectContext\(\)/);
  assert.match(source, /async function activeNativeWorkspaceRoots\(\)/);
  assert.match(source, /requestNativeFetch\("active-workspace-roots", \{\}\)/);
  assert.match(source, /available: Array\.isArray\(roots\)/);
  assert.match(source, /function normalizeNativeRootPath\(value\)/);
  assert.match(source, /async function canonicalNativeRootPaths\(roots\)/);
  assert.match(source, /requestNativeFetch\("workspace-root-options", \{\s*hostId: "local",\s*canonicalizeRoots: roots,/);
  assert.match(source, /async function resolveNativeProject\(requestedProjectId, workspacePath\)/);
  assert.match(source, /let project = context\.projects\.find\(\(candidate\) => candidate\.id === requestedProjectId\) \?\? null/);
  assert.match(source, /if \(!project && normalizedWorkspacePath\)/);
  assert.match(source, /const targetRoot = normalizedWorkspacePath \? workspacePath : project\?\.rootPaths\[0\]/);
  assert.match(source, /async function waitForNativeProject\(targetRoot, expectedProjectId\)/);
  const waitStart = source.indexOf("async function waitForNativeProject");
  const waitSource = source.slice(waitStart, source.indexOf("async function createThreadForTask", waitStart));
  assert.match(waitSource, /selectedNativeProjectId\(\)/);
  assert.match(waitSource, /activeNativeWorkspaceRoots\(\)/);
  assert.match(waitSource, /if \(projectId\)/);
  assert.match(waitSource, /if \(projectId === expectedProjectId\) return projectId/);
  assert.match(waitSource, /canonicalNativeRootPaths\(\[\s*targetRoot,\s*\.\.\.activeWorkspace\.roots,/);
  assert.match(waitSource, /canonicalActiveRoots\.some\(\(root\) => root === canonicalTargetRoot\)/);
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
  assert.doesNotMatch(createThreadSource, /electron-add-new-workspace-root-option/);
  assert.doesNotMatch(source, /prefillPrompt: prompt/);
  assert.match(source, /requestHostTaskComposerPrefill\(\{/);
  assert.match(source, /requestHost\("prefill-task-composer"/);
  assert.match(source, /function waitForPreparedComposer\(identifier, skills\)/);
  assert.match(source, /lastNativeProjectId = await waitForNativeProject\(target\.targetRoot, target\.projectId\)/);
  assert.match(
    createThreadSource,
    /await requestHostTaskComposerPrefill\([\s\S]*?await waitForPreparedComposer\(identifier, \[\]\)/,
  );
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /mention\.getAttribute\("skill-mention-path"\) === skill\.path/);
  assert.doesNotMatch(source, /submit\.click\(\)/);
  assert.match(source, /type: "panel:thread-prepared"/);
  assert.doesNotMatch(source, /function waitForCreatedThread/);
  assert.match(source, /type: "panel:thread-created"/);
  assert.match(webApp, /panel:thread-created/);
  assert.match(
    webApp,
    /function issueThreadInstruction\([\s\S]*text: \(chinese: string, english: string\) => string/,
  );
  assert.doesNotMatch(webApp, /e-panel Continue work on issue/);
  assert.match(webApp, /处理 Panel 议题 \$\{task\.identifier\}：\$\{task\.title\}/);
  assert.match(webApp, /Continue work on issue \$\{task\.identifier\}: \$\{task\.title\}/);
  assert.match(webApp, /开始前，使用 panelctl 读取/);
  assert.match(webApp, /Before acting, use panelctl to read/);
  assert.match(webApp, /最新对话交接，供立即参考/);
  assert.match(webApp, /Latest conversation handoff for immediate context/);
  assert.match(webApp, /\[交接内容已截断，请使用 panelctl 读取完整评论\]/);
  assert.match(webApp, /\[Conversation handoff truncated; use panelctl to read the full comment\]/);
  assert.match(webApp, /latestAiChatHandoff\(await listComments\(task\.id\), text\)/);
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
  assert.match(createThreadSource, /prefillPrompt: instruction/);
  assert.match(createThreadSource, /await waitForPreparedComposer\(identifier, \[\]\)/);
  assert.match(createThreadSource, /const autoSubmit = payload\?\.autoSubmit === true/);
  assert.match(
    createThreadSource,
    /if \(autoSubmit\) \{[\s\S]*?requestHostTaskConversationStart\([\s\S]*?bind-native-claim/,
  );
  assert.match(source, /data-composer-navigation-target="run-location"/);
  assert.match(createThreadSource, /await selectNativeWorktree\(\)/);
  assert.match(injectorSource, /nativeDevelopmentContext\([\s\S]*?result\.thread\.cwd/);
  assert.match(injectorSource, /gitValue\(root, \["branch", "--show-current"\]\)/);
  assert.match(
    createThreadSource,
    /if \(autoSubmit\) \{[\s\S]*?return;[\s\S]*?setPendingThreadAssociation\(\{/,
  );
  assert.doesNotMatch(createThreadSource, /Input\.dispatchKeyEvent/);
  assert.doesNotMatch(openRemoteThreadSource, /moveTaskRequest/);
  assert.match(webApp, /remoteTaskInstruction\(latestTask, comments, textRef\.current\)/);
  assert.match(webApp, /Panel claims the issue and binds the new SSH conversation only after this draft is sent/);
  assert.match(source, /type: "panel:thread-prepared", payload: \{ taskId \}/);
  assert.match(source, /requestHost\("confirm-task-conversation"/);
  assert.match(injectorSource, /item\?\.type === "userMessage"/);
  assert.match(injectorSource, /firstUserText\.includes\(request\.identifier\)/);
  assert.match(bindRemoteThreadSource, /latestTask\.projectId !== pending\.projectId/);
  assert.match(bindRemoteThreadSource, /JSON\.stringify\(latestTask\.developmentContext\) !== pending\.developmentContext/);
});

test("native worktree selection skips stale covered controls", async () => {
  let staleClicks = 0;
  let triggerClicks = 0;
  let itemClicks = 0;
  let timestamp = 0;
  const staleTrigger = nativeControl({
    textContent: "本地",
    style: { opacity: "0", pointerEvents: "none" },
    onClick: () => { staleClicks += 1; },
  });
  const trigger = nativeControl({
    textContent: "本地",
    left: 140,
    onClick: () => {
      triggerClicks += 1;
      trigger.attributes["aria-expanded"] = "true";
    },
  });
  const item = nativeControl({
    textContent: "新建本地工作树",
    left: 280,
    onClick: () => {
      itemClicks += 1;
      trigger.textContent = "新建本地工作树";
    },
  });

  await selectNativeWorktreeHarness({
    triggers: [staleTrigger, trigger],
    item,
    now: () => { timestamp += 40; return timestamp; },
  });

  assert.equal(staleClicks, 0);
  assert.equal(triggerClicks, 1);
  assert.equal(itemClicks, 1);
});

test("native worktree selection waits for the menu to open", async () => {
  let itemClicks = 0;
  let timestamp = 0;
  const trigger = nativeControl({ textContent: "本地" });
  const item = nativeControl({
    textContent: "新建本地工作树",
    left: 140,
    onClick: () => { itemClicks += 1; },
  });

  await assert.rejects(
    selectNativeWorktreeHarness({
      triggers: [trigger],
      item,
      now: () => { timestamp += 1_000; return timestamp; },
    }),
    /Codex 没有切换到新建本地工作树/,
  );
  assert.equal(itemClicks, 0);
});

test("local Jira planning resolves the saved Codex project before applying its workspace", () => {
  assert.match(
    createThreadSource,
    /if \(!projectless\) \{[\s\S]*?resolveNativeProject\(requestedProjectId, workspacePath\)[\s\S]*?ensureProjectRows\(\)[\s\S]*?projectRowById\(target\.projectId\)[\s\S]*?selectProject\.click\?\.\(\)[\s\S]*?waitForNativeProject\(target\.targetRoot, target\.projectId\)/,
  );
  assert.doesNotMatch(createThreadSource, /electron-add-new-workspace-root-option/);
});

test("Jira planning recovers a stored matching conversation before creating another one", () => {
  assert.match(webApp, /recoverExisting: true/);
  assert.match(
    createThreadSource,
    /recoverExisting === true[\s\S]*?requestHost\("find-task-conversations"[\s\S]*?panel:thread-created[\s\S]*?return;/,
  );
  assert.match(source, /PENDING_THREAD_ASSOCIATION_KEY/);
  assert.match(source, /window\.localStorage\.setItem\(PENDING_THREAD_ASSOCIATION_KEY/);
  assert.match(source, /restorePendingThreadAssociation\(\)/);
});

test("an unrelated new thread cannot claim an unsent SSH issue draft", async () => {
  const pending = {
    taskId: "task-1",
    identifier: "REMOTE-7",
    title: "REMOTE-7: Fix bridge",
    existingThreadIds: new Set(["old-thread"]),
    projectId: "ssh-project",
    codexHostId: "ssh-host",
    workspacePath: "/srv/project",
    submitted: false,
    confirming: false,
    expiresAt: Date.now() + 10_000,
    hostRequests: [],
    messages: [],
  };
  const harness = pendingThreadAssociationHarness({
    pending,
    threadId: "unrelated-thread",
  });

  const result = await harness.run();

  assert.equal(result.pendingThreadAssociation.taskId, "task-1");
  assert.deepEqual(pending.hostRequests, []);
  assert.deepEqual(pending.messages, []);
});

test("only the prepared composer submit unlocks thread association", () => {
  const markSubmitted = loadMarkPendingThreadAssociationSubmitted();
  const editor = { isConnected: true };
  const pending = {
    composer: editor,
    submitted: false,
    expiresAt: Date.now() + 10_000,
  };

  markSubmitted(pending, { type: "keydown", target: {}, key: "Enter", shiftKey: false, isComposing: false });
  assert.equal(pending.submitted, false);
  markSubmitted(pending, { type: "keydown", target: editor, key: "Enter", shiftKey: true, isComposing: false });
  assert.equal(pending.submitted, false);
  markSubmitted(pending, { type: "keydown", target: editor, key: "Enter", shiftKey: false, isComposing: false });
  assert.equal(pending.submitted, true);
});

test("a submitted issue draft publishes only after project and host confirmation", async () => {
  const pending = {
    taskId: "task-1",
    identifier: "REMOTE-7",
    title: "REMOTE-7: Fix bridge",
    existingThreadIds: new Set(["old-thread"]),
    projectId: "ssh-project",
    codexHostId: "ssh-host",
    workspacePath: "/srv/project",
    submitted: true,
    confirming: false,
    expiresAt: Date.now() + 10_000,
    hostRequests: [],
    messages: [],
  };
  const harness = pendingThreadAssociationHarness({
    pending,
    threadId: "issue-thread",
  });

  const result = await harness.run();

  assert.deepEqual(JSON.parse(JSON.stringify(pending.hostRequests)), [["confirm-task-conversation", {
    threadId: "issue-thread",
    codexHostId: "ssh-host",
    targetRoot: "/srv/project",
    identifier: "REMOTE-7",
    title: "REMOTE-7: Fix bridge",
  }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(pending.messages)), [{
    type: "panel:thread-created",
    payload: { taskId: "task-1", threadId: "issue-thread" },
  }]);
  assert.equal(result.pendingThreadAssociation, null);
});

test("prepared issue drafts preserve a title for native binding", () => {
  assert.match(source, /title: pendingThreadAssociation\.title/);
  assert.match(source, /title: pending\.title \|\| pending\.identifier/);
  assert.match(source, /title,\s*composer,\s*existingThreadIds/);
});

test("long conversation handoffs use the Panel UI language for truncation", () => {
  const latestAiChatHandoff = loadLatestAiChatHandoff();
  const comments = [{
    body: `<!-- codex-panel:ai-chat-handoff:v1 -->${"x".repeat(12_001)}`,
  }];

  const chinese = latestAiChatHandoff(comments, (zh) => zh);
  const english = latestAiChatHandoff(comments, (_zh, en) => en);

  assert.match(chinese, /\[交接内容已截断，请使用 panelctl 读取完整评论\]$/);
  assert.doesNotMatch(chinese, /Conversation handoff truncated/);
  assert.match(english, /\[Conversation handoff truncated; use panelctl to read the full comment\]$/);
  assert.doesNotMatch(english, /交接内容已截断/);
});

test("issue composer instructions use only the Panel UI language", () => {
  const issueThreadInstruction = loadIssueThreadInstruction();
  const task = { identifier: "LOCAL-42", title: "Preserve context" };

  assert.equal(
    issueThreadInstruction(task, "交接正文", (zh) => zh),
    [
      "处理 Panel 议题 LOCAL-42：Preserve context",
      "开始前，使用 panelctl 读取 LOCAL-42 的最新议题内容和全部评论。将最新的“AI 对话交接”评论视为上一段 Codex 对话的交接信息；更新的议题内容或评论优先。",
      "最新对话交接，供立即参考：\n\n交接正文",
    ].join("\n\n"),
  );
  assert.equal(
    issueThreadInstruction(task, "Handoff body", (_zh, en) => en),
    [
      "Continue work on issue LOCAL-42: Preserve context",
      "Before acting, use panelctl to read the latest issue content and every comment for LOCAL-42. Treat the latest \"AI conversation handoff\" comment as the handoff from the prior Codex conversation; newer issue content or comments take precedence.",
      "Latest conversation handoff for immediate context:\n\nHandoff body",
    ].join("\n\n"),
  );
});

test("SSH issue drafts remain unsent and use only the Panel UI language", () => {
  const remoteTaskInstruction = loadRemoteTaskInstruction();
  const task = {
    identifier: "REMOTE-7",
    title: "Preserve SSH context",
    description: "Issue body",
    developmentContext: { type: "branch", branch: "fix/remote" },
  };
  const comments = [{ authorName: "Shay", createdAt: "2026-08-19", body: "Latest comment" }];

  const chinese = remoteTaskInstruction(task, comments, (zh) => zh);
  const english = remoteTaskInstruction(task, comments, (_zh, en) => en);

  assert.match(chinese, /^处理 Panel 议题 REMOTE-7：Preserve SSH context/);
  assert.match(chinese, /发送这份草稿后，Panel 才会认领议题并绑定新的 SSH 对话/);
  assert.match(chinese, /完整描述：\nIssue body/);
  assert.doesNotMatch(chinese, /Panel claims the issue/);
  assert.match(english, /^Continue work on Panel issue REMOTE-7: Preserve SSH context/);
  assert.match(english, /Panel claims the issue and binds the new SSH conversation only after this draft is sent/);
  assert.match(english, /Full description:\nIssue body/);
  assert.doesNotMatch(english, /发送这份草稿后/);
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

test("native destinations close Panel without global history interception", () => {
  const labelsStart = source.indexOf("const NATIVE_PAGE_LABELS");
  const labelsEnd = source.indexOf("\n\n  const previous", labelsStart);
  const navigationStart = source.indexOf("function isNativePageNavigation");
  const navigationEnd = source.indexOf("\n\n  function handleNativeDestinationCommand", navigationStart);
  const handlerStart = source.indexOf("function handleNativeDestinationCommand");
  const handlerEnd = source.indexOf("\n\n  function onCommandMenuSelect", handlerStart);
  const clickStart = source.indexOf("function onDocumentClick");
  const clickEnd = source.indexOf("\n\n  function onDesktopAppEntry", clickStart);
  assert.notEqual(labelsStart, -1, "native destination labels must exist");
  assert.ok(labelsEnd > labelsStart, "native destination labels must be extractable");
  assert.notEqual(handlerStart, -1, "native destination handler must exist");
  assert.ok(handlerEnd > handlerStart, "native destination handler must be extractable");
  assert.notEqual(navigationStart, -1, "native page navigation handler must exist");
  assert.ok(navigationEnd > navigationStart, "native page navigation handler must be extractable");
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
  const nativeHeaderLabels = vm.runInNewContext(
    `(() => { ${source.slice(labelsStart, labelsEnd)}; return NATIVE_HEADER_DESTINATION_LABELS; })()`,
  );
  for (const label of [
    "view activity, needs attention",
    "查看活动，需要关注",
    "查看活動",
    "查看活動，有項目需要注意",
    "查看活動，需要注意",
  ]) {
    assert.ok(nativeHeaderLabels.includes(label), `production labels must include ${label}`);
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
    "settings 常规",
    "command-menu-quick-chat-result:local:thread-1",
    "插件",
    ...traditionalChineseDestinations,
  ]) {
    active = true;
    assert.equal(handleNativeDestinationCommand(target(label)), true, label);
  }
  assert.equal(closeCount, 5 + traditionalChineseDestinations.length);

  active = true;
  assert.equal(handleNativeDestinationCommand(target("切换到深色主题")), false);
  timers.shift()();
  assert.equal(closeCount, 5 + traditionalChineseDestinations.length);
  assert.equal(active, true);

  assert.equal(handleNativeDestinationCommand(target("打开其他原生页面")), false);
  window.location.pathname = "/native-page";
  timers.shift()();
  assert.equal(closeCount, 6 + traditionalChineseDestinations.length);
  assert.equal(active, false);

  active = true;
  assert.equal(handleNativeDestinationCommand(target("设置", false)), false);
  assert.equal(timers.length, 0);
  assert.equal(active, true);

  destroyed = true;
  assert.match(source, /const NATIVE_HEADER_DESTINATION_LABELS = \[/);
  assert.match(source, /if \(buttonMatches\(clickable, NATIVE_HEADER_DESTINATION_LABELS\)\) return true/);
  const isNativePageNavigation = vm.runInNewContext(
    `(${source.slice(navigationStart, navigationEnd)})`,
    {
      entry: null,
      ENTRY_ID: "codex-panel-entry",
      NATIVE_HEADER_DESTINATION_LABELS: nativeHeaderLabels,
      NATIVE_PAGE_LABELS: [],
      buttonMatches: (button, labels) => labels.includes(
        String(button.textContent || button.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase(),
      ),
    },
  );
  const activityTarget = (label) => {
    const button = {
      textContent: "",
      getAttribute: (name) => name === "aria-label" ? label : null,
      closest: () => null,
      hasAttribute: () => false,
    };
    return {
      closest: (selector) => selector.includes("button") ? button : null,
    };
  };
  for (const label of nativeHeaderLabels) {
    assert.equal(isNativePageNavigation(activityTarget(label)), true, label);
  }
  let activityCloseCount = 0;
  const onActivityClick = vm.runInNewContext(
    `(${source.slice(clickStart, clickEnd)})`,
    {
      active: true,
      isNativePageNavigation,
      handleNativeDestinationCommand: () => false,
      normalizeThreadId: (value) => String(value || "").replace(/^(?:local|cloud):/i, ""),
      closePanel: () => { activityCloseCount += 1; },
    },
  );
  onActivityClick({ target: activityTarget("View activity, needs attention") });
  assert.equal(activityCloseCount, 1);
  const threadRow = {
    closest: (selector) => selector === "[data-app-action-sidebar-thread-id]" ? threadRow : null,
    getAttribute: () => null,
    hasAttribute: (name) => name === "data-app-action-sidebar-thread-id",
  };
  const threadBody = {
    closest: (selector) => selector.includes("button") ? threadRow : null,
  };
  const threadToolButton = {
    closest: (selector) => selector === "[data-app-action-sidebar-thread-id]" ? threadRow : null,
    getAttribute: () => null,
    hasAttribute: () => false,
  };
  const threadTool = {
    closest: (selector) => selector.includes("button") ? threadToolButton : null,
  };
  assert.equal(isNativePageNavigation(threadBody), true, "thread row body navigates");
  assert.equal(isNativePageNavigation(threadTool), false, "nested thread tools do not navigate");
  assert.ok(clickEnd > clickStart, "document click handler must be extractable");
  const clickResult = vm.runInNewContext(`(() => {
    let active = true;
    let lastNativeThreadId = "thread-1";
    let closeCount = 0;
    const normalizeThreadId = (value) => String(value || "").replace(/^(?:local|cloud):/i, "");
    const isNativePageNavigation = (target) => target.navigate;
    const handleNativeDestinationCommand = () => false;
    const closePanel = () => { closeCount += 1; };
    ${source.slice(clickStart, clickEnd)}
    const row = { getAttribute: () => "local:thread-2" };
    onDocumentClick({ target: { navigate: false, closest: () => row } });
    const afterTool = { lastNativeThreadId, closeCount };
    onDocumentClick({ target: { navigate: true, closest: () => row } });
    return { afterTool, afterRow: { lastNativeThreadId, closeCount } };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(clickResult)), {
    afterTool: { lastNativeThreadId: "thread-1", closeCount: 0 },
    afterRow: { lastNativeThreadId: "thread-2", closeCount: 1 },
  });
  assert.match(source, /panelNativeThreadId = normalizeThreadId\(\s*activeThreadRow\(\)\?\.getAttribute/);
  const threadHandlerStart = source.indexOf("function closePanelForNativeThreadChange");
  const threadHandlerEnd = source.indexOf("\n\n  function scheduleRefresh", threadHandlerStart);
  assert.notEqual(threadHandlerStart, -1, "native thread change handler must exist");
  const threadChanges = vm.runInNewContext(`(() => {
    let active = true;
    let lastNativeThreadId = "thread-1";
    let panelNativeThreadId = "thread-1";
    let currentThreadId = "thread-1";
    let closeCount = 0;
    const normalizeThreadId = (value) => String(value || "").replace(/^(?:local|cloud):/i, "");
    const activeThreadRow = () => ({
      getAttribute: () => "local:" + currentThreadId,
    });
    const closePanel = () => {
      active = false;
      closeCount += 1;
    };
    ${source.slice(threadHandlerStart, threadHandlerEnd)}
    const unchanged = closePanelForNativeThreadChange();
    currentThreadId = "thread-2";
    lastNativeThreadId = "thread-2";
    const changed = closePanelForNativeThreadChange();
    return { unchanged, changed, closeCount, active, lastNativeThreadId };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(threadChanges)), {
    unchanged: false,
    changed: true,
    closeCount: 1,
    active: false,
    lastNativeThreadId: "thread-2",
  });
  const initiallyUnknownThread = vm.runInNewContext(`(() => {
    let active = true;
    let lastNativeThreadId = "thread-1";
    let panelNativeThreadId = "";
    let currentThreadId = "thread-1";
    let closeCount = 0;
    const normalizeThreadId = (value) => String(value || "").replace(/^(?:local|cloud):/i, "");
    const activeThreadRow = () => ({
      getAttribute: () => "local:" + currentThreadId,
    });
    const closePanel = () => {
      active = false;
      closeCount += 1;
    };
    ${source.slice(threadHandlerStart, threadHandlerEnd)}
    const established = closePanelForNativeThreadChange();
    const unchanged = closePanelForNativeThreadChange();
    currentThreadId = "thread-2";
    const changed = closePanelForNativeThreadChange();
    return { established, unchanged, changed, closeCount, active, lastNativeThreadId };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(initiallyUnknownThread)), {
    established: false,
    unchanged: false,
    changed: true,
    closeCount: 1,
    active: false,
    lastNativeThreadId: "thread-2",
  });
  assert.match(source, /if \(closePanelForNativeThreadChange\(\)\) return/);
  assert.match(source, /document\.addEventListener\("cmdk-item-select", onCommandMenuSelect, true\)/);
  assert.match(source, /document\.removeEventListener\("cmdk-item-select", onCommandMenuSelect, true\)/);
});

test("native notification app entries close Panel", () => {
  const handlerStart = source.indexOf("function onDesktopAppEntry");
  const handlerEnd = source.indexOf("\n\n  function closePanelForNativeThreadChange", handlerStart);
  assert.ok(handlerEnd > handlerStart, "desktop app entry handler must be extractable");

  const run = (data, eventSource = null) => vm.runInNewContext(`(() => {
    let active = true;
    let closeCount = 0;
    const closePanel = () => { closeCount += 1; };
    ${source.slice(handlerStart, handlerEnd)}
    onDesktopAppEntry({ data, source: eventSource });
    return closeCount;
  })()`, { data, eventSource });
  const notification = {
    type: "desktop-app-entry-received",
    receipt: { attribution: { channel: "push_notification", source: "native_notification" } },
  };
  assert.equal(run(notification), 1);
  assert.equal(run(notification, {}), 0);
  assert.equal(run({
    type: "desktop-app-entry-received",
    receipt: { attribution: { channel: "deep_link", source: "protocol" } },
  }), 0);
  assert.match(source, /window\.addEventListener\("message", onDesktopAppEntry\)/);
  assert.match(source, /window\.removeEventListener\("message", onDesktopAppEntry\)/);
});

test("the standalone web page opens unlinked issues as prefilled empty Codex tasks", () => {
  assert.match(webApp, /const query = new URLSearchParams\(\)/);
  assert.match(webApp, /query\.set\("path", workspacePath\)/);
  assert.match(webApp, /query\.set\("prompt", prompt\)/);
  assert.match(webApp, /window\.location\.assign\(`codex:\/\/new\?/);
});

test("native fetch preserves successful null bodies and returns undefined when unavailable", async () => {
  const functionSource = source.slice(
    source.indexOf("function requestNativeFetch"),
    source.indexOf("\n\n  async function selectedNativeProjectId"),
  );
  const loadRequestNativeFetch = (window) => vm.runInNewContext(`(${functionSource})`, {
    crypto: { randomUUID: () => "request-id" },
    window,
  });
  const responseWindow = (status, bodyJsonString) => {
    let onMessage;
    return {
      electronBridge: {
        sendMessageFromView(message) {
          onMessage({
            data: {
              type: "fetch-response",
              requestId: message.requestId,
              status,
              bodyJsonString,
            },
          });
        },
      },
      setTimeout,
      clearTimeout,
      addEventListener(_type, listener) { onMessage = listener; },
      removeEventListener() {},
    };
  };

  assert.equal(await loadRequestNativeFetch({})("get-global-state", {}), undefined);
  assert.equal(
    await loadRequestNativeFetch(responseWindow(200, "null"))("get-global-state", {}),
    null,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await loadRequestNativeFetch(responseWindow(200, '{"value":null}'))("get-global-state", {}),
    )),
    { value: null },
  );
  assert.equal(
    await loadRequestNativeFetch(responseWindow(500, '{"value":{}}'))("get-global-state", {}),
    undefined,
  );
  assert.equal(
    await loadRequestNativeFetch(responseWindow(200, "{"))("get-global-state", {}),
    undefined,
  );

  let expire;
  const timeoutWindow = {
    electronBridge: { sendMessageFromView() {} },
    setTimeout(callback) { expire = callback; return 1; },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const timeoutRequest = loadRequestNativeFetch(timeoutWindow)("get-global-state", {});
  expire();
  assert.equal(await timeoutRequest, undefined);

  const throwingWindow = {
    electronBridge: { sendMessageFromView() { throw new Error("unavailable"); } },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  assert.equal(
    await loadRequestNativeFetch(throwingWindow)("get-global-state", {}),
    undefined,
  );
});

test("host context captures all Codex projects even when the sidebar section is collapsed", () => {
  assert.match(source, /async function readCodexProjectMetadata\(\)/);
  assert.match(source, /await window\.electronBridge\?\.getInitialSidebarBootstrap\?\.\(\)/);
  assert.match(source, /requestNativeFetch\("get-global-state", \{ key: "local-projects" \}\)/);
  assert.match(source, /requestNativeFetch\("get-global-state", \{ key: "remote-projects" \}\)/);
  assert.match(source, /currentLocalProjects === undefined\s*\? entries\.get\("local-projects"\)\s*: currentLocalProjects\?\.value/);
  assert.match(source, /currentRemoteProjects === undefined\s*\? entries\.get\("remote-projects"\)\s*: currentRemoteProjects\?\.value/);
  assert.match(source, /entries\.get\("local-projects"\)/);
  assert.match(source, /entries\.get\("remote-projects"\)/);
  assert.match(source, /projectKind: "remote"/);
  assert.match(source, /workspacePath,[\s\S]*?hostId/);
  assert.match(source, /function readCodexProjects\(metadata = codexProjectMetadata\)/);
  assert.match(source, /metadata\.set\(id, \{[\s\S]*?projectKind: "remote",[\s\S]*?workspacePath,[\s\S]*?hostId/);
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

test("Codex bootstrap metadata resolves local roots and SSH remote roots asynchronously", async () => {
  const functionSource = source.slice(
    source.indexOf("async function readCodexProjectMetadata"),
    source.indexOf("\n\n  async function activeNativeWorkspaceRoots"),
  );
  const readCodexProjectMetadata = vm.runInNewContext(`(${functionSource})`, {
    requestNativeFetch: async () => undefined,
    window: {
      electronBridge: {
        getInitialSidebarBootstrap: async () => ({
          globalStateEntries: [
            {
              key: "local-projects",
              value: {
                local: { rootPaths: ["/Users/example/project"] },
              },
            },
            {
              key: "remote-projects",
              value: [{
                id: "remote-project",
                hostId: "remote-ssh-discovered:example",
                remotePath: "/srv/example/project",
              }],
            },
          ],
        }),
      },
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify([...(await readCodexProjectMetadata()).entries()])),
    [
      ["local", {
        projectKind: "local",
        hostId: "local",
        workspacePath: "/Users/example/project",
      }],
      ["remote-project", {
        projectKind: "remote",
        workspacePath: "/srv/example/project",
        hostId: "remote-ssh-discovered:example",
        name: "remote-project",
      }],
    ],
  );
});

test("Codex project metadata prefers the live global state over the startup bootstrap", async () => {
  const functionSource = source.slice(
    source.indexOf("async function readCodexProjectMetadata"),
    source.indexOf("\n\n  async function activeNativeWorkspaceRoots"),
  );
  const readCodexProjectMetadata = vm.runInNewContext(`(${functionSource})`, {
    requestNativeFetch: async (_path, body) => ({
      value: body.key === "local-projects"
        ? { live: { rootPaths: ["/Users/example/live"] } }
        : [{
          id: "live-remote",
          hostId: "remote-ssh-discovered:live",
          remotePath: "/srv/live",
          label: "Live Remote",
        }],
    }),
    window: {
      electronBridge: {
        getInitialSidebarBootstrap: async () => ({
          globalStateEntries: [
            {
              key: "local-projects",
              value: { stale: { rootPaths: ["/Users/example/stale"] } },
            },
            {
              key: "remote-projects",
              value: [{
                id: "stale-remote",
                hostId: "remote-ssh-discovered:stale",
                remotePath: "/srv/stale",
              }],
            },
          ],
        }),
      },
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify([...(await readCodexProjectMetadata()).entries()])),
    [
      ["live", {
        projectKind: "local",
        hostId: "local",
        workspacePath: "/Users/example/live",
      }],
      ["live-remote", {
        projectKind: "remote",
        workspacePath: "/srv/live",
        hostId: "remote-ssh-discovered:live",
        name: "Live Remote",
      }],
    ],
  );
});

test("successful empty Codex project state does not revive startup metadata", async () => {
  const functionSource = source.slice(
    source.indexOf("async function readCodexProjectMetadata"),
    source.indexOf("\n\n  async function activeNativeWorkspaceRoots"),
  );
  const bootstrap = {
    globalStateEntries: [
      {
        key: "local-projects",
        value: { stale: { rootPaths: ["/Users/example/stale"] } },
      },
      {
        key: "remote-projects",
        value: [{
          id: "stale-remote",
          hostId: "remote-ssh-discovered:stale",
          remotePath: "/srv/stale",
        }],
      },
    ],
  };
  const loadMetadata = (requestNativeFetch) => vm.runInNewContext(`(${functionSource})`, {
    requestNativeFetch,
    window: {
      electronBridge: { getInitialSidebarBootstrap: async () => bootstrap },
    },
  });

  for (const requestNativeFetch of [
    async () => null,
    async () => ({ value: null }),
    async (_path, body) => ({ value: body.key === "local-projects" ? {} : [] }),
  ]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify([...(await loadMetadata(requestNativeFetch)()).entries()])),
      [],
    );
  }
});

test("new Codex conversations resolve projects added after startup", async () => {
  const functionSource = source.slice(
    source.indexOf("async function nativeProjectContext"),
    source.indexOf("\n\n  async function resolveNativeProject"),
  );
  const nativeProjectContext = vm.runInNewContext(`(${functionSource})`, {
    requestNativeFetch: async () => ({
      value: {
        "live-project": { rootPaths: ["/Users/example/live"] },
      },
    }),
    window: {
      electronBridge: {
        getInitialSidebarBootstrap: async () => ({
          globalStateEntries: [{
            key: "local-projects",
            value: { stale: { rootPaths: ["/Users/example/stale"] } },
          }],
        }),
      },
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify((await nativeProjectContext()).projects)),
    [{ id: "live-project", rootPaths: ["/Users/example/live"] }],
  );
});

test("new Codex conversations only use startup projects when the live request is unavailable", async () => {
  const functionSource = source.slice(
    source.indexOf("async function nativeProjectContext"),
    source.indexOf("\n\n  async function resolveNativeProject"),
  );
  const bootstrap = {
    globalStateEntries: [{
      key: "local-projects",
      value: { stale: { rootPaths: ["/Users/example/stale"] } },
    }],
  };
  const loadContext = (response) => vm.runInNewContext(`(${functionSource})`, {
    requestNativeFetch: async () => response,
    window: {
      electronBridge: { getInitialSidebarBootstrap: async () => bootstrap },
    },
  });

  for (const response of [null, { value: null }, { value: {} }, { value: [] }]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify((await loadContext(response)()).projects)),
      [],
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify((await loadContext(undefined)()).projects)),
    [{ id: "stale", rootPaths: ["/Users/example/stale"] }],
  );
});

test("native root canonicalization follows the filesystem's case sensitivity", async () => {
  const start = source.indexOf("function normalizeNativeRootPath");
  const functionSource = source.slice(
    start,
    source.indexOf("\n\n  function readCodexProjects", start),
  );
  const roots = [
    "/private/tmp/LOCAL344-default/Project",
    "/private/tmp/local344-default/project",
    "/Volumes/LOCAL344CASE/Project",
    "/Volumes/LOCAL344CASE/project",
  ];
  const loadCanonicalizer = (requestNativeFetch) => vm.runInNewContext(`(() => {
    ${functionSource}
    return { normalizeNativeRootPath, canonicalNativeRootPaths };
  })()`, { requestNativeFetch });
  const calls = [];
  const canonicalizer = loadCanonicalizer(async (path, body) => {
    calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
    return {
      canonicalPathByRoot: {
        [roots[0]]: roots[0],
        [roots[1]]: roots[0],
        [roots[2]]: roots[2],
        [roots[3]]: roots[3],
      },
    };
  });
  const canonicalRoots = await canonicalizer.canonicalNativeRootPaths(roots);

  assert.equal(canonicalRoots[0], canonicalRoots[1]);
  assert.notEqual(canonicalRoots[2], canonicalRoots[3]);
  assert.notEqual(
    canonicalizer.normalizeNativeRootPath(roots[2]),
    canonicalizer.normalizeNativeRootPath(roots[3]),
  );
  assert.deepEqual(calls, [{
    path: "workspace-root-options",
    body: { hostId: "local", canonicalizeRoots: roots },
  }]);

  const unavailable = loadCanonicalizer(async () => undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await unavailable.canonicalNativeRootPaths([roots[2], roots[3]]))),
    [roots[2], roots[3]],
  );
  const missingMapping = loadCanonicalizer(async () => ({
    canonicalPathByRoot: { [roots[0]]: "/private/tmp/LOCAL344-default/Project" },
  }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(await missingMapping.canonicalNativeRootPaths([roots[0], roots[1]]))),
    [roots[0], roots[1]],
  );
});

test("native project resolution gives the explicit project ID priority over path candidates", async () => {
  const functionSource = source.slice(
    source.indexOf("async function resolveNativeProject"),
    source.indexOf("\n\n  async function ensureProjectRows"),
  );
  let canonicalCalls = 0;
  const resolveNativeProject = vm.runInNewContext(`(${functionSource})`, {
    nativeProjectContext: async () => ({
      projects: [
        { id: "wrong", rootPaths: ["/Volumes/LOCAL344CASE/project"] },
        { id: "expected", rootPaths: ["/Volumes/LOCAL344CASE/Project"] },
      ],
    }),
    normalizeNativeRootPath: (value) => String(value || "").replace(/\/+$/, ""),
    canonicalNativeRootPaths: async () => { canonicalCalls += 1; return []; },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await resolveNativeProject("expected", "/Volumes/LOCAL344CASE/project"),
    )),
    { projectId: "expected", targetRoot: "/Volumes/LOCAL344CASE/project" },
  );
  assert.equal(canonicalCalls, 0);
});

test("native project confirmation composes exact IDs, root availability, and canonical roots", async () => {
  const normalizeStart = source.indexOf("function normalizeNativeRootPath");
  const canonicalSource = source.slice(
    normalizeStart,
    source.indexOf("\n\n  function readCodexProjects", normalizeStart),
  );
  const waitStart = source.indexOf("async function waitForNativeProject");
  const waitSource = source.slice(
    waitStart,
    source.indexOf("\n\n  async function createThreadForTask", waitStart),
  );
  const loadWait = ({ projectId, activeWorkspace, canonicalPathByRoot }) => {
    let now = 0;
    const canonicalCalls = [];
    const api = vm.runInNewContext(`(() => {
      ${canonicalSource}
      ${waitSource}
      return { waitForNativeProject };
    })()`, {
      Date: { now: () => now },
      activeNativeWorkspaceRoots: async () => activeWorkspace,
      hostText: (_chinese, english) => english,
      requestNativeFetch: async (path, body) => {
        canonicalCalls.push({ path, body: JSON.parse(JSON.stringify(body)) });
        return canonicalPathByRoot === undefined ? undefined : { canonicalPathByRoot };
      },
      selectedNativeProjectId: async () => projectId,
      window: {
        setTimeout(resolve) { now = 8_001; resolve(); },
      },
    });
    return { waitForNativeProject: api.waitForNativeProject, canonicalCalls };
  };

  const unavailable = loadWait({
    projectId: "expected",
    activeWorkspace: { available: false, roots: [] },
  });
  assert.equal(
    await unavailable.waitForNativeProject("/Volumes/LOCAL344CASE/Project", "expected"),
    "expected",
  );
  assert.deepEqual(unavailable.canonicalCalls, []);

  const defaultTarget = "/private/tmp/LOCAL344-default/Project";
  const defaultActive = "/private/tmp/local344-default/project";
  const canonicalMatch = loadWait({
    projectId: "expected",
    activeWorkspace: { available: true, roots: [defaultActive] },
    canonicalPathByRoot: {
      [defaultTarget]: defaultTarget,
      [defaultActive]: defaultTarget,
    },
  });
  assert.equal(
    await canonicalMatch.waitForNativeProject(defaultTarget, "expected"),
    "expected",
  );
  assert.deepEqual(canonicalMatch.canonicalCalls, [{
    path: "workspace-root-options",
    body: { hostId: "local", canonicalizeRoots: [defaultTarget, defaultActive] },
  }]);

  const emptyRoots = loadWait({
    projectId: "expected",
    activeWorkspace: { available: true, roots: [] },
    canonicalPathByRoot: {},
  });
  await assert.rejects(
    emptyRoots.waitForNativeProject("/Volumes/LOCAL344CASE/Project", "expected"),
  );

  const sensitiveTarget = "/Volumes/LOCAL344CASE/Project";
  const sensitiveOther = "/Volumes/LOCAL344CASE/project";
  const mismatch = loadWait({
    projectId: "expected",
    activeWorkspace: { available: true, roots: [sensitiveOther] },
    canonicalPathByRoot: {
      [sensitiveTarget]: sensitiveTarget,
      [sensitiveOther]: sensitiveOther,
    },
  });
  await assert.rejects(mismatch.waitForNativeProject(sensitiveTarget, "expected"));

  const duplicateProject = loadWait({
    projectId: "duplicate",
    activeWorkspace: { available: true, roots: [defaultTarget] },
    canonicalPathByRoot: { [defaultTarget]: defaultTarget },
  });
  assert.equal(
    await duplicateProject.waitForNativeProject(defaultTarget, "expected"),
    "duplicate",
  );
  assert.deepEqual(duplicateProject.canonicalCalls, [{
    path: "workspace-root-options",
    body: { hostId: "local", canonicalizeRoots: [defaultTarget, defaultTarget] },
  }]);
});

test("SSH task project selection uses its stable ID and local project IDs use bootstrap keys", () => {
  assert.match(source, /row = projectRowById\(projectId\)/);
  assert.doesNotMatch(source, /projectRowForTask|projectRowByLabel/);
  assert.match(source, /Object\.entries\(localProjects\)/);
  assert.match(source, /\[\{ \.\.\.project, id \}\]/);
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
