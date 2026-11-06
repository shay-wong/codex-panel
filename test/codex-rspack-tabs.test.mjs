import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRspackThreadTabsRuntime, rewriteRspackThreadTabs } from '../scripts/codex-rspack-tabs.mjs';

const fixtures = {
  open: 'function(e,t,r){var Tabs=r("controller");let kind="orbit-activity";function open(scope,target,title,{revealAndFocus:focus=true,canInteract=true}={}){activateThreadSummary(target);Tabs.It.openTab(scope,kind)}let registration={open:open};r.d(t,{},{E:open})}',
  layout: 'function(e,t,n){var State=n("state");function apply(e,t,n){let r=e.get(State.workspaces),o=e.get(State.home),l=null;if("chat"!==t)return false;notify("CodexWorkspaceContentPlacementChanged",{contentSide:n.contentSide});tabType.onEnterFullWidth()}function focus(e,t){"chat"===t?chat(e):tab(e,t.tabId)}n.d(t,{xO:()=>apply,Mn:()=>focus})}',
  identity: 'function(e,t,n){let label="ThreadScope",clientThreadId=null;function local(id){return "local:"+id}function main(scope,id){return scope.get(atom,local(id))}function getThreadScopeRouteId(route){return route.conversationId}n.d(t,{JJ:()=>main,s8:()=>local})}',
  scope: 'function(e,t,n){var Location=n("location"),Route=n("route"),Thread=n("thread"),Chat=n("chat");let marker="open-page-on-right";function current(e){let t=e.get(Location.current);if(null==t)return null;let r=(0,Route.parse)({pathname:t.pathname,routeTemplate:t.pathname,search:t.search});if("other"===r.routeKind||"home"===r.routeKind||"new-thread-panel"===r.routeKind)return null;"chatgpt-thread"===r.routeKind&&(r.conversationId=e.get(Chat.id,r.conversationId)??r.conversationId);let s=(0,Thread.scope)(e,e.get(Thread.id,(0,Thread.getThreadScopeRouteId)(r))),v=(0,Route.scope)(s,(0,Route.key)(r));return null==v||v.get(Route.blocked)?null:v}}',
  focus: 'function(e,t,n){let listeners=new Set;function request(id){clear();let r={composerId:id,expiresTimeoutId:0,focusAnimationFrameId:null}}function current(){let node=selected();return null==node?null:inputs.get(node)?.composerId??null}function changed(){for(let listener of listeners)listener()}let options={isInputActive:request};n.d(t,{},{te:request,Kx:current,cM:function(listener){return listeners.add(listener),()=>{listeners.delete(listener)}}})}',
  state: 'function(e,t,n){let home=isWorkspaceHome,mode=(0,n.un)(scope,({get:read})=>"full"===read(type)?{mode:"full"}:{contentSide:read(side),mode:"split"});n.d(t,{y_:()=>mode})}',
  navigation: 'function(e,t,n){let error="AppNavigationSignalBridge is missing";n.d(t,{},{go:function(root,...args){return root.get(bridge).navigateToLocalConversation(...args)},route:function(root,...args){return root.get(bridge).navigate(...args)}})}',
  react: 'function(e,t,n){t.useSyncExternalStore=React.useSyncExternalStore}',
  menu: 'function(e,t,n){async function menu({scope:root,target:target,actions:actions,surface:surface,paneItems:panes}){let items=[];items.push(...panes??[]);return items}}',
  sidebar: 'function(e,t,n){var React=n("react");function row(props){let {isActive:active,dataAttributes:attributes}=props,highlighted=void 0!==active&&active,root=props.root,host=provider??summary?.hostId??fallback??null;let result=(0,nav.go)(root,id,host,null==state&&null==access?void 0:{state:state,threadAccess:access});React.startTransition(()=>{});let output={isActive:highlighted,dataAttributes:attributes,primaryAction:null,label:"codex.localTaskRow.archiveTask"};return output}}',
};

function context(sources = fixtures) {
  const entries = Array.isArray(sources) ? sources : Object.entries(sources).map(([id, source]) => ({ id, source }));
  return {
    findModule(value) {
      const needles = typeof value === 'string' ? [value] : value;
      const found = entries.filter(entry => needles.every(needle => entry.source.includes(needle)));
      return found.length === 1 ? found[0] : null;
    },
    moduleSource(id) { return entries.find(entry => entry.id === id)?.source ?? null; },
  };
}

