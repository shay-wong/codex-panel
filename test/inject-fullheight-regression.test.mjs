import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CdpPipeBrowser } from "../scripts/codex-cdp-pipe.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const instanceToken = "7a6f8d37-78ce-46c9-87a8-08e10db88da2";
const instanceSecret = "2e587946-96d6-47b5-930a-1ba70214fa88";
const sourceRef = process.env.TASKBOARD_INJECTION_SOURCE_REF;
const source = sourceRef
  ? (await execFileAsync(
      "git",
      ["show", `${sourceRef}:inject/codex-panel.user.js`],
      { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
    )).stdout
  : await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const embeddedHostSource = await readFile(
  new URL("../web/src/embeddedHost.mjs", import.meta.url),
  "utf8",
);
const embeddedHostDataUrl = `data:text/javascript;base64,${Buffer.from(embeddedHostSource).toString("base64")}`;

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function fixtureHtml(origin, freeSidebar, railLayout) {
  const encodedSource = Buffer.from(source).toString("base64");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 1200px; height: 800px; margin: 0; --app-shell-titlebar-height: 36px; --radius-xl-base: 16px; --color-token-foreground: #fcfcfc; --button-text-color: rgba(252, 252, 252, 0.526); }
      #native-titlebar { position: absolute; top: 0; z-index: 30; height: 36px; }
      #native-titlebar button { height: 36px; }
      #workspace { position: relative; width: 1200px; height: 700px; }
      nav[data-app-navigation-rail] { position: absolute; width: 64px; }
      .sidebar-navigation { margin-left: 64px; }
      nav[data-app-navigation-rail] button::before { content: ""; opacity: 0; }
      nav[data-app-navigation-rail] button[data-selected]::before { opacity: 1; }
      nav[data-app-navigation-rail] button { position: relative; width: 48px; height: 40px; }
      nav[data-app-navigation-rail] button svg { width: 20px; height: 20px; }
      .rail-icon-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      nav[data-app-navigation-rail] .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; }
      aside { position: absolute; width: 200px; height: 800px; }
      main { position: absolute; left: 200px; width: 1000px; height: 700px; }
      main > header { position: absolute; z-index: 2; width: 1000px; height: 48px; }
      #surface { width: 1000px; height: 700px; }
      [data-app-shell-main-content-layout] { position: absolute; width: 1000px; height: 700px; }
      #conversation { position: absolute; top: 48px; width: 1000px; height: 652px; }
      [data-browser-sidebar-webview] { position: absolute; right: 0; width: 320px; height: 700px; visibility: visible; }
    </style>
  </head>
  <body>
    <header id="native-titlebar" data-testid="app-shell-header-context-menu-surface"><button>Back</button></header>
    <div id="workspace" data-app-shell-workspace-row>
    <aside>
    ${railLayout ? `<nav data-app-navigation-rail>
      <button data-sidebar-destination="builtin:home" aria-current="page" data-selected><svg viewBox="0 0 20 20"><path d="M2 2h16v16H2Z"/></svg><span class="sr-only">首页</span></button>
      <button data-sidebar-destination="sites"><span class="sr-only">站点</span></button>
      <button id="explore" aria-haspopup="menu"><span class="rail-icon-center"><svg></svg></span><span class="sr-only">探索</span></button>
      <button id="profile-trigger" aria-haspopup="menu" aria-label="Open profile menu" aria-expanded="false" aria-controls="profile-menu"></button>
    </nav>` : ""}
      <div class="sidebar-navigation">
      <nav role="navigation">
        ${freeSidebar ? '<div id="new-chat-row" class="sidebar-item" style="display:flex;height:36px;width:200px"><button class="sidebar-item" style="display:flex;height:100%;flex:1;min-width:0"><svg width="20" height="20"></svg><span class="text-fade-truncate">新聊天</span></button><button aria-label="快速聊天">+</button></div>' : ''}
        <div data-app-action-sidebar-scroll>
          ${freeSidebar ? '' : `<div>
            <button><span>首页</span></button>
            <button><span>站点</span></button>
            <button><svg></svg><span class="text-fade-truncate">插件</span></button>
          </div>`}
          <section data-app-action-sidebar-section>
            <div data-app-action-sidebar-section-heading="项目">项目</div>
            <div id="focused-thread" data-app-action-sidebar-thread-id="thread-449" aria-current="page">Current conversation</div>
          </section>
        </div>
      </nav>
      </div>
    </aside>
    <main>
      <header>Codex header</header>
      <div id="surface">
        <div data-app-shell-main-content-layout>
          <div id="conversation">Conversation</div>
        </div>
      </div>
      <div data-browser-sidebar-webview>
        <webview
          data-browser-sidebar-conversation-id="conversation-1"
          data-browser-sidebar-browser-tab-id="browser-tab-1"
        ></webview>
      </div>
    </main>
    </div>
    <output id="result"></output>
    <script>
      const navigationEntries = [{ key: "initial", pathname: "/", search: "", hash: "", state: null }];
      let navigationIndex = 0, nextNavigationKey = 0, navigationAction = "POP";
      const nativeNavigator = {
        get location() { return navigationEntries[navigationIndex]; },
        get action() { return navigationAction; },
        push(location, state) {
          navigationAction = "PUSH";
          navigationEntries.splice(++navigationIndex, navigationEntries.length, { ...location, state, key: String(++nextNavigationKey) });
          if (state?.__codexPanel) queueMicrotask(() => nativeNavigator.replace(nativeNavigator.location, { ...state, sidebarProductMode: "codex" }));
        },
        replace(location, state) { navigationAction = "REPLACE"; navigationEntries[navigationIndex] = { ...location, state, key: String(++nextNavigationKey) }; },
        go(delta) { navigationAction = "POP"; navigationIndex = Math.max(0, Math.min(navigationEntries.length - 1, navigationIndex + delta)); },
      };
      document.querySelector("aside").__reactFiber$fixture = { memoizedProps: { navigator: nativeNavigator }, return: null };
      window.__CODEX_PANEL_URL__ = ${JSON.stringify(`${origin}/panel?host=codex`)};
      window.__CODEX_PANEL_MANAGED_ORIGIN__ = ${JSON.stringify(origin)};
      window.__CODEX_PANEL_PRIVATE_FRAME__ = true;
      window.__CODEX_PANEL_HOST_CAPABILITY__ = "fullheight-host-capability";
      window.__CODEX_PANEL_SOURCE_HASH__ = "fullheight-regression";
      const profileTrigger = document.getElementById("profile-trigger");
      if (profileTrigger) profileTrigger.__reactFiber$fixture = { memoizedProps: {
        sidebarFooter: { profileIdentity: { displayName: "Fixture User", profileImageUrl: null } },
      }, return: null };
      window.__profileMenuOpens = 0;
      profileTrigger?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") return;
        window.__profileMenuOpens++;
        const menu = document.createElement("div");
        menu.id = "profile-menu";
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-labelledby", profileTrigger.id);
        menu.innerHTML = '<div role="menuitem"><div data-menu-row-content><span class="flex-1 min-w-0">Fixture User</span></div></div>';
        menu.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          menu.remove();
          profileTrigger.setAttribute("aria-expanded", "false");
        });
        document.body.appendChild(menu);
        profileTrigger.setAttribute("aria-expanded", "true");
      });
      window.__browserPanelClosed = false;
      window.__redundantHomeNavigation = false;
      document.querySelector('[data-sidebar-destination="builtin:home"]')?.addEventListener('click', () => {
        window.__redundantHomeNavigation = true;
        document.getElementById('focused-thread').removeAttribute('aria-current');
      });
      window.__injectionError = null;
      window.__frameMessages = [];
      window.__externalOpenUrl = null;
      window.__frameVisibleBeforeNavigation = false;
      window.__statusHiddenBeforeNavigation = false;
      window.__hostileNavigationLoaded = false;
      window.__forgedThreadOpened = false;
      window.addEventListener("error", (event) => {
        window.__injectionError = event.error?.stack || event.message;
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__injectionError = event.reason?.stack || String(event.reason);
      });
      window.addEventListener("message", (event) => {
        if (typeof event.data?.type === "string" && event.data.type.startsWith("panel:")) {
          window.__frameMessages.push({ type: event.data.type, origin: event.origin });
        }
        if (
          event.source === window
          && event.data?.type === "__codexPanelHostRequestV1"
          && event.data.capability === "fullheight-host-capability"
        ) {
          const request = event.data.payload;
          if (request.action === "load-frame") {
            const frame = document.querySelector('iframe[name="' + request.frameName + '"]');
            const moduleUrl = ${JSON.stringify(embeddedHostDataUrl)};
            frame.srcdoc = '<a id="external-link" href="https://example.com/review" target="_blank">Review</a>'
              + '<script type="module">import * as host from ' + JSON.stringify(moduleUrl) + ';'
              + 'globalThis.__CODEX_PANEL_FRAME_CAPABILITY__='
              + JSON.stringify(request.frameCapability)
              + ';host.installEmbeddedExternalLinkHandler();'
              + 'let activated=false,acknowledgedChallenge="";window.addEventListener("message",function(event){'
              + 'if(event.data?.type!=="panel:frame-challenge")return;'
              + 'const challenge=event.data.payload?.challenge;if(!challenge||challenge===acknowledgedChallenge)return;'
              + 'acknowledgedChallenge=challenge;host.setEmbeddedFrameChallenge(challenge);'
              + 'host.postEmbeddedHostMessage({type:"panel:ready"});'
              + 'if(activated)return;activated=true;'
              + 'parent.postMessage({type:"panel:ready"},"*");'
              + 'parent.postMessage({type:"panel:open-thread",payload:{threadId:"forged"}},"*");'
              + 'document.getElementById("external-link").click();'
              + '});host.postEmbeddedHostMessage({type:"panel:frame-awaiting-challenge"});<\\/script>';
          }
          if (request.action === "open-external") {
            window.__externalOpenUrl = request.url;
            const frame = document.getElementById("codex-panel-frame");
            window.__frameVisibleBeforeNavigation = frame?.hidden === false;
            window.__statusHiddenBeforeNavigation = document.getElementById("codex-panel-status")?.hidden === true;
            frame?.addEventListener("load", () => {
              window.__hostileNavigationLoaded = true;
              window.__resolveHostileNavigationLoaded();
            }, { once: true });
            frame.removeAttribute("srcdoc");
            frame.src = ${JSON.stringify(`${origin}/attacker`)};
          }
          window.postMessage({
            type: "__codexPanelHostResponseV1",
            capability: "fullheight-host-capability",
            response: { id: request.id, ok: true, loaded: true },
          }, window.location.origin);
        }
        if (event.source === window && event.data?.type === "navigate-to-route") {
          window.__forgedThreadOpened = true;
        }
        if (event.data?.type !== "toggle-browser-panel" || event.data.open !== false) return;
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        panel.style.visibility = "hidden";
        panel.hidden = true;
        const conversation = document.getElementById("conversation");
        conversation.style.top = "0";
        conversation.style.height = "700px";
        window.__browserPanelClosed = true;
      });
    </script>
    <!-- 注入脚本包含中文标签，Base64 字节须按 UTF-8 解码，避免测试把中文变成乱码。 -->
    <script>eval(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(encodedSource)}), (char) => char.charCodeAt(0))));</script>
    <script>
      (async () => {
        const publishHeartbeat = () => window.postMessage({
            type: "__codexPanelHostHeartbeatV1",
            capability: "fullheight-host-capability",
            at: Date.now(),
            startupToken: "fullheight-startup",
          }, window.location.origin);
        publishHeartbeat();
        const heartbeatTimer = setInterval(publishHeartbeat, 500);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const entry = document.getElementById("codex-panel-entry");
        const entryColorBefore = getComputedStyle(entry).color;
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        const panelVisibleBefore = getComputedStyle(panel).visibility !== "hidden";
        const hostileNavigationLoaded = new Promise((resolve) => {
          window.__resolveHostileNavigationLoaded = resolve;
        });
        entry?.click();
        await hostileNavigationLoaded;

        const page = document.getElementById("codex-panel-page");
        const frame = document.getElementById("codex-panel-frame");
        const surface = document.getElementById(${JSON.stringify(railLayout ? "workspace" : "surface")});
        const conversation = document.getElementById("conversation");
        const result = {
          entryColorBefore,
          panelVisibleBefore,
          browserPanelClosed: window.__browserPanelClosed,
          conversationTop: conversation.getBoundingClientRect().top,
          pageMounted: page?.parentElement === surface,
          pageVisible: Boolean(page && !page.hidden && getComputedStyle(page).display !== "none"),
          frameMounted: frame?.parentElement === page,
          frameVisible: Boolean(frame && !frame.hidden && getComputedStyle(frame).display !== "none"),
          frameIsolated: frame?.contentDocument === null,
          statusHidden: document.getElementById("codex-panel-status")?.hidden === true,
          frameMessages: window.__frameMessages,
          externalOpenUrl: window.__externalOpenUrl,
          frameVisibleBeforeNavigation: window.__frameVisibleBeforeNavigation,
          statusHiddenBeforeNavigation: window.__statusHiddenBeforeNavigation,
          hostileNavigationRevoked: Boolean(frame?.hidden && !document.getElementById("codex-panel-status")?.hidden),
          forgedThreadOpened: window.__forgedThreadOpened,
          injectionError: window.__injectionError,
          profileMenuOpens: window.__profileMenuOpens,
        };
        const home = document.querySelector('[data-sidebar-destination="builtin:home"]');
        const rail = document.querySelector('nav[data-app-navigation-rail]');
        const sidebar = document.querySelector('.sidebar-navigation');
        if (rail) {
          const iconCenter = (button) => {
            const rect = button.getBoundingClientRect();
            const icon = button.querySelector('svg').getBoundingClientRect();
            return [icon.left + icon.width / 2 - rect.left, icon.top + icon.height / 2 - rect.top];
          };
          result.railIconAligned = JSON.stringify(iconCenter(entry)) === JSON.stringify(iconCenter(document.getElementById('explore')));
          result.destination = {
            homeSelected: home.hasAttribute("data-selected"),
            homeBackground: getComputedStyle(home, "::before").opacity,
            entrySelected: entry.hasAttribute("data-selected"),
            entryColor: getComputedStyle(entry).color,
            sidebarVisibility: getComputedStyle(sidebar).visibility,
            railVisibility: getComputedStyle(rail).visibility,
            railPointerEvents: getComputedStyle(rail).pointerEvents,
            pageLeft: page.getBoundingClientRect().left,
            railRight: rail.getBoundingClientRect().right,
            pageTop: page.getBoundingClientRect().top,
            pageRadius: getComputedStyle(page).borderTopLeftRadius,
            headerVisibility: getComputedStyle(document.querySelector('#native-titlebar button')).visibility,
            threadCurrent: document.getElementById('focused-thread').getAttribute('aria-current'),
            originalIcon: getComputedStyle(home.querySelector('svg > *')).visibility,
            outlineIcon: getComputedStyle(home.querySelector('svg')).maskImage.startsWith('url("data:image/svg+xml,'),
            nativeIconCount: home.querySelectorAll('svg').length,
            taskboardOutline: getComputedStyle(entry.querySelector('[data-panel-icon="outline"]')).display,
            taskboardFilled: getComputedStyle(entry.querySelector('[data-panel-icon="filled"]')).display,
          };
          home.click();
          result.restored = {
            pageHidden: page.hidden,
            homeSelected: home.hasAttribute("data-selected"),
            homeCurrent: home.getAttribute("aria-current"),
            entrySelected: entry.hasAttribute("data-selected"),
            entryColor: getComputedStyle(entry).color,
            sidebarVisibility: getComputedStyle(sidebar).visibility,
            contentVisibility: getComputedStyle(conversation).visibility,
            threadCurrent: document.getElementById('focused-thread').getAttribute('aria-current'),
            redundantHomeNavigation: window.__redundantHomeNavigation,
            iconOverrides: document.querySelectorAll('[data-codex-panel-native-icon]').length,
          };
        }
        document.getElementById("result").textContent = btoa(JSON.stringify(result));
        clearInterval(heartbeatTimer);
        window.__codexPanelInjection__?.destroy();
      })();
    </script>
  </body>
