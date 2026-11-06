export function createRspackThreadTabsRuntime() {
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

export function rewriteRspackThreadTabs(source, context) {
  const id = '[A-Za-z_$][\\w$]*', quote = '["\x27\x60]';
  const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const menu = source.match(new RegExp(`async function ${id}\\(\\{scope:(${id}),target:(${id}),[^}]*surface:(${id}),[^}]*paneItems:(${id})[^}]*\\}\\)`));
  const sidebar = source.includes('codex.localTaskRow.archiveTask') && source.includes('startTransition') && source.includes('isActive:');
  if (!menu && !sidebar) return null;
  const find = needles => { const value = context.findModule(needles); if (!value) throw new Error(`Native thread factory missing: ${needles[0]}`); return value; };
  const aliases = text => {
    const req = text.match(/^function(?:\s+\w+)?\([^,]+,[^,]+,([\w$]+)\)/)?.[1];
    if (!req) throw new Error('Native thread factory arguments changed');
    return new Map([...text.matchAll(new RegExp(`(${id})=${esc(req)}\\(${quote}([^"\x27\x60]+)${quote}\\)`, 'g'))].map(match => [match[1], match[2]]));
  };
  const exported = (text, name) => {
    const args = text.match(/^function(?:\s+\w+)?\([^,]+,([^,]+),([^)]*)\)/);
    const calls = [...text.matchAll(new RegExp(`${esc(args[2])}\\.d\\(${esc(args[1])},`, 'g'))];
    const found = [];
    for (const call of calls) {
      let parentheses = 1, braces = 0;
      for (let index = call.index + call[0].length; index < text.length && parentheses; index++) {
        const char = text[index];
        if (char === '"' || char === "'" || char === '`') {
          for (index++; index < text.length; index++) {
            if (text[index] === '\\') index++;
            else if (text[index] === char) break;
          }
          continue;
        }
        if (parentheses === 1 && braces === 1 && (text[index - 1] === '{' || text[index - 1] === ',')) {
          const match = text.slice(index).match(new RegExp(`^(${id}):(?:\\(\\)=>)?${esc(name)}(?=[,}])`));
          if (match) found.push(match[1]);
        }
        if (char === '(') parentheses++;
        else if (char === ')') parentheses--;
        else if (char === '{') braces++;
        else if (char === '}') braces--;
      }
    }
    if (new Set(found).size !== 1) throw new Error(`Native thread export missing or ambiguous: ${name}`);
    return found[0];
  };
  const ref = (map, namespace, name) => { const module = map.get(namespace); if (!module) throw new Error('Native thread dependency missing'); context.moduleSource(module); return [module, name]; };
  const open = find(['"orbit-activity"', 'activateThreadSummary', 'canInteract']);
  const openFn = open.source.match(new RegExp(`function (${id})\\((${id}),(${id}),${id},\\{revealAndFocus:`));
  const tab = open.source.match(new RegExp(`(${id})\\.(${id})\\.openTab\\(`));
  if (!openFn || !tab) throw new Error('Native conversation tab registration changed');
  const layout = find(['CodexWorkspaceContentPlacementChanged', 'onEnterFullWidth', 'contentSide']);
  const layoutFn = layout.source.match(new RegExp(`function (${id})\\((${id}),(${id}),(${id})\\)\\{let [^;]+;if\\(${quote}chat${quote}!==\\3`));
  const focusFn = layout.source.match(new RegExp(`function (${id})\\((${id}),(${id})\\)\\{${quote}chat${quote}===\\3\\?`));
  if (!layoutFn || !focusFn) throw new Error('Native conversation layout changed');
  const identity = find(['"ThreadScope"', 'getThreadScopeRouteId', 'clientThreadId']);
  const mainId = identity.source.match(new RegExp(`function (${id})\\((${id}),(${id})\\)\\{return \\2\\.get\\((${id}),(${id})\\(\\3\\)\\)\\}`));
  if (!mainId) throw new Error('Native conversation identity changed');
  const scopeModule = find(['open-page-on-right', 'getThreadScopeRouteId', 'new-thread-panel']);
  const scope = scopeModule.source.match(new RegExp(`function ${id}\\((${id})\\)\\{let (${id})=\\1\\.get\\((${id})\\.(${id})\\);if\\(null==\\2\\)return null;let (${id})=\\(0,(${id})\\.(${id})\\)\\(\\{pathname:`));
  const threadScope = scopeModule.source.match(new RegExp(`let (${id})=\\(0,(${id})\\.(${id})\\)\\((${id}),\\4\\.get\\(\\2\\.(${id}),\\(0,\\2\\.(${id})\\)\\((${id})\\)\\)\\),(${id})=\\(0,(${id})\\.(${id})\\)\\(\\1,\\(0,\\9\\.(${id})\\)\\(\\7\\)\\)`));
  const blocked = threadScope && scopeModule.source.match(new RegExp(`return null==${esc(threadScope[8])}\\|\\|${esc(threadScope[8])}\\.get\\(${esc(threadScope[9])}\\.(${id})\\)\\?null:`));
  const chatGpt = scopeModule.source.match(new RegExp(`conversationId=${id}\\.get\\((${id})\\.(${id}),${id}\\.conversationId\\)\\?\\?`));
  if (!scope || !threadScope || !blocked || !chatGpt) throw new Error('Native active conversation scope changed');
  const focus = find(['expiresTimeoutId:0', 'focusAnimationFrameId:null', 'composerId']);
  const requestFocus = focus.source.match(new RegExp(`function (${id})\\((${id})\\)\\{${id}\\(\\);let ${id}=\\{composerId:\\2,expiresTimeoutId:0,focusAnimationFrameId:null\\}`));
  const currentFocus = focus.source.match(new RegExp(`function (${id})\\(\\)\\{let (${id})=${id}\\(\\);return null==\\2\\?null:${id}\\.get\\(\\2\\)\\?\\.composerId\\?\\?null\\}`));
  const emit = focus.source.match(new RegExp(`function ${id}\\(\\)\\{for\\(let (${id}) of (${id})\\)\\1\\(\\)\\}`));
  const subscribe = emit && focus.source.match(new RegExp(`(${id}):function\\((${id})\\)\\{return ${esc(emit[2])}\\.add\\(\\2\\),\\(\\)=>\\{${esc(emit[2])}\\.delete\\(\\2\\)\\}\\}`));
  if (!requestFocus || !currentFocus || !subscribe) throw new Error('Native composer focus changed');
  const stateNamespace = layout.source.match(new RegExp(`function ${esc(layoutFn[1])}\\(${id},${id},${id}\\)\\{let ${id}=${id}\\.get\\((${id})\\.${id}\\)`))?.[1];
  const stateId = aliases(layout.source).get(stateNamespace);
  const state = stateId && { id: stateId, source: context.moduleSource(stateId) };
  if (!state?.source) throw new Error('Native conversation layout state missing');
  const stateFn = state.source.match(new RegExp(`(${id})=\\(0,${id}\\.${id}\\)\\([^,]+,\\(\\{get:(${id})\\}\\)=>${quote}full${quote}===\\2\\([^)]*\\)\\?\\{mode:${quote}full${quote}\\}:\\{contentSide:\\2\\([^)]*\\),mode:${quote}split${quote}\\}\\)`));
  if (!stateFn) throw new Error('Native conversation layout state changed');
  const navigation = find(['AppNavigationSignalBridge is missing', 'navigateToLocalConversation']);
  const navigate = navigation.source.match(new RegExp(`(${id}):function\\((${id}),\\.\\.\\.(${id})\\)\\{return \\2\\.get\\(${id}\\)\\.navigate\\(\\.\\.\\.\\3\\)\\}`));
  const navigateThread = navigation.source.match(new RegExp(`(${id}):function\\((${id}),\\.\\.\\.(${id})\\)\\{return \\2\\.get\\(${id}\\)\\.navigateToLocalConversation\\(\\.\\.\\.\\3\\)\\}`));
  if (!navigate || !navigateThread) throw new Error('Native conversation navigation changed');
  const scopeAliases = aliases(scopeModule.source);
  const bindings = {
    open: [open.id, exported(open.source, openFn[1])], tabs: ref(aliases(open.source), tab[1], tab[2]),
    layout: [layout.id, exported(layout.source, layoutFn[1])], focus: [layout.id, exported(layout.source, focusFn[1])],
    mainId: [identity.id, exported(identity.source, mainId[1])], localId: [identity.id, exported(identity.source, mainId[5])],
    location: ref(scopeAliases, scope[3], scope[4]), parseRoute: ref(scopeAliases, scope[6], scope[7]),
    threadScope: ref(scopeAliases, threadScope[2], threadScope[3]), threadId: ref(scopeAliases, threadScope[2], threadScope[5]),
    routeId: ref(scopeAliases, threadScope[2], threadScope[6]), routeScope: ref(scopeAliases, threadScope[9], threadScope[10]),
    routeKey: ref(scopeAliases, threadScope[9], threadScope[11]), blockedScope: ref(scopeAliases, threadScope[9], blocked[1]),
    chatGptId: ref(scopeAliases, chatGpt[1], chatGpt[2]), layoutState: [state.id, exported(state.source, stateFn[1])],
    focusComposer: [focus.id, exported(focus.source, requestFocus[1])], currentFocus: [focus.id, exported(focus.source, currentFocus[1])],
    subscribeFocus: [focus.id, subscribe[1]], navigate: [navigation.id, navigate[1]], navigateThread: [navigation.id, navigateThread[1]],
  };
  const setup = `const panelThreadTabs=globalThis.__codexPanelRspackTabsV1__;panelThreadTabs.configure(${JSON.stringify(bindings)});panelThreadTabs.mark(${JSON.stringify(menu ? 'menu' : 'sidebar')});`;
  source = source.replace(/^(function(?:\s+\w+)?\([^)]*\)\{)/, `$1${setup}`);
  if (menu) {
    const insertion = new RegExp(`(${id})\\.push\\(\\.\\.\\.${esc(menu[4])}\\?\\?\\[\\]\\)`);
    const match = source.match(insertion);
    if (!match || source.match(new RegExp(insertion.source, 'g'))?.length !== 1) throw new Error('Native sidebar menu insertion changed');
    return source.replace(match[0], `${match[1]}.push(...await panelThreadTabs.menu(${menu[1]},${menu[2]},${menu[3]})),${match[0]}`);
  }
  const nav = source.match(new RegExp(`(${id})=\\(0,${id}\\.${id}\\)\\((${id}),(${id}),(${id}),null==${id}&&null==${id}\\?void 0:\\{state:${id},threadAccess:${id}\\}\\)`));
  const component = source.match(new RegExp(`function (${id})\\((${id})\\)\\{[^}]+?isActive:(${id}),[^}]*?dataAttributes:(${id})\\}=\\2,(${id})=void 0!==\\3&&\\3,`));
  const react = source.match(new RegExp(`(${id})\\.startTransition`))?.[1];
  if (!nav || !component || !react) throw new Error('Native sidebar conversation navigation changed');
  const host = source.match(new RegExp(`(${id})=${id}\\?\\?${id}\\?\\.hostId\\?\\?${id}\\?\\?null;`));
  const tailStart = source.indexOf('let ', source.indexOf(nav[0]) + nav[0].length);
  const tailAnchor = tailStart < 0 ? null : source.slice(tailStart, tailStart + 70);
  const active = component[5];
  if (!host) throw new Error('Native sidebar host identity changed');
  source = source.replace(host[0], host[0].slice(0, -1) + `,panelThreadRowActive=panelThreadTabs.isActive(${nav[2]},{conversationId:${nav[3]},hostId:${host[1]}??"local"},${active},(0,${react}.useSyncExternalStore)(panelThreadTabs.subscribe,panelThreadTabs.getSnapshot,panelThreadTabs.getSnapshot));`);
  source = source.replace(nav[0], `${nav[1]}=panelThreadTabs.focusExisting(${nav[2]},{conversationId:${nav[3]},hostId:${host[1]}??"local"})||${nav[0].slice(nav[1].length + 1)}`);
  const tailAt = tailAnchor == null ? -1 : source.indexOf(tailAnchor);
  if (tailAt < 0) throw new Error('Native sidebar presentation changed');
  const tail = source.slice(tailAt).replace(new RegExp(`\\b${esc(active)}\\b`, 'g'), 'panelThreadRowActive');
  source = source.slice(0, tailAt) + tail;
  const attributes = source.match(new RegExp(`dataAttributes:(${id}),primaryAction:`));
  if (!attributes) throw new Error('Native sidebar selected attributes changed');
  return source.replace(attributes[0], `dataAttributes:{...${attributes[1]},"data-app-action-sidebar-thread-active":String(panelThreadRowActive),"data-app-action-sidebar-thread-selected":String(panelThreadRowActive)},primaryAction:`);
}
