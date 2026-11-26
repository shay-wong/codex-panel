function createRspackThreadTabsRuntime() {
  let bindings, native, loading, unsubscribe;
  const owners = new Map(), listeners = new Set(), applied = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  const key = target => `orbit-activity:${target.hostId}:${target.conversationId}`;
  const same = (scope, target) => {
    const value = scope?.value;
    if (!value) return false;
    const id = value.conversationId ?? value.clientThreadId;
    return id != null && (id === target.conversationId || native.mainId(scope, id) === native.mainId(scope, target.conversationId))
      && (value.hostId ?? 'local') === target.hostId;
  };
  async function prepare() {
    if (native) return native;
    if (!bindings) throw new Error('会话标签接口尚未就绪');
    if (!loading) loading = (async () => {
      const entries = await Promise.all(Object.entries(bindings).map(async ([name, [id, exported]]) =>
        [name, (await globalThis.__codexPanelRspack__.loadModule(id))[exported]]));
      native = Object.fromEntries(entries);
      unsubscribe?.();
      unsubscribe = native.subscribeFocus(emit);
      emit();
      return native;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  function active(root) {
    const location = root.get(native.location);
    if (!location) return null;
    const route = native.parseRoute({ pathname: location.pathname, routeTemplate: location.pathname, search: location.search });
    if (['other', 'home', 'new-thread-panel'].includes(route.routeKind)) return null;
    if (route.routeKind === 'chatgpt-thread') route.conversationId = root.get(native.chatGptId, route.conversationId) ?? route.conversationId;
    const thread = native.threadScope(root, root.get(native.threadId, native.routeId(route)));
    const scope = native.routeScope(thread, native.routeKey(route));
    return scope && !scope.get(native.blockedScope) ? scope : null;
  }
  function view(root, target) {
    const scope = active(root), id = key(target);
    for (const [tabId, owner] of owners) if (!owner.get(native.tabs.tabById$, tabId)) owners.delete(tabId);
    if (same(scope, target)) return { scope, view: 'chat' };
    const owner = owners.get(id), tab = (owner ?? scope)?.get(native.tabs.tabById$, id);
    if (tab) return { scope: owner ?? scope, view: tab };
    for (const owner of owners.values()) if (same(owner, target)) return { scope: owner, view: 'chat' };
    return scope ? { scope, view: null } : null;
  }
  async function reveal(root, found) {
    if (active(root)?.node === found.scope.node) return;
    const owner = found.scope.value;
    native.navigate(root, owner.pathname + (owner.search ?? ''));
    const deadline = Date.now() + 5000;
    while (active(root)?.node !== found.scope.node) {
      if (Date.now() > deadline) throw new Error('无法切换到会话所在页面');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }
  function close(scope, id) {
    native.tabs.closeTab(scope, id, { recordCloseUndo: false });
    if (scope.get(native.tabs.tabById$, id) != null) throw new Error('无法移出会话标签页');
    owners.delete(id);
  }
  function removeDuplicate(target) {
    const id = key(target), owner = owners.get(id);
    if (owner) close(owner, id);
  }
  async function focus(root, target, found) {
    await reveal(root, found);
    if (found.view === 'chat') removeDuplicate(target);
    native.focus(found.scope, found.view);
    native.focusComposer(found.view === 'chat' ? native.mainId(found.scope, target.conversationId) : native.localId(target.conversationId));
    emit();
  }
  async function open(root, target, split) {
    await prepare();
    let found = view(root, target);
    if (!found) throw new Error('请先打开一个会话');
    await reveal(root, found);
    if (!found.view) {
      native.open(found.scope, { hostId: target.hostId, threadId: target.conversationId }, target.threadSummary?.title, { canInteract: true });
      found = view(root, target);
      if (!found?.view || found.view === 'chat') throw new Error('无法打开会话标签页');
      owners.set(found.view.tabId, found.scope);
    }
    if (found.view === 'chat') removeDuplicate(target);
    native.layout(found.scope, found.view, split ? { mode: 'split', contentSide: 'right' } : { mode: 'full' });
    await focus(root, target, found);
  }
  async function restore(root, target) {
    await prepare();
    const found = view(root, target);
    if (!found?.view) return;
    await reveal(root, found);
    if (found.view !== 'chat') {
      close(found.scope, found.view.tabId);
      native.navigateThread(root, target.conversationId, target.hostId === 'local' ? undefined : target.hostId);
    } else removeDuplicate(target);
    const deadline = Date.now() + 5000;
    for (;;) {
      const current = view(root, target);
      if (current?.view === 'chat') {
        for (const [id, owner] of owners) if (owner.node === current.scope.node) close(owner, id);
        native.layout(current.scope, 'chat', { mode: 'full' });
        await focus(root, target, current);
        return;
      }
      if (Date.now() > deadline) throw new Error('无法恢复独立会话页面');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }
  const icons = [
    '<path d="M7 3.5H4.5a1 1 0 0 0-1 1V13M7.5 6.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/><path d="M11.5 9v5m-2.5-2.5h5"/>',
    '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M10 4v12"/>',
    '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 7h14"/>',
  ].map(paths => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`));
  return {
    configure(value) { bindings ??= value; },
    mark(kind) { applied.add(kind); globalThis.__codexPanelThreadTabsReady__ = applied.has('menu') && applied.has('sidebar'); },
    prepare,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return native?.currentFocus() ?? null; },
    focusExisting(root, target) {
      if (!native) return false;
      const found = view(root, target);
      if (!found?.view) return false;
      void focus(root, target, found).catch(console.error);
      return true;
    },
    isActive(root, target, fallback, composerId) {
      if (!native) return fallback;
      const scope = active(root);
      if (!scope || ![...owners.values()].some(owner => owner.node === scope.node)) return fallback;
      const tab = scope.get(native.tabs.activeTab$), props = tab?.props;
      let selected;
      if (props && owners.get(tab.tabId)?.node === scope.node && composerId === native.localId(props.conversationId)) {
        selected = { conversationId: props.conversationId, hostId: props.hostId };
      } else if (same(scope, target) && composerId === native.mainId(scope, target.conversationId)) selected = target;
      if (!selected && composerId != null) {
        const id = scope.value.conversationId ?? scope.value.clientThreadId;
        if (id != null && composerId === native.mainId(scope, id)) return same(scope, target);
      }
      return selected ? selected.conversationId === target.conversationId && selected.hostId === target.hostId : fallback;
    },
    async menu(root, target, surface) {
      if (surface !== 'sidebar') return [];
      await prepare();
      const found = view(root, target);
      if (!found) return [];
      const zh = document.documentElement.lang.startsWith('zh'), items = [];
      const currentSplit = found.view && found.view !== 'chat' && found.scope.get(native.layoutState).mode === 'split'
        && !(native.fullWidth && found.scope.get(native.fullWidth))
        && found.scope.get(native.tabs.activeTab$)?.tabId === found.view.tabId;
      for (const split of [false, true]) {
        if (found.view === 'chat' || (found.view && split === currentSplit)) continue;
        items.push({ id: split ? 'panel-thread-split' : 'panel-thread-tab', icon: icons[split ? 1 : 0],
          message: { id: split ? 'panel.thread.openSplit' : 'panel.thread.openTab', defaultMessage: zh ? (split ? '在右侧并排打开' : '在新标签页中打开') : (split ? 'Open side by side' : 'Open in new tab') },
          selectAfterClose: true, onSelect: () => open(root, target, split) });
      }
      if ((found.view && found.view !== 'chat') || [...owners.values()].some(owner => owner.node === found.scope.node)) {
        items.push({ id: 'panel-thread-restore', icon: icons[2], message: { id: 'panel.thread.restore', defaultMessage: zh ? '恢复为独立页面' : 'Restore as standalone page' },
          selectAfterClose: true, onSelect: () => restore(root, target) });
      }
      return items;
    },
  };
}
