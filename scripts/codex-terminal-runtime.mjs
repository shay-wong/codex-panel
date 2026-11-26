// This function is serialized into Codex; keep all dependencies inside it.
export function createBottomTerminalRuntime(layout = 'bottom') {
  const enabled = layout === 'bottom';
  let controllerConfig, view, launch, canLaunch;
  const hosts = new Set();
  const api = {
    layout, enabled,
    controller: null, open$: null, height$: null,
    Header: ({ children }) => children,
    configureController(config) {
      if (!enabled || api.controller) return;
      controllerConfig = config;
      api.open$ = config.signal(config.routeScope, false);
      api.height$ = config.signal(config.routeScope, 260);
      api.controller = config.createController({
        panelId: 'bottom', singleTab: false,
        getPanelOpenSignal: () => api.open$,
        setPanelOpen: (scope, open) => api.setOpen(scope, open),
      });
    },
    configureView(config) { view ??= config; },
    registerLaunch(callback, available) { launch = callback; canLaunch = available; },
    isOpen(scope) { return api.open$ != null && scope.get(api.open$); },
    setOpen(scope, open) {
      if (!api.open$) return;
      scope.set(api.open$, open);
      if (!open && controllerConfig.getFocus(scope) === 'bottom-panel') controllerConfig.focus(scope, 'main');
    },
    focus(scope) {
      controllerConfig.focus(scope, 'bottom-panel');
      const host = [...hosts].find(host => host.scope === scope && host.element?.isConnected && !host.element.closest('[data-app-shell-active-page="false"], [inert]'));
      host?.element.querySelector('[data-codex-panel-bottom-terminal]')?.querySelector('[data-codex-terminal] textarea, [data-codex-xterm] textarea, textarea')?.focus({ preventScroll: true });
    },
    show(scope) {
      api.setOpen(scope, true);
      api.focus(scope);
      requestAnimationFrame(() => { if (api.isOpen(scope)) api.focus(scope); });
    },
    toggle(scope) {
      if (!api.controller || !launch || canLaunch?.(scope) === false) return false;
      if (api.isOpen(scope)) api.setOpen(scope, false);
      else if (scope.get(api.controller.tabs$).length) api.show(scope);
      else void launch(scope);
      return true;
    },
    toggleActive() {
      const host = [...hosts].find(host => host.element?.isConnected && !host.element.closest('[data-app-shell-active-page="false"], [inert]') && canLaunch?.(host.scope));
      return host ? api.toggle(host.scope) : false;
    },
    wrap(scope, children) {
      return enabled && view && api.controller ? view.React.createElement(Workspace, { scope }, children) : children;
    },
  };
  function Workspace({ scope, children }) {
    const { React, Renderer, Resizer, useSignal } = view;
    const open = useSignal(api.open$), height = useSignal(api.height$);
    const ref = React.useRef(null);
    React.useLayoutEffect(() => {
      const host = { scope, element: ref.current };
      hosts.add(host);
      return () => hosts.delete(host);
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
    open && React.createElement('section', {
      'data-codex-panel-bottom-terminal': '', 'data-app-shell-focus-area': 'bottom-panel', 'aria-label': '终端',
      onFocusCapture: () => controllerConfig.focus(scope, 'bottom-panel'),
      style: { position: 'relative', display: 'flex', flexDirection: 'column', height, maxHeight: '70%', minHeight: 120, minWidth: 0, flexShrink: 0, borderTop: '1px solid var(--color-border-default,rgba(128,128,128,.2))', background: 'var(--app-shell-panel-background,var(--color-surface))' },
    }, React.createElement(Resizer, {
      edge: 'top', ariaLabel: '调整终端高度', currentSize: height, getCurrentSize: () => scope.get(api.height$),
      defaultSize: 260, minimumSize: 120, maximumSize: Math.max(120, (ref.current?.clientHeight ?? 700) * .7),
      setSize: value => scope.set(api.height$, value), extendIntoToolbar: false, indicatorVisibility: 'hover',
    }), React.createElement(Renderer, { controller: api.controller, isVisible: true, showTabStrip: true, headerHeight: 'toolbar', afterList: actions })));
  }
  return api;
}
