import { applyEdits, isFunction, property, propertyName, propertyValue, returnValue, unique, unwrap } from './codex-source-ast.mjs';

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

export function rewriteRspackThreadTabs(source, context) {
  // These independent property hints only avoid parsing unrelated factories; selection is structural.
  if (!['paneItems', 'dataAttributes', 'navigationState'].some(name => source.includes(name))) return null;
  const ast = context.ast(source);
  const value = node => ast.value(unwrap(node));
  const fnOf = (tree, node) => tree.enclosing(node, isFunction);
  const calls = (tree, node) => tree.all(item => item.type === 'CallExpression', node);
  const ownCalls = (tree, fn) => calls(tree, fn.body).filter(node => fnOf(tree, node) === fn);
  const member = (node, name) => unwrap(node)?.type === 'MemberExpression' && propertyName(unwrap(node)) === name;
  const falseValue = node => unwrap(node)?.type === 'Literal' && unwrap(node).value === false
    || unwrap(node)?.type === 'UnaryExpression' && unwrap(node).operator === '!' && unwrap(unwrap(node).argument)?.value === 1;
  const objectWith = (node, keys) => node?.type === 'ObjectExpression' && keys.every(key => property(node, key));
  const resolved = (tree, node) => {
    const result = context.resolve(tree, unwrap(node));
    return result ?? { ast: tree, node: tree.value(unwrap(node)) };
  };
  const same = (leftAst, left, rightAst, right) => {
    if (!left || !right) return false;
    left = unwrap(left); right = unwrap(right);
    if (leftAst === rightAst && left.type === 'Identifier' && right.type === 'Identifier') {
      const a = leftAst.binding(left), b = rightAst.binding(right);
      if (a === b && (a || left.name === right.name)) return true;
    }
    const a = resolved(leftAst, left), b = resolved(rightAst, right);
    if (a.ast === b.ast && a.node === b.node) return true;
    if (a.ast !== b.ast || a.node?.type !== 'Identifier' || b.node?.type !== 'Identifier') return false;
    return a.ast.binding(a.node) === b.ast.binding(b.node) && a.ast.binding(a.node) != null;
  };
  const ref = (tree, node) => {
    const target = resolved(tree, node), exported = context.exportOf(target.ast, target.node);
    if (!exported) throw new Error('Native thread export missing or ambiguous');
    return [exported.id, exported.exportName];
  };
  const hasExport = (tree, node) => {
    try { return ref(tree, node); } catch { return null; }
  };
  const candidates = term => context.modulesContaining(term).map(module => context.moduleAst(module.id));
  const distinct = values => values.filter((item, index) => values.findIndex(other => other.ast === item.ast && other.node === item.node) === index);
  const requireOne = (values, label) => unique(distinct(values), `Native ${label} missing or ambiguous`);
  const hasLiteral = (tree, node, literal) => tree.all(item => item.type === 'Literal' && item.value === literal, node).length > 0;
  const isGet = node => node?.type === 'CallExpression' && member(node.callee, 'get');
  const immediateStatement = (tree, node, fn) => {
    let current = node;
    while (current && tree.parent(current) !== fn.body) current = tree.parent(current);
    return current;
  };

  // Notification context and navigation are joined by bindings, not object-property order.
  const notificationContexts = ast.all(node => objectWith(node, ['scope', 'navigate', 'thread', 'navigationState']))
    .filter(node => member(propertyValue(node, 'navigationState'), 'state'))
    .filter(node => {
      const request = unwrap(propertyValue(node, 'navigationState')).object;
      const owner = fnOf(ast, ast.binding(request)?.declaration) ?? fnOf(ast, node);
      return owner && ast.all(item => member(item, 'notificationThread') && same(ast, item.object, ast, request), owner).length > 0;
    });
  if (notificationContexts.length) {
    const notification = unique(notificationContexts, 'Native notification conversation context is ambiguous');
    const root = propertyValue(notification, 'scope'), navigate = propertyValue(notification, 'navigate');
    const thread = propertyValue(notification, 'thread'), request = unwrap(propertyValue(notification, 'navigationState')).object;
    const owner = fnOf(ast, notification);
    const navigations = ownCalls(ast, owner).filter(call => same(ast, call.callee, ast, navigate)
      && objectWith(value(call.arguments[1]), ['replace', 'state']));
    if (!navigations.length) throw new Error('Native notification conversation navigation changed');
    const guard = `${ast.text(thread)}&&null==${ast.text(request)}.state&&globalThis.__codexPanelRspackTabsV1__.focusExisting(${ast.text(root)},{conversationId:${ast.text(thread)}.threadId,hostId:${ast.text(thread)}.hostId})`;
    if (navigations.length === 1) {
      const call = navigations[0];
      return applyEdits(source, [{ start: call.start, end: call.end, text: `(${guard}||${ast.text(call)})` }]);
    }
    const entries = navigations.map(call => immediateStatement(ast, call, owner));
    if (entries.some(entry => !entry)) throw new Error('Native notification control flow changed');
    return applyEdits(source, [{ start: Math.min(...entries.map(entry => entry.start)), end: Math.min(...entries.map(entry => entry.start)), text: `if(${guard})return;` }]);
  }

  const menuPatterns = ast.all(node => node.type === 'ObjectPattern' && ['scope', 'target', 'surface', 'paneItems'].every(name => property(node, name)))
    .filter(node => fnOf(ast, node)?.async);
  const sidebarPatterns = ast.all(node => node.type === 'ObjectPattern' && ['conversationId', 'isActive', 'dataAttributes'].every(name => property(node, name)));
  if (!menuPatterns.length && !sidebarPatterns.length) return null;
  const menu = menuPatterns.length ? unique(menuPatterns, 'Native thread menu is ambiguous') : null;

  // Start from the registered tab type, then follow its open function and controller.
  const openCandidates = [];
  for (const tree of candidates('orbit-activity')) {
    for (const call of calls(tree, tree.factory)) {
      if (!call.arguments.some(arg => unwrap(arg)?.type === 'Literal' && unwrap(arg).value === 'orbit-activity')) continue;
      for (const arg of call.arguments) {
        const options = tree.value(unwrap(arg));
        if (!objectWith(options, ['open'])) continue;
        const target = resolved(tree, propertyValue(options, 'open'));
        if (isFunction(target.node)) openCandidates.push(target);
      }
    }
  }
  const opening = requireOne(openCandidates, 'conversation tab registration');
  const openCall = unique(ownCalls(opening.ast, opening.node).filter(call => member(call.callee, 'openTab')), 'Native conversation tab controller changed');
  const tabsObject = unwrap(openCall.callee).object;

  // Resolve layout by its tab transition contract, independently from the focus export.
  const layoutCandidates = [];
  for (const tree of candidates('onEnterFullWidth')) {
    for (const call of calls(tree, tree.factory).filter(call => member(call.callee, 'onEnterFullWidth'))) {
      const fn = fnOf(tree, call);
      if (fn?.params.length === 3 && hasLiteral(tree, fn.body, 'chat')
        && tree.all(item => member(item, 'mode') && same(tree, item.object, tree, fn.params[2]), fn.body).length) layoutCandidates.push({ ast: tree, node: fn });
    }
  }
  const layout = requireOne(layoutCandidates, 'conversation layout');
  const layoutCalls = ownCalls(layout.ast, layout.node);
  const root = layout.node.params[0];
  const primaryCalls = layoutCalls.filter(call => call.arguments.length === 1 && same(layout.ast, call.arguments[0], layout.ast, root)
    && !member(call.callee, 'get') && !member(call.callee, 'set')).map(call => resolved(layout.ast, call.callee));
  const focusCandidates = [];
  const focusAsts = [...new Set([layout.ast, ...primaryCalls.flatMap(target => {
    const exported = hasExport(target.ast, target.node);
    return exported ? candidates(exported[0]) : [target.ast];
  })])];
  for (const tree of focusAsts) {
    for (const branch of tree.all(node => node.type === 'ConditionalExpression' || node.type === 'IfStatement', tree.factory)) {
      const fn = fnOf(tree, branch);
      if (!fn || fn.params.length !== 2 || !hasLiteral(tree, branch.test, 'chat')
        || !tree.all(node => node.type === 'Identifier' && same(tree, node, tree, fn.params[1]), branch.test).length) continue;
      const alternatives = [branch.consequent, branch.alternate].filter(Boolean);
      if (alternatives.length !== 2) continue;
      const branchCalls = alternatives.map(part => calls(tree, part).filter(call => fnOf(tree, call) === fn));
      if (branchCalls.some(part => part.length !== 1)) continue;
      const [first, second] = branchCalls.map(part => part[0]);
      const single = first.arguments.length === 1 ? first : second.arguments.length === 1 ? second : null;
      const pair = first.arguments.length === 2 ? first : second.arguments.length === 2 ? second : null;
      if (!single || !pair || !same(tree, single.arguments[0], tree, fn.params[0])
        || !same(tree, pair.arguments[0], tree, fn.params[0])) continue;
      const tab = unwrap(pair.arguments[1]);
      if (!same(tree, tab, tree, fn.params[1])
        && !(member(tab, 'tabId') && same(tree, tab.object, tree, fn.params[1]))) continue;
      if (primaryCalls.some(candidate => same(tree, single.callee, candidate.ast, candidate.node))) focusCandidates.push({ ast: tree, node: fn });
    }
  }
  const focus = requireOne(focusCandidates, 'conversation focus');

  // Follow route -> thread scope -> route scope by variable identity; declarations may move.
  const routeCandidates = [];
  for (const tree of candidates('getThreadScopeRouteId')) {
    for (const routeIdCall of calls(tree, tree.factory).filter(call => member(call.callee, 'getThreadScopeRouteId'))) {
      const owner = fnOf(tree, routeIdCall);
      if (!owner) continue;
      const inScope = ownCalls(tree, owner), route = routeIdCall.arguments[0];
      const routeKinds = tree.all(node => node.type === 'BinaryExpression' && ['===', '=='].includes(node.operator), owner.body)
        .flatMap(node => [[node.left, node.right], [node.right, node.left]])
        .filter(([field]) => member(field, 'routeKind') && same(tree, unwrap(field).object, tree, route))
        .map(([, literal]) => unwrap(literal)?.value);
      if (!['other', 'home', 'new-thread-panel'].every(kind => routeKinds.includes(kind))) continue;
      const idReads = inScope.filter(call => isGet(call) && same(tree, call.arguments[1], tree, routeIdCall));
      for (const idRead of idReads) {
        const scopes = inScope.filter(call => call.arguments.length >= 2 && same(tree, call.arguments[0], tree, unwrap(idRead.callee).object)
          && same(tree, call.arguments[1], tree, idRead) && call !== idRead);
        for (const threadScopeCall of scopes) {
          const routeScopes = inScope.filter(call => call !== threadScopeCall && same(tree, call.arguments[0], tree, threadScopeCall)
            && unwrap(tree.value(call.arguments[1]))?.type === 'CallExpression');
          for (const routeScopeCall of routeScopes) routeCandidates.push({ ast: tree, node: routeScopeCall, owner, route, routeIdCall, idRead, threadScopeCall });
        }
      }
    }
  }
  const routeChain = requireOne(routeCandidates, 'active conversation scope');
  const routeAst = routeChain.ast, parsedRoute = unwrap(routeAst.value(routeChain.route));
  if (parsedRoute?.type !== 'CallExpression') throw new Error('Native active conversation route changed');
  const routeInput = routeAst.value(parsedRoute.arguments[0]);
  if (!objectWith(routeInput, ['pathname', 'search', 'routeTemplate'])) throw new Error('Native active conversation route input changed');
  const pathname = unwrap(propertyValue(routeInput, 'pathname'));
  const locationRead = pathname?.type === 'MemberExpression' ? unwrap(routeAst.value(pathname.object)) : null;
  if (!isGet(locationRead)) throw new Error('Native active conversation location changed');
  const routeKeyCall = unwrap(routeAst.value(routeChain.node.arguments[1]));
  let routeKey = routeKeyCall.callee, keyAst = routeAst;
  if (member(routeKey, 'getKey')) {
    const descriptor = resolved(routeAst, unwrap(routeKey).object);
    if (descriptor.node?.type !== 'CallExpression') throw new Error('Native route descriptor changed');
    const options = descriptor.node.arguments.map(arg => descriptor.ast.value(arg)).find(arg => objectWith(arg, ['key', 'parent']));
    if (!options) throw new Error('Native route key changed');
    routeKey = propertyValue(options, 'key'); keyAst = descriptor.ast;
  }
  const blockedReads = ownCalls(routeAst, routeChain.owner).filter(call => isGet(call) && same(routeAst, unwrap(call.callee).object, routeAst, routeChain.node));
  let blocked;
  if (blockedReads.length) blocked = { ast: routeAst, node: unique(blockedReads, 'Native blocked route scope changed').arguments[0] };
  else {
    const scopeTarget = resolved(routeAst, routeChain.node.callee);
    const descriptors = [];
    for (const call of calls(scopeTarget.ast, scopeTarget.node)) {
      for (const arg of call.arguments) {
        const target = resolved(scopeTarget.ast, arg);
        if (target.node?.type === 'CallExpression' && target.node.arguments.some(arg => unwrap(arg)?.type === 'Literal' && unwrap(arg).value === 'RouteScope')) descriptors.push(target);
      }
    }
    const descriptor = requireOne(descriptors, 'route scope descriptor');
    const atoms = calls(descriptor.ast, descriptor.ast.factory).filter(call => call.arguments.some(arg => same(descriptor.ast, arg, descriptor.ast, descriptor.node))
      && call.arguments.some(falseValue));
    blocked = { ast: descriptor.ast, node: unique(atoms, 'Native blocked route scope changed') };
  }
  const mappedChat = ownCalls(routeAst, routeChain.owner).filter(call => isGet(call) && member(call.arguments[1], 'conversationId')
    && same(routeAst, unwrap(call.arguments[1]).object, routeAst, routeChain.route));
  const chatGptId = unique(mappedChat, 'Native ChatGPT conversation identity changed').arguments[0];
  const routeId = resolved(routeAst, routeChain.routeIdCall.callee);
  const localBranch = unique(routeId.ast.all(node => node.type === 'SwitchCase' && unwrap(node.test)?.value === 'local-thread', routeId.node), 'Native local thread identity changed');
  const localCalls = calls(routeId.ast, localBranch).filter(call => call.arguments.some(arg => member(arg, 'conversationId')));
  const localIdentity = resolved(routeId.ast, unique(localCalls, 'Native local thread identity changed').callee);
  const threadId = resolved(routeAst, routeChain.idRead.arguments[0]), threadIdRef = ref(threadId.ast, threadId.node);
  const identityAsts = [...new Set([threadId.ast, ...candidates(threadIdRef[0])])];
  const mainCandidates = [];
  for (const tree of identityAsts) for (const call of calls(tree, tree.factory).filter(isGet)) {
    const inner = unwrap(tree.value(call.arguments[1]));
    if (inner?.type !== 'CallExpression' || !same(tree, call.arguments[0], threadId.ast, threadId.node)
      || !same(tree, inner.callee, localIdentity.ast, localIdentity.node)) continue;
    const fn = fnOf(tree, call);
    if (fn?.params.length === 2 && same(tree, returnValue(fn), tree, call) && hasExport(tree, fn)) mainCandidates.push({ ast: tree, node: fn });
  }
  const mainIdentity = requireOne(mainCandidates, 'main conversation identity');

  const stateCandidates = [];
  const layoutAtoms = layoutCalls.filter(call => member(call.callee, 'get') || member(call.callee, 'set')).map(call => call.arguments[0]);
  for (const tree of candidates('contentSide')) {
    for (const fn of tree.all(isFunction, tree.factory)) {
      const reader = fn.params.map(param => propertyValue(unwrap(param), 'get')).find(Boolean);
      if (!reader) continue;
      const full = tree.all(node => objectWith(node, ['mode']) && unwrap(propertyValue(node, 'mode'))?.value === 'full', fn.body);
      const split = tree.all(node => objectWith(node, ['mode', 'contentSide']) && unwrap(propertyValue(node, 'mode'))?.value === 'split', fn.body);
      if (!full.length || !split.length) continue;
      const reads = ownCalls(tree, fn);
      if (!reads.some(call => same(tree, call.callee, tree, reader) && call.arguments.some(arg => layoutAtoms.some(atom => same(tree, arg, layout.ast, atom))))) continue;
      const constructor = tree.parent(fn);
      if (constructor?.type === 'CallExpression' && hasExport(tree, constructor)) stateCandidates.push({ ast: tree, node: constructor });
    }
  }
  const layoutState = requireOne(stateCandidates, 'conversation layout state');
  const enter = unique(layoutCalls.filter(call => member(call.callee, 'onEnterFullWidth')), 'Native full width transition changed');
  const guards = [];
  for (let node = layout.ast.parent(enter); node && node !== layout.node; node = layout.ast.parent(node)) {
    if (node.type === 'LogicalExpression') guards.push(node.left);
    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') guards.push(node.test);
  }
  const fullReads = [];
  for (const guard of guards) {
    const expressions = [guard, ...layout.ast.all(node => node.type === 'Identifier', guard).map(node => layout.ast.value(node))];
    for (const expression of expressions) for (const call of calls(layout.ast, expression).filter(isGet)) {
      if (same(layout.ast, unwrap(call.callee).object, layout.ast, root)) fullReads.push({ ast: layout.ast, node: call.arguments[0] });
    }
  }
  const fullWidth = fullReads.length ? requireOne(fullReads.map(item => resolved(item.ast, item.node)), 'full width state') : null;

  // The current composer, its input registry and its registry-change emitter tie focus APIs together.
  const requestCandidates = [];
  for (const tree of candidates('expiresTimeoutId')) for (const object of tree.all(node => objectWith(node, ['composerId', 'expiresTimeoutId', 'focusAnimationFrameId']), tree.factory)) {
    const fn = fnOf(tree, object);
    if (fn?.params.length === 1 && same(tree, propertyValue(object, 'composerId'), tree, fn.params[0]) && hasExport(tree, fn)) requestCandidates.push({ ast: tree, node: fn });
  }
  const requestFocus = requireOne(requestCandidates, 'composer focus request');
  const currentCandidates = [];
  for (const tree of candidates('composerId')) for (const fn of tree.all(isFunction, tree.factory)) {
    if (fn.params.length || !hasExport(tree, fn)) continue;
    const resultFields = node => {
      node = unwrap(tree.value(node));
      if (member(node, 'composerId')) return [node];
      if (node?.type === 'ConditionalExpression') return [...resultFields(node.consequent), ...resultFields(node.alternate)];
      if (node?.type === 'LogicalExpression') return [...resultFields(node.left), ...resultFields(node.right)];
      return [];
    };
    for (const returned of tree.all(node => node.type === 'ReturnStatement', fn.body).filter(node => fnOf(tree, node) === fn)) {
      for (const field of resultFields(returned.argument)) {
        const read = unwrap(tree.value(field.object));
        if (isGet(read)) currentCandidates.push({ ast: tree, node: fn, registry: unwrap(read.callee).object });
      }
    }
  }
  const currentFocus = requireOne(currentCandidates, 'current composer focus');
  const registry = resolved(currentFocus.ast, currentFocus.registry);
  const registryModules = hasExport(registry.ast, registry.node);
  const registryAsts = [...new Set([registry.ast, ...(registryModules ? candidates(registryModules[0]) : [])])];
  const emitters = [];
  for (const tree of registryAsts) for (const setter of calls(tree, tree.factory).filter(call => member(call.callee, 'set')
    && same(tree, unwrap(call.callee).object, registry.ast, registry.node) && objectWith(tree.value(call.arguments[1]), ['composerId']))) {
    const writer = fnOf(tree, setter);
    for (const call of ownCalls(tree, writer)) {
      const target = resolved(tree, call.callee);
      if (!isFunction(target.node)) continue;
      for (const loop of target.ast.all(node => node.type === 'ForOfStatement', target.node.body)) {
        if (calls(target.ast, loop.body).some(call => call.arguments.length === 0)) emitters.push({ ast: target.ast, node: loop.right });
      }
    }
  }
  const listeners = requireOne(emitters.map(item => resolved(item.ast, item.node)), 'composer focus subscription');
  const listenersExport = hasExport(listeners.ast, listeners.node);
  const listenerAsts = [...new Set([listeners.ast, ...(listenersExport ? candidates(listenersExport[0]) : [])])];
  const subscriptions = [];
  for (const tree of listenerAsts) for (const add of calls(tree, tree.factory).filter(call => member(call.callee, 'add') && same(tree, unwrap(call.callee).object, listeners.ast, listeners.node))) {
    const fn = fnOf(tree, add);
    if (fn?.params.length !== 1 || !same(tree, add.arguments[0], tree, fn.params[0])) continue;
    if (calls(tree, fn.body).some(call => member(call.callee, 'delete') && same(tree, unwrap(call.callee).object, listeners.ast, listeners.node)
      && same(tree, call.arguments[0], tree, fn.params[0])) && hasExport(tree, fn)) subscriptions.push({ ast: tree, node: fn });
  }
  const subscription = requireOne(subscriptions, 'composer focus subscription');
  const navigationCandidates = { navigate: [], navigateToLocalConversation: [] };
  for (const name of Object.keys(navigationCandidates)) {
    for (const tree of candidates(name)) for (const call of calls(tree, tree.factory)) {
      if (!member(call.callee, name)) continue;
      const fn = fnOf(tree, call), receiver = unwrap(tree.value(unwrap(call.callee).object));
      if (fn?.params[1]?.type === 'RestElement' && isGet(receiver) && same(tree, unwrap(receiver.callee).object, tree, fn.params[0]) && hasExport(tree, fn)) navigationCandidates[name].push({ ast: tree, node: fn });
    }
  }
  const navigate = requireOne(navigationCandidates.navigate, 'conversation navigation');
  const navigateThread = requireOne(navigationCandidates.navigateToLocalConversation, 'local conversation navigation');
  const bindings = {
    open: ref(opening.ast, opening.node), tabs: ref(opening.ast, tabsObject),
    layout: ref(layout.ast, layout.node), focus: ref(focus.ast, focus.node),
    mainId: ref(mainIdentity.ast, mainIdentity.node), localId: ref(localIdentity.ast, localIdentity.node),
    location: ref(routeAst, locationRead.arguments[0]), parseRoute: ref(routeAst, parsedRoute.callee),
    threadScope: ref(routeAst, routeChain.threadScopeCall.callee), threadId: threadIdRef,
    routeId: ref(routeId.ast, routeId.node), routeScope: ref(routeAst, routeChain.node.callee),
    routeKey: ref(keyAst, routeKey), blockedScope: ref(blocked.ast, blocked.node),
    chatGptId: ref(routeAst, chatGptId), layoutState: ref(layoutState.ast, layoutState.node),
    ...(fullWidth ? { fullWidth: ref(fullWidth.ast, fullWidth.node) } : {}),
    focusComposer: ref(requestFocus.ast, requestFocus.node), currentFocus: ref(currentFocus.ast, currentFocus.node),
    subscribeFocus: ref(subscription.ast, subscription.node), navigate: ref(navigate.ast, navigate.node), navigateThread: ref(navigateThread.ast, navigateThread.node),
  };
  const setup = `const panelThreadTabs=globalThis.__codexPanelRspackTabsV1__;panelThreadTabs.configure(${JSON.stringify(bindings)});panelThreadTabs.mark(${JSON.stringify(menu ? 'menu' : 'sidebar')});`;
  const edits = [{ start: ast.factory.body.start + 1, end: ast.factory.body.start + 1, text: setup }];
  if (menu) {
    const owner = fnOf(ast, menu), panes = propertyValue(menu, 'paneItems');
    const spread = unique(ast.all(node => node.type === 'SpreadElement' && ast.all(item => item.type === 'Identifier' && same(ast, item, ast, panes), node).length, owner.body)
      .filter(node => ast.parent(node)?.type === 'ArrayExpression' || member(ast.parent(node)?.callee, 'push')), 'Native sidebar menu insertion changed');
    edits.push({ start: spread.start, end: spread.start, text: `...await panelThreadTabs.menu(${ast.text(propertyValue(menu, 'scope'))},${ast.text(propertyValue(menu, 'target'))},${ast.text(propertyValue(menu, 'surface'))}),` });
    return applyEdits(source, edits);
  }

  const sidebar = unique(sidebarPatterns, 'Native sidebar component is ambiguous'), owner = fnOf(ast, sidebar);
  const presentation = unique(ast.all(node => objectWith(node, ['isActive', 'dataAttributes', 'hostId']), owner.body), 'Native sidebar presentation changed');
  const active = propertyValue(presentation, 'isActive'), conversationInput = propertyValue(sidebar, 'conversationId');
  const conversation = conversationInput.type === 'AssignmentPattern' ? conversationInput.left : conversationInput;
  let host = propertyValue(presentation, 'hostId');
  for (;;) {
    const next = unwrap(ast.value(host));
    if (next?.type === 'LogicalExpression' && next.operator === '??' && (unwrap(next.right)?.type === 'UnaryExpression' && unwrap(next.right).operator === 'void'
      || unwrap(next.right)?.type === 'Identifier' && unwrap(next.right).name === 'undefined')) host = next.left;
    else break;
  }
  const nativeCall = unique(calls(ast, owner.body).filter(call => same(ast, call.callee, navigateThread.ast, navigateThread.node)
    && same(ast, call.arguments[1], ast, conversation)), 'Native sidebar conversation navigation changed');
  const rowRoot = nativeCall.arguments[0];
  const required = [rowRoot, host, active, conversation];
  const statements = required.map(node => ast.binding(unwrap(node))?.declaration).filter(Boolean)
    .map(node => immediateStatement(ast, node, owner)).filter(Boolean);
  const insertion = statements.length ? Math.max(...statements.map(node => node.end)) : owner.body.start + 1;
  const reactCalls = calls(ast, owner.body).filter(call => member(call.callee, 'useSyncExternalStore') || member(call.callee, 'startTransition'));
  const react = unique(reactCalls.map(call => unwrap(call.callee).object).filter((node, index, all) => all.findIndex(other => same(ast, node, ast, other)) === index), 'Native sidebar React dependency changed');
  edits.push({ start: insertion, end: insertion, text: `;const panelThreadRowActive=panelThreadTabs.isActive(${ast.text(rowRoot)},{conversationId:${ast.text(conversation)},hostId:${ast.text(host)}??"local"},${ast.text(active)},(0,${ast.text(react)}.useSyncExternalStore)(panelThreadTabs.subscribe,panelThreadTabs.getSnapshot,panelThreadTabs.getSnapshot));` });

  // Follow expression ownership and memo dependencies; comma/statement grouping is immaterial.
  const computation = node => {
    let result = node;
    for (let parent = ast.parent(node); parent && parent !== owner.body && !isFunction(parent); parent = ast.parent(parent)) {
      if (parent.type === 'ConditionalExpression' || parent.type === 'IfStatement') return parent;
      if (['VariableDeclarator', 'AssignmentExpression', 'ReturnStatement'].includes(parent.type)) result = parent;
    }
    return result;
  };
  const trace = (node, roots, visited) => {
    for (const identifier of ast.all(item => item.type === 'Identifier', node)) {
      const binding = ast.binding(identifier);
      if (!binding || !ast.references(binding).includes(identifier) || visited.has(binding) || same(ast, identifier, ast, active)) continue;
      visited.add(binding);
      const definitions = binding.init ? [binding.init] : [];
      for (const reference of ast.references(binding)) {
        const parent = ast.parent(reference);
        if (parent?.type === 'AssignmentExpression' && parent.left === reference) definitions.push(parent.right);
      }
      for (const definition of definitions) {
        roots.add(computation(definition));
        trace(definition, roots, visited);
      }
    }
  };
  const presentationComputations = new Set([computation(presentation)]), archiveComputations = new Set();
  const presentationBindings = new Set(), archiveBindings = new Set();
  for (const key of ['isActive', 'sidebarIndicators', 'onClick', 'onPointerClick']) {
    const input = propertyValue(presentation, key);
    if (input) trace(input, presentationComputations, presentationBindings);
  }
  for (const key of ['onArchive', 'onArchiveRequest']) {
    const input = propertyValue(presentation, key);
    if (!input) continue;
    if (isFunction(unwrap(input))) archiveComputations.add(unwrap(input));
    trace(input, archiveComputations, archiveBindings);
  }
  const within = (reference, roots) => [...roots].some(node => reference.start >= node.start && reference.end <= node.end);
  for (const reference of ast.references(ast.binding(unwrap(active)))) {
    if (within(reference, presentationComputations) && !within(reference, archiveComputations)) {
      edits.push({ start: reference.start, end: reference.end, text: 'panelThreadRowActive' });
    }
  }
  const attributes = property(presentation, 'dataAttributes');
  edits.push({ start: attributes.value.start, end: attributes.value.end, text: `{...${ast.text(attributes.value)},"data-app-action-sidebar-thread-active":String(panelThreadRowActive),"data-app-action-sidebar-thread-selected":String(panelThreadRowActive)}` });
  const navGuard = `panelThreadTabs.focusExisting(${ast.text(rowRoot)},{conversationId:${ast.text(conversation)},hostId:${ast.text(host)}??"local"})`;
  edits.push({ start: nativeCall.start, end: nativeCall.end, text: `(${navGuard}||${ast.text(nativeCall)})` });
  return applyEdits(source, edits);
}
