// This function is serialized into Codex; keep all dependencies inside it.
export function createBottomTerminalRuntime(layout = 'bottom') {
  let controllerConfig, legacy, view, launch, canLaunch, terminalType;
  const hosts = new Set();
  const scopes = new Set();
  const lastActive = new WeakMap();
  const api = {
    layout, layout$: null, bottomController: null, bottomOpen$: null, height$: null,
    get enabled() { return api.layout === 'bottom'; },
    get panelId() { return api.enabled ? 'bottom' : 'right'; },
    get controller() { return api.enabled ? api.bottomController : controllerConfig?.rightController; },
    get open$() { return api.enabled ? api.bottomOpen$ : controllerConfig?.rightOpen$; },
    Header: ({ children }) => children,
    configureController(config) {
      if (controllerConfig) return;
      controllerConfig = config;
      api.layout$ = config.signal(config.routeScope, 0);
      api.bottomOpen$ = config.signal(config.routeScope, false);
      api.height$ = config.signal(config.routeScope, 260);
      api.bottomController = config.createController({
        panelId: 'bottom', singleTab: false,
        getPanelOpenSignal: () => api.bottomOpen$,
        setPanelOpen: (scope, open) => api.setBottomOpen(scope, open),
      });
    },
    configureLegacy(config) {
      legacy = config;
      api.layout$ ??= config.signal(config.routeScope, 0);
    },
    trackScope(scope) { scopes.add(scope); },
    readLayout(scope, get = scope.get) { scopes.add(scope); get(api.layout$); return api.layout; },
    legacyLayout(scope, get, nativeDefault) {
      const layout = api.readLayout(scope, get);
      return layout === 'system' ? nativeDefault : layout;
    },
    setLayout(layout) {
      if (!['system', 'bottom', 'right'].includes(layout) || layout === api.layout) return;
      const previous = [...scopes].map(scope => [scope, legacy ? legacy.getLayout(scope) : api.panelId]);
      api.layout = layout;
      for (const [scope, from] of previous) {
        scope.set(api.layout$, value => value + 1);
        const to = legacy ? legacy.getLayout(scope) : api.panelId;
        if (from !== to) moveTerminals(scope, from, to);
      }
    },
    configureView(config) { view ??= config; },
    registerLaunch(callback, available, type) { launch = callback; canLaunch = available; terminalType = type; },
    isOpen(scope) { return api.open$ != null && scope.get(api.open$) && isTerminal(scope.get(api.controller.activeTab$)); },
    setBottomOpen(scope, open) {
      scope.set(api.bottomOpen$, open);
      if (!open && controllerConfig.getFocus(scope) === 'bottom-panel') controllerConfig.focus(scope, 'main');
    },
    setOpen(scope, open) {
      if (api.enabled) api.setBottomOpen(scope, open);
      else controllerConfig.rightSetOpen(scope, open);
    },
    focus(scope) {
      controllerConfig.focus(scope, `${api.panelId}-panel`);
      const host = [...hosts].find(host => host.scope === scope && host.element?.isConnected && !host.element.closest('[data-app-shell-active-page="false"], [inert]'));
      const panel = api.enabled ? host?.element.querySelector('[data-codex-panel-bottom-terminal]')
        : document.querySelector(`[role="tabpanel"][data-app-shell-tab-panel-controller="right"][data-tab-id="${scope.get(api.controller.activeTab$)?.tabId}"]`);
      panel?.querySelector('[data-codex-terminal] textarea, [data-codex-xterm] textarea, textarea')?.focus({ preventScroll: true });
    },
    show(scope) {
      api.trackScope(scope);
      api.setOpen(scope, true);
      api.focus(scope);
      requestAnimationFrame(() => { if (api.isOpen(scope)) api.focus(scope); });
    },
    toggle(scope) {
      if (!api.controller || !launch || canLaunch?.(scope) === false) return false;
      api.trackScope(scope);
      if (api.isOpen(scope)) api.setOpen(scope, false);
      else {
        const active = scope.get(api.controller.activeTab$);
        const tabs = scope.get(api.controller.tabs$).filter(isTerminal);
        const tab = isTerminal(active) ? active : tabs.find(tab => tab.tabId === lastActive.get(scope)) ?? tabs[0];
        if (tab) { api.controller.activateTab(scope, tab.tabId); api.show(scope); }
        else void launch(scope);
      }
      return true;
    },
    toggleActive() {
      const host = [...hosts].find(host => host.element?.isConnected && !host.element.closest('[data-app-shell-active-page="false"], [inert]') && canLaunch?.(host.scope));
      return host ? api.toggle(host.scope) : false;
    },
    wrap(scope, children) {
      api.trackScope(scope);
      return view && api.bottomController ? view.React.createElement(Workspace, { scope }, children) : children;
    },
  };
  function isTerminal(tab) { return tab != null && (legacy ? legacy.isTerminalTab(tab) : tab.tabType.kind === terminalType?.kind); }
  function moveTerminals(scope, from, to) {
    const source = legacy ? legacy[`${from}Controller`] : from === 'bottom' ? api.bottomController : controllerConfig.rightController;
    const target = legacy ? legacy[`${to}Controller`] : to === 'bottom' ? api.bottomController : controllerConfig.rightController;
    const open = legacy ? legacy[`${from}Open$`] : from === 'bottom' ? api.bottomOpen$ : controllerConfig.rightOpen$;
    const active = scope.get(source.activeTab$), visible = scope.get(open) && isTerminal(active);
    if (isTerminal(active)) lastActive.set(scope, active.tabId);
    for (const tab of scope.get(source.tabs$).filter(isTerminal)) {
      if (legacy) source.moveTabTo(scope, tab.tabId, target, null, { revealAndFocus: false });
      else {
        const state = scope.get(source.tabStateById$, tab.tabId);
        if (!source.detachTabForTransfer(scope, tab.tabId, tab.dndId)) continue;
        scope.set(target.tabById$, tab.tabId, tab);
        scope.set(target.tabStateById$, tab.tabId, state);
        scope.set(target.tabIds$, ids => [...ids, tab.tabId]);
        // Rebind the native render closure to the destination controller without closing the session.
        target.replaceTabContent(scope, tab.tabType, { ...tab, id: tab.tabId, replaceTabId: tab.tabId, revealAndFocus: false });
      }
    }
    if (from === 'bottom') {
      if (legacy) legacy.hidePanel(scope, from);
      else api.setBottomOpen(scope, false);
    }
    if (visible) {
      target.activateTab(scope, active.tabId, { preserveFocus: true });
      if (legacy) legacy.showPanel(scope, to);
      else api.show(scope);
    }
  }
  function Workspace({ scope, children }) {
    const { React, Renderer, Resizer, useSignal } = view;
    useSignal(api.layout$);
    const open = useSignal(api.bottomOpen$), height = useSignal(api.height$);
    const ref = React.useRef(null);
    React.useLayoutEffect(() => {
      const host = { scope, element: ref.current };
      hosts.add(host);
      return () => { hosts.delete(host); scopes.delete(scope); };
    }, [scope]);
    const button = (label, path, onClick) => React.createElement('button', {
      type: 'button', title: label, 'aria-label': label, onClick,
      className: 'flex size-7 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-hover hover:text-default no-drag',
    }, React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }, React.createElement('path', { d: path, strokeLinecap: 'round', strokeLinejoin: 'round' })));
    const actions = React.createElement('div', { className: 'flex h-full items-center gap-1 px-1' },
      button('新建终端', 'M12 5v14M5 12h14', () => { void launch(scope, undefined, { forceNew: true }); }),
      button('收起终端', 'M5 9l7 7 7-7', () => api.setOpen(scope, false)));
    return React.createElement('div', {
      ref, 'data-codex-panel-terminal-workspace': '',
      style: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, minWidth: 0 },
    }, React.createElement('div', { style: { display: 'flex', flex: '1 1 0', minHeight: 0, minWidth: 0 } }, children),
    api.enabled && open && React.createElement('section', {
      'data-codex-panel-bottom-terminal': '', 'data-app-shell-focus-area': 'bottom-panel', 'aria-label': '终端',
      onFocusCapture: () => controllerConfig.focus(scope, 'bottom-panel'),
      style: { position: 'relative', display: 'flex', flexDirection: 'column', height, maxHeight: '70%', minHeight: 120, minWidth: 0, flexShrink: 0, borderTop: '1px solid var(--color-border-default,rgba(128,128,128,.2))', background: 'var(--app-shell-panel-background,var(--color-surface))' },
    }, React.createElement(Resizer, {
      edge: 'top', ariaLabel: '调整终端高度', currentSize: height, getCurrentSize: () => scope.get(api.height$),
      defaultSize: 260, minimumSize: 120, maximumSize: Math.max(120, (ref.current?.clientHeight ?? 700) * .7),
      setSize: value => scope.set(api.height$, value), extendIntoToolbar: false, indicatorVisibility: 'hover',
    }), React.createElement(Renderer, { controller: api.bottomController, isVisible: true, showTabStrip: true, headerHeight: 'toolbar', afterList: actions })));
  }
  return api;
}