test('adapts Rspack menu and sidebar factories without named app chunks', () => {
  const ctx = context();
  const menu = rewriteRspackThreadTabs(fixtures.menu, ctx);
  const sidebar = rewriteRspackThreadTabs(fixtures.sidebar, ctx);
  assert.match(menu, /await panelThreadTabs\.menu\(root,target,surface\)/);
  assert.match(menu, /"open":\["open","E"\]/);
  assert.match(menu, /"focusComposer":\["focus","te"\]/);
  assert.match(sidebar, /panelThreadTabs\.focusExisting\(root/);
  assert.match(sidebar, /isActive:panelThreadRowActive/);
  assert.match(sidebar, /data-app-action-sidebar-thread-selected/);
  new vm.Script(`(${menu})`);
  new vm.Script(`(${sidebar})`);
  assert.equal(rewriteRspackThreadTabs('function(e,t,n){return 1}', ctx), null);
  assert.throws(() => rewriteRspackThreadTabs(fixtures.menu, context({ ...fixtures, layout: 'unsupported' })), /Native thread factory missing/);
});

function harness(t) {
  const savedDocument = globalThis.document, savedRuntime = globalThis.__codexPanelRspack__;
  globalThis.document = { documentElement: { lang: 'zh-CN' } };
  t.after(() => { globalThis.document = savedDocument; globalThis.__codexPanelRspack__ = savedRuntime; delete globalThis.__codexPanelThreadTabsReady__; });
  const scopes = new Map(), callbacks = new Set(), actions = [], location = Symbol(), blocked = Symbol(), layoutState = Symbol(), threadId = Symbol();
  let focusId = null;
  const tabs = { tabById$: Symbol(), activeTab$: Symbol() };
  function scope(id) {
    if (!scopes.has(id)) scopes.set(id, { node: {}, value: { conversationId: id, hostId: 'local', pathname: `/local/${id}`, routeKind: 'local-thread' }, tabs: new Map(), selected: null, layout: { mode: 'full' },
      get(atom, tabId) { if (atom === blocked) return false; if (atom === tabs.tabById$) return this.tabs.get(tabId); if (atom === tabs.activeTab$) return this.tabs.get(this.selected); if (atom === layoutState) return this.layout; },
    });
    return scopes.get(id);
  }
  const root = { location: { pathname: '/local/first', search: '' }, get(atom, value) { if (atom === location) return this.location; if (atom === threadId) return value; } };
  const native = {
    location, blockedScope: blocked, layoutState, threadId, chatGptId: Symbol(),
    parseRoute: value => ({ ...value, routeKind: 'local-thread', conversationId: value.pathname.split('/').at(-1) }),
    threadScope: (_root, id) => scope(id), routeId: route => route.conversationId, routeKey: route => route.pathname, routeScope: value => value,
    mainId: (_scope, id) => `client:${id}`, localId: id => `local:${id}`,
    tabs,
    open(owner, target, title, options) { const tabId = `orbit-activity:${target.hostId}:${target.threadId}`; owner.tabs.set(tabId, { tabId, props: { conversationId: target.threadId, hostId: target.hostId } }); owner.selected = tabId; actions.push(['open', target.threadId, title, options]); },
    layout(owner, view, value) { owner.layout = value; if (view !== 'chat') owner.selected = view.tabId; actions.push(['layout', owner.value.conversationId, view, value]); },
    focus(owner, view) { actions.push(['focus', owner.value.conversationId, view]); },
    focusComposer(id) { focusId = id; for (const callback of callbacks) callback(); },
    currentFocus: () => focusId,
    subscribeFocus(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    navigate(_root, pathname) { root.location = { pathname, search: '' }; },
    navigateThread(_root, id) { root.location = { pathname: `/local/${id}`, search: '' }; },
  };
  tabs.closeTab = (owner, id) => { owner.tabs.delete(id); if (owner.selected === id) owner.selected = null; };
  const runtime = createRspackThreadTabsRuntime();
  runtime.configure(Object.fromEntries(Object.keys(native).map(key => [key, ['native', key]])));
  globalThis.__codexPanelRspack__ = { loadModule: async () => native };
  const target = id => ({ conversationId: id, hostId: 'local', threadSummary: { title: id } });
  return { runtime, root, target, scope, actions, focus: () => focusId };
}

test('opens once, switches presentation, moves focus and keeps only the focused row active', async t => {
  const h = harness(t), main = h.target('first'), child = h.target('second');
  let menu = await h.runtime.menu(h.root, child, 'sidebar');
  assert.deepEqual(menu.map(item => item.id), ['panel-thread-tab', 'panel-thread-split']);
  await menu.find(item => item.id === 'panel-thread-split').onSelect();
  assert.equal(h.scope('first').tabs.size, 1);
  assert.deepEqual(h.scope('first').layout, { mode: 'split', contentSide: 'right' });
  assert.equal(h.focus(), 'local:second');
  assert.equal(h.runtime.isActive(h.root, main, true, h.focus()), false);
  assert.equal(h.runtime.isActive(h.root, child, false, h.focus()), true);
  menu = await h.runtime.menu(h.root, child, 'sidebar');
  assert.deepEqual(menu.map(item => item.id), ['panel-thread-tab', 'panel-thread-restore']);
  await menu.find(item => item.id === 'panel-thread-tab').onSelect();
  assert.equal(h.scope('first').tabs.size, 1);
  assert.equal(h.actions.filter(action => action[0] === 'open').length, 1);
  assert.equal(h.scope('first').layout.mode, 'full');
  assert.deepEqual((await h.runtime.menu(h.root, main, 'sidebar')).map(item => item.id), ['panel-thread-restore']);
  assert.equal(h.runtime.focusExisting(h.root, main), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.focus(), 'client:first');
  assert.equal(h.runtime.isActive(h.root, main, true, h.focus()), true);
  assert.equal(h.runtime.isActive(h.root, child, false, h.focus()), false);
  assert.equal(h.runtime.focusExisting(h.root, child), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.focus(), 'local:second');
  assert.equal(h.runtime.isActive(h.root, main, true, h.focus()), false);
});

test('restores a child as its own page and clears the original group menu state', async t => {
  const h = harness(t), main = h.target('first'), child = h.target('second');
  await (await h.runtime.menu(h.root, child, 'sidebar')).find(item => item.id === 'panel-thread-split').onSelect();
  await (await h.runtime.menu(h.root, child, 'sidebar')).find(item => item.id === 'panel-thread-restore').onSelect();
  assert.equal(h.root.location.pathname, '/local/second');
  assert.equal(h.scope('first').tabs.size, 0);
  assert.equal(h.scope('second').layout.mode, 'full');
  assert.equal(h.focus(), 'client:second');
  h.root.location.pathname = '/local/first';
  assert.deepEqual(await h.runtime.menu(h.root, main, 'sidebar'), []);
  assert.deepEqual(await h.runtime.menu(h.root, child, 'header'), []);
});

test('reports readiness only after both adapted native factories execute', t => {
  const { runtime } = harness(t);
  runtime.mark('sidebar');
  assert.equal(globalThis.__codexPanelThreadTabsReady__, false);
  runtime.mark('menu');
  assert.equal(globalThis.__codexPanelThreadTabsReady__, true);
});

test('current extracted native factories remain syntactically valid after adaptation', { skip: !process.env.CODEX_RSPACK_FACTORIES }, async () => {
  const source = JSON.parse(await readFile(process.env.CODEX_RSPACK_FACTORIES, 'utf8'));
  const entries = Array.isArray(source) ? source : Object.entries(source).map(([id, source]) => ({ id, source }));
  const ctx = context(entries.map(entry => ({ ...entry, source: 'function' + entry.source.slice(entry.source.indexOf('(')) }))), changed = new Set();
  for (const entry of entries) {
    for (const variant of entry.variants ?? [entry]) {
      const normalized = 'function' + variant.source.slice(variant.source.indexOf('('));
      const patched = rewriteRspackThreadTabs(normalized, ctx);
      if (patched) { new vm.Script(`(${patched})`); changed.add(entry.id); }
    }
  }
  assert.equal(changed.size, 2);
});
