import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { act, createContext, createElement } from "react";
import { createRoot } from "react-dom/client";

const source = await readFile(
  process.env.TASKBOARD_INJECTION_SOURCE_PATH || new URL("../inject/codex-panel.user.js", import.meta.url),
  "utf8",
);

async function withReactDom(run) {
  const dom = new JSDOM('<div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await run({ root, document: dom.window.document, window: dom.window });
  } finally {
    await act(() => root.unmount());
    globalThis.window = previousWindow;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}

async function navigationHarness({ root, document, window }, { deferred = false } = {}) {
  const entries = [{ pathname: "/home", search: "", hash: "", state: null, key: "0" }];
  const subscribers = new Set();
  const cachedDestinations = new Map();
  const pending = [];
  let index = 0, nextKey = 1, pushes = 0;
  let historyAction = "POP";
  const router = {
    get state() { return { location: entries[index], historyAction }; },
    subscribe(notify) { subscribers.add(notify); return () => subscribers.delete(notify); },
    navigate(to, options) {
      if (typeof to !== "number") pushes++;
      const commit = () => {
        historyAction = typeof to === "number" ? "POP" : options?.replace ? "REPLACE" : "PUSH";
        if (typeof to === "number") index += to;
        else {
          const location = { ...to, state: options?.state, key: String(nextKey++) };
          if (options?.replace) entries[index] = location;
          else entries.splice(++index, entries.length, location);
        }
        // Native destination restoration preserves the cached location state.
        cachedDestinations.set(entries[index].pathname, { ...entries[index] });
        subscribers.forEach((notify) => notify());
      };
      if (!deferred) { commit(); return; }
      return new Promise((resolve) => pending.push(() => { commit(); resolve(); }));
    },
  };
  const NavigationContext = createContext(null);
  const render = () => act(() => root.render(createElement(
    NavigationContext.Provider,
    { value: { router } },
    createElement("aside", null, createElement("nav", { "data-app-navigation-rail": "" },
      ...["home", "plugins"].map((destination) => createElement("button", {
        key: destination,
        "data-sidebar-destination": destination,
        "aria-current": router.state.location.pathname === `/${destination}` ? "page" : undefined,
      }, destination)),
    )),
  )));
  await render();
  const start = source.indexOf("  function connectNativeNavigation()");
  const end = source.indexOf("  function scheduleRefresh()", start);
  const api = vm.runInNewContext(`(() => {
    let nativeNavigator = null, detachNativeNavigation = null, lastNativeLocation = null;
    let active = false, destroyed = false, lastNativeThreadId = "", pendingPanelNavigation = false;
    const panelLocationKeys = new Set();
    const PANEL_ROUTE_STATE = "__codexPanel";
    const normalizeThreadId = value => value;
    const publishPendingThreadAssociation = () => {};
    const showPanel = () => { active = true; };
    const closePanel = () => { active = false; };
    ${source.slice(start, end)}
    return { openPanel, leavePanel, onDocumentClick, active: () => active };
  })()`, { document });
  document.addEventListener("click", api.onDocumentClick, true);
  return {
    api, router, render, cachedDestinations,
    pushes: () => pushes,
    flush: async () => { pending.splice(0).forEach((commit) => commit()); await render(); },
    clickCurrent: () => document.querySelector('[aria-current="page"]').dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  };
}

test("restoring a native destination does not restore Panel, while Back and Forward do", async () => {
  await withReactDom(async (dom) => {
    const { api, router, render, cachedDestinations, clickCurrent } = await navigationHarness(dom);
    await api.openPanel();
    const panelKey = router.state.location.key;
    const cachedHome = cachedDestinations.get("/home");
    assert.equal(api.active(), true);
    router.navigate({ pathname: "/plugins", search: "", hash: "" });
    await render();
    assert.equal(api.active(), false);
    router.navigate({ pathname: cachedHome.pathname, search: "", hash: "" }, { state: cachedHome.state });
    await render();
    assert.notEqual(router.state.location.key, panelKey);
    assert.equal(api.active(), false, "a copied Panel marker on a new history entry is a native destination");
    clickCurrent();
    assert.equal(router.state.location.pathname, "/home");

    await api.openPanel();
    const secondPanelKey = router.state.location.key;
    clickCurrent();
    assert.equal(api.active(), false);
    assert.equal(router.state.location.pathname, "/home", "current Home must not navigate to a previous destination");
    router.navigate(-1);
    assert.equal(router.state.location.key, secondPanelKey);
    assert.equal(api.active(), true, "Back restores the actual Panel history entry");
    router.navigate(1);
    assert.equal(api.active(), false, "Forward restores the native destination");
  });
});

test("native same-route state replacement keeps Panel open without adopting copied pushes", async () => {
  await withReactDom(async (dom) => {
    const { api, router } = await navigationHarness(dom);
    await api.openPanel();
    const location = router.state.location;
    router.navigate(location, { state: { ...location.state, sidebarProductMode: "codex" }, replace: true });
    assert.notEqual(router.state.location.key, location.key);
    assert.equal(api.active(), true, "native state replacement must not immediately close Panel");
    router.navigate(router.state.location, { state: router.state.location.state });
    assert.equal(api.active(), false, "a new native destination must still close Panel");
  });
});

test("rapid Panel clicks issue only one pending asynchronous native navigation", async () => {
  await withReactDom(async (dom) => {
    const { api, pushes, flush, router } = await navigationHarness(dom, { deferred: true });
    const opening = [api.openPanel(), api.openPanel(), api.openPanel()];
    assert.equal(pushes(), 1);
    assert.equal(api.active(), false);
    await flush();
    await Promise.all(opening);
    assert.equal(api.active(), true);
    await api.openPanel();
    assert.equal(pushes(), 1);
    const back = router.navigate(-1);
    await flush();
    await back;
    assert.equal(api.active(), false);
  });
});

test("Panel icon overrides preserve React's sole SVG through selected component replacements", async () => {
  await withReactDom(async ({ root, document }) => {
    const start = source.indexOf("  function syncNativeRailIcons()");
    const end = source.indexOf("  function currentTheme()", start);
    const { syncNativeRailIcons, restoreNativeRailIcons } = vm.runInNewContext(`(() => {
      const OWNED_ATTRIBUTE = "data-codex-panel-owned";
      const NATIVE_ICON_ATTRIBUTE = "data-codex-panel-native-icon";
      const NATIVE_OUTLINE_ICONS = { "builtin:customize": '<path d="M1 1h18v18H1Z" fill="currentColor"/>' };
      ${source.slice(start, end)}
      return { syncNativeRailIcons, restoreNativeRailIcons };
    })()`, { document, encodeURIComponent });
    const Outline = () => createElement("svg", { "data-artwork": "outline" }, createElement("path", { d: "M1 1h18" }));
    const Filled = () => createElement("svg", { "data-artwork": "filled" }, createElement("path", { d: "M1 1h18v18H1Z" }));
    for (const selected of [false, true, false, true, false]) {
      await act(() => root.render(createElement("nav", { "data-app-navigation-rail": "" },
        createElement("button", { "data-sidebar-destination": "builtin:customize", "data-selected": selected ? "" : undefined },
          createElement(selected ? Filled : Outline),
        ),
      )));
      const button = document.querySelector("button");
      const reactSvg = button.querySelector("svg");
      syncNativeRailIcons();
      syncNativeRailIcons();
      assert.equal(button.querySelectorAll("svg").length, 1, "Panel must not add an SVG sibling to React-owned children");
      assert.equal(button.querySelector("svg"), reactSvg);
      assert.equal(reactSvg.dataset.artwork, selected ? "filled" : "outline");
      restoreNativeRailIcons();
      assert.equal(button.querySelector("svg"), reactSvg, "restoring the rail must not remove React's SVG");
      syncNativeRailIcons();
    }
    restoreNativeRailIcons();
  });
});

test("opening Panel reads compact profile identity without opening the native settings menu", async () => {
  await withReactDom(async ({ root, document, window }) => {
    const Profile = ({ sidebarFooter, label }) => createElement("button", {
      "aria-haspopup": "menu", "aria-label": "Open profile menu",
    }, createElement("svg"), label);
    let menuOpens = 0;
    document.addEventListener("keydown", () => menuOpens++);
    const start = source.indexOf("  async function readCodexUser(");
    const end = source.indexOf("  function readHostContext(", start);
    const readUser = vm.runInNewContext(`(() => {
      const normalizedLabel = value => value?.toLowerCase() || "";
      const normalizeCodexAvatar = async value => value;
      const userIdFromName = value => value;
      const readCodexProfileIdentity = () => null;
      const codexProfileMenu = () => null;
      ${source.slice(start, end)}
      return readCodexUser;
    })()`, { document, window, KeyboardEvent: window.KeyboardEvent });
    await act(() => root.render(createElement(Profile, { sidebarFooter: {
      profileIdentity: { displayName: "Fixture User", profileImageUrl: "https://example.com/avatar.png" },
    } })));
    const user = await readUser("fixture-id");
    assert.equal(menuOpens, 0, "identity capture must not synthesize a menu-opening key press");
    assert.equal(user.name, "Fixture User");
    assert.equal(user.id, "fixture-id");
    assert.equal(user.avatarUrl, "https://example.com/avatar.png");
    await act(() => root.render(createElement(Profile, { sidebarFooter: { profileIdentity: null } })));
    assert.equal(await readUser("fixture-id"), null);
    assert.equal(menuOpens, 0, "a profile still loading must not open settings either");
    await act(() => root.render(createElement(Profile, { label: "Legacy User" })));
    assert.equal((await readUser("fixture-id")).name, "Legacy User");
    await act(() => root.render(createElement(Profile)));
    assert.equal(await readUser("fixture-id"), null);
    assert.equal(menuOpens, 0, "an unavailable legacy identity must not open settings either");
  });
});


test("a restarted host reconnects the current document and rejects the previous capability", () => {
  const dom = new JSDOM('<main></main>', { url: 'https://codex.invalid/', runScripts: 'outside-only' });
  const { window } = dom;
  const heartbeat = (capability, startupToken) => window.dispatchEvent(new window.MessageEvent('message', {
    source: window, origin: window.location.origin,
    data: { type: '__codexPanelHostHeartbeatV1', capability, startupToken, at: Date.now() },
  }));
  try {
    window.__CODEX_PANEL_SOURCE_HASH__ = 'same-code';
    window.__CODEX_PANEL_HOST_CAPABILITY__ = 'host-a';
    window.eval(source);
    const previous = window.__codexPanelInjection__;
    heartbeat('host-a', 'manager-a');
    assert.equal(previous.startupToken, 'manager-a');
    const document = window.document;
    window.__CODEX_PANEL_HOST_CAPABILITY__ = 'host-b';
    window.eval(source);
    const current = window.__codexPanelInjection__;
    assert.notEqual(current, previous, 'a new host must replace the closure holding the old capability');
    assert.equal(window.document, document);
    heartbeat('host-b', 'manager-b');
    assert.equal(current.startupToken, 'manager-b');
    heartbeat('host-a', 'stale-manager');
    assert.equal(current.startupToken, 'manager-b', 'retired hosts must not overwrite readiness');
    window.eval(source);
    assert.equal(window.__codexPanelInjection__, current, 'same-host retries reuse the current injection');
  } finally {
    window.__codexPanelInjection__?.destroy();
    dom.window.close();
  }
});


test("host replacement preserves Panel Back/Forward history without adding a duplicate entry", async () => {
  const dom = new JSDOM('<main><aside><a href="/">New chat</a></aside><div><div data-app-shell-main-content-layout><div class="app-shell-main-content-frame">conversation</div></div></div></main>', {
    url: 'https://codex.invalid/', runScripts: 'outside-only',
  });
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 500, width: 100, height: 500 });
  const entries = [{ pathname: '/local/thread-1', search: '', hash: '', key: '0', state: null }];
  const listeners = new Set();
  let index = 0, nextKey = 1, historyAction = 'POP';
  const router = {
    get state() { return { location: entries[index], historyAction }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    navigate(to, options) {
      historyAction = typeof to === 'number' ? 'POP' : 'PUSH';
      if (typeof to === 'number') index += to;
      else entries.splice(++index, entries.length, { ...to, state: options?.state, key: String(nextKey++) });
      listeners.forEach(fn => fn());
    },
  };
  window.document.querySelector('aside').__reactFiber$fixture = { memoizedProps: { router } };
  const restart = (host) => {
    window.__CODEX_PANEL_SOURCE_HASH__ = 'same-code';
    window.__CODEX_PANEL_HOST_CAPABILITY__ = host;
    window.eval(source);
    return window.__codexPanelInjection__;
  };
  const visible = () => window.document.getElementById('codex-panel-page')?.hidden === false;
  try {
    await restart('host-a').open();
    assert.equal(visible(), true);
    const panelLocation = router.state.location;
    router.navigate({ pathname: '/plugins', search: '', hash: '' });
    restart('host-b');
    router.navigate(-1);
    assert.equal(visible(), true, 'Back must restore the original Panel entry after host replacement');
    router.navigate(1);
    assert.equal(visible(), false);
    router.navigate(-1);
    const length = entries.length;
    await restart('host-c').open();
    assert.equal(entries.length, length, 'reopening an already visible Panel must not push duplicate history');
    assert.equal(router.state.location.key, panelLocation.key);
    assert.equal(visible(), true);
    router.navigate(panelLocation, { state: panelLocation.state });
    assert.equal(visible(), false, 'copied native route markers must still be rejected');
  } finally {
    window.__codexPanelInjection__?.destroy();
    dom.window.close();
  }
});

// 用户的完整复现路径，合并后由原生历史 key 归属区分面板与恢复的首页。
test("Panel -> Spaces -> Home restores native content and permits reopening Panel", async () => {
  for (const deferred of [false, true]) {
    await withReactDom(async (dom) => {
      const {api,router,cachedDestinations,flush} = await navigationHarness(dom,{deferred});
      const opening = api.openPanel();
      await flush(); await opening;
      assert.equal(api.active(),true);
      const home = cachedDestinations.get('/home');
      const spaces = router.navigate({pathname:'/spaces/test',search:'',hash:''});
      await flush(); await spaces;
      assert.equal(api.active(),false);
      const returning = router.navigate({pathname:home.pathname,search:home.search,hash:home.hash},{state:home.state});
      await flush(); await returning;
      assert.equal(api.active(),false);
      const reopening = api.openPanel();
      await flush(); await reopening;
      assert.equal(api.active(),true);
    });
  }
});