</html>`;
}

for (const [layout, freeSidebar, railLayout] of [["Rail", false, true], ["Plugins", false, false], ["Free", true, false]]) {
test(`Panel loads from ${layout} sidebar, fills workspace and verifies frame boundaries`, async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((request, response) => {
    response.setHeader("connection", "close");
    if (request.url === "/attacker") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>attacker</title>");
      return;
    }
      if (request.url?.startsWith("/panel")) {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("access-control-expose-headers", "x-codex-panel-proof");
      response.setHeader("access-control-allow-private-network", "true");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const challenge = request.headers["x-codex-panel-challenge"];
      if (typeof challenge !== "string") {
        response.statusCode = 401;
        response.end("missing challenge");
        return;
      }
      response.setHeader(
        "x-codex-panel-proof",
        createHmac("sha256", instanceSecret).update(challenge).digest("hex"),
      );
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head></head><body><script>parent.postMessage({ type: "panel:ready" }, "*")</script></body></html>`);
      return;
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(origin, freeSidebar, railLayout));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const profile = await mkdtemp(path.join(os.tmpdir(), "panel-fullheight-chrome-"));
  t.after(() => rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const child = spawn(chrome, [
    "--headless=new",
    // 临时测试资料仍会调用系统钥匙串，使用模拟钥匙串避免 macOS 授权弹窗。
    "--use-mock-keychain",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const browser = new CdpPipeBrowser(child);
  let session;
  let encodedResult = "";
  try {
    await browser.open();
    const target = (await browser.targets()).find(({ type }) => type === "page");
    assert.ok(target, "Chrome did not expose a page target");
    session = await browser.connect(target.targetId);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    const loaded = session.waitFor("Page.loadEventFired", 10_000);
    await session.send("Page.navigate", { url });
    await loaded;

    if (freeSidebar) {
      const layout = await session.send("Runtime.evaluate", {
        expression: `(() => {
          const row = document.getElementById("new-chat-row");
          const entry = document.getElementById("codex-panel-entry");
          return { separate: entry?.parentElement === row.parentElement,
            below: entry?.getBoundingClientRect().top >= row.getBoundingClientRect().bottom,
            height: entry?.getBoundingClientRect().height, newChat: row.textContent.includes("新聊天"),
            quickChat: !!row.querySelector('[aria-label="快速聊天"]') };
        })()`,
        returnByValue: true,
      });
      assert.deepEqual(layout.result.value, { separate: true, below: true, height: 36, newChat: true, quickChat: true });
    }
    const deadline = Date.now() + 20_000;
    while (!encodedResult && Date.now() < deadline) {
      const evaluation = await session.send("Runtime.evaluate", {
        expression: 'document.getElementById("result")?.textContent || ""',
        returnByValue: true,
      });
      encodedResult = evaluation.result.value;
      if (!encodedResult) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!encodedResult) {
      const diagnostic = await session.send("Runtime.evaluate", {
        expression: 'JSON.stringify({error:window.__injectionError,entry:document.getElementById("codex-panel-entry")?.outerHTML,ready:window.__codexPanelInjection__?.ready,status:document.getElementById("codex-panel-status")?.textContent,body:document.querySelector("aside")?.innerHTML})',
        returnByValue: true,
      });
      throw new Error(diagnostic.result.value);
    }
  } finally {
    session?.close();
    browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }

  assert.ok(encodedResult, "fixture did not report an injection result");
  const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
  assert.deepEqual(result, {
    entryColorBefore: "rgba(252, 252, 252, 0.525)",
    panelVisibleBefore: true,
    browserPanelClosed: true,
    conversationTop: 0,
    pageMounted: true,
    pageVisible: true,
    frameMounted: true,
    frameVisible: false,
    frameIsolated: true,
    statusHidden: false,
    frameMessages: [
      { type: "panel:frame-awaiting-challenge", origin: "null" },
      { type: "panel:ready", origin: "null" },
      { type: "panel:ready", origin: "null" },
      { type: "panel:open-thread", origin: "null" },
      { type: "panel:open-external", origin: "null" },
    ],
    externalOpenUrl: "https://example.com/review",
    frameVisibleBeforeNavigation: true,
    statusHiddenBeforeNavigation: true,
    hostileNavigationRevoked: true,
    forgedThreadOpened: false,
    injectionError: null,
    profileMenuOpens: 0,
    ...(railLayout ? {
      railIconAligned: true,
      destination: {
        homeSelected: true,
        homeBackground: "0",
        entrySelected: true,
        entryColor: "rgb(252, 252, 252)",
        sidebarVisibility: "hidden",
        railVisibility: "visible",
        railPointerEvents: "auto",
        pageLeft: 64,
        railRight: 64,
        pageTop: 36,
        pageRadius: "16px",
        headerVisibility: "visible",
        threadCurrent: "page",
        originalIcon: "hidden",
        outlineIcon: true,
        nativeIconCount: 1,
        taskboardOutline: "none",
        taskboardFilled: "inline",
      },
      restored: {
        pageHidden: true,
        homeSelected: true,
        homeCurrent: "page",
        entrySelected: false,
        entryColor: "rgba(252, 252, 252, 0.525)",
        sidebarVisibility: "visible",
        contentVisibility: "visible",
        threadCurrent: "page",
        redundantHomeNavigation: false,
        iconOverrides: 0,
      },
    } : {}),
  });
});

}
