import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRspackThreadTabsRuntime, rewriteRspackThreadTabs } from '../scripts/codex-rspack-tabs.mjs';
import { rspackSourceContext } from '../scripts/codex-rspack-source.mjs';

const fixtures = {
  open: 'function(e,t,r){var Tabs=r("controller");function open(scope,target,title,{canInteract=true,revealAndFocus:focus=true}={}){activateThreadSummary(target);Tabs.It.openTab(scope,kind)}let kind=register("orbit-activity",component,{open:open});r.d(t,{},{E:open})}',
  controller: 'function(e,t,n){const It={tabById$:Symbol(),activeTab$:Symbol()};n.d(t,{It:()=>It})}',
  primary: 'function(e,t,n){function focus(root){root.focus()}n.d(t,{focus:()=>focus})}',
  otherfocus: 'function(e,t,n){function focus(root,target){target.focus(root)}function layout(root,target,options){target.layout(root,options)}n.d(t,{focus:()=>focus,layout:()=>layout})}',
  layout: 'function(e,t,n){var State=n("state"),Tabs=n("controller"),Primary=n("primary"),Other=n("otherfocus");function apply(e,t,n){const previous=e.get(State.fullWidth);if(t!=="chat"&&!e.get(Tabs.It.tabById$,t.tabId))return false;let full=n.mode==="full";e.set(State.type,"split");e.set(State.fullWidth,full);t==="chat"?Primary.focus(e):Other.layout(e,t,{contentSide:n.contentSide,mode:"split"});if(!previous&&e.get(State.fullWidth))t?.tabType.onEnterFullWidth?.()}function focus(e,t){"chat"===t?Primary.focus(e):Other.focus(e,t)}n.d(t,{xO:()=>apply,Mn:()=>focus})}',
  identity: 'function(e,t,n){let label="ThreadScope",atom={},clientThreadId=null;function local(id){return "local:"+id}function main(scope,id){return scope.get(atom,local(id))}function getThreadScopeRouteId(route){switch(route.routeKind){case"local-thread":return local(route.conversationId);default:return route.clientThreadId}}function scope(root,id){return root.thread(id)}n.d(t,{JJ:()=>main,s8:()=>local,scope:()=>scope,id:()=>atom,getThreadScopeRouteId:()=>getThreadScopeRouteId})}',
  location: 'function(e,t,n){const current={};n.d(t,{current:()=>current})}',
  chat: 'function(e,t,n){const id={};n.d(t,{id:()=>id})}',
  route: 'function(e,t,n){let key=route=>route.pathname,route=(0,n.scope)("RouteScope",{parent:ThreadScope,key:key}),blocked=(0,n.value)(route,!1);function parse(input){return input}function scope(root,key){return select(root,route,key)}n.d(t,{parse:()=>parse,scope:()=>scope,key:()=>key,blocked:()=>blocked,descriptor:()=>route})}',
  scope: 'function(e,t,n){var Location=n("location"),Route=n("route"),Thread=n("identity"),Chat=n("chat");let marker="open-page-on-right";function current(e){let t=e.get(Location.current);if(null==t)return null;let r=(0,Route.parse)({pathname:t.pathname,routeTemplate:t.pathname,search:t.search});if("other"===r.routeKind||"home"===r.routeKind||"new-thread-panel"===r.routeKind)return null;"chatgpt-thread"===r.routeKind&&(r.conversationId=e.get(Chat.id,r.conversationId)??r.conversationId);let s=(0,Thread.scope)(e,e.get(Thread.id,(0,Thread.getThreadScopeRouteId)(r))),v=(0,Route.scope)(s,(0,Route.key)(r));return null==v||v.get(Route.blocked)?null:v}}',
  focus: 'function(e,t,n){let listeners=new Set,inputs=new Map;function request(id){clear();let r={composerId:id,expiresTimeoutId:0,focusAnimationFrameId:null}}function current(){let node=selected();return null==node?null:inputs.get(node)?.composerId??null}function changed(){for(let listener of listeners)listener()}function register(input,id){inputs.set(input,{composerId:id});changed()}n.d(t,{},{te:request,Kx:current,cM:function(listener){return listeners.add(listener),()=>{listeners.delete(listener)}}})}',
  state: 'function(e,t,n){let type={},side={},fullWidth={},mode=(0,n.un)(scope,({get:read})=>"full"===read(type)?{mode:"full"}:{contentSide:read(side),mode:"split"});n.d(t,{y_:()=>mode,type:()=>type,side:()=>side,fullWidth:()=>fullWidth})}',
  navigation: 'function(e,t,n){n.d(t,{},{go:function(root,...args){return root.get(bridge).navigateToLocalConversation(...args)},route:function(root,...args){return root.get(bridge).navigate(...args)}})}',
  react: 'function(e,t,n){t.useSyncExternalStore=React.useSyncExternalStore}',
  menu: 'function(e,t,n){async function menu({scope:root,target:target,actions:actions,surface:surface,paneItems:panes}){let items=[];items.push(...panes??[]);return items}}',
  sidebar: 'function(e,t,n){var React=n("react"),nav=n("navigation");function row(props){let {conversationId:id="second",isActive:active,dataAttributes:attributes}=props,highlighted=void 0!==active&&active,root=props.root,host=provider??summary?.hostId??fallback??null;let result=(0,nav.go)(root,id,host,null==state&&null==access?void 0:{state:state,threadAccess:access});React.startTransition(()=>{});let output={conversationId:id,hostId:host,isActive:highlighted,dataAttributes:attributes,primaryAction:null,label:"codex.localTaskRow.archiveTask"};return output}}',
  notification: 'function(module,exports,require){const channel="navigate-to-route";module.exports=async function(e){let l=null==e.notificationThread?null:{hostId:e.notificationThread.hostId,threadId:normalize(e.notificationThread.conversationId)};if(review({scope:R,navigate:O,location:P,thread:l,navigationState:e.state}))return;beforeNavigation();let a=e.path,s;O(a,{replace:null==s&&e.replace,state:"/cloud-environments/new"===a?s:e.state})}}',
};

function context(sources = fixtures) {
  const entries = Array.isArray(sources) ? sources : Object.entries(sources).map(([id, source]) => ({ id, source }));
  return rspackSourceContext(new Map(entries.map(entry => [entry.id, entry])));
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
  assert.throws(() => rewriteRspackThreadTabs(fixtures.menu, context({ ...fixtures, layout: 'unsupported' })), /Native conversation layout/);
});

test('resolves route descriptor keys without a preassembled active-scope helper', () => {
  const ctx = context({ ...fixtures,
    scope: fixtures.scope.replace('let marker="open-page-on-right"', 'let marker="Library chat preview failed to open"')
      .replace('(0,Route.key)(r)', 'Route.descriptor.getKey?.(r)')
      .replace('return null==v||v.get(Route.blocked)?null:v', 'return v'),
    route: fixtures.route.replace('key:()=>key,blocked:()=>blocked', 'hf:()=>key,Rj:()=>blocked'),
  });
  for (const source of [fixtures.menu, fixtures.sidebar]) {
    const patched = rewriteRspackThreadTabs(source, ctx);
    assert.match(patched, /"location":\["location","current"\]/);
    assert.match(patched, /"parseRoute":\["route","parse"\]/);
    assert.match(patched, /"routeKey":\["route","hf"\]/);
    assert.match(patched, /"blockedScope":\["route","Rj"\]/);
    new vm.Script(`(${patched})`);
  }
});

test('semantic bindings survive shuffled fields, separated declarations and moved focus exports', () => {
  const sources = { ...fixtures,
    menu: fixtures.menu.replace('scope:root,target:target,actions:actions,surface:surface,paneItems:panes', 'paneItems:panes,surface:surface,historyAccess:history,target:target,scope:root,actions:actions'),
    scope: fixtures.scope.replace('pathname:t.pathname,routeTemplate:t.pathname,search:t.search', 'search:t.search,pathname:t.pathname,routeTemplate:t.pathname')
      .replace('))),v=(0,Route.scope)', ')));const unrelated=1;let v=(0,Route.scope)'),
    layout: fixtures.layout.replace('function focus(e,t){"chat"===t?Primary.focus(e):Other.focus(e,t)}', '').replace(',Mn:()=>focus', ''),
    detachedFocus: 'function(e,t,n){const Other=n("otherfocus"),Primary=n("primary");const focus=(root,view)=>{if(view!=="chat"){Other.focus(root,view)}else{Primary.focus(root)}};n.d(t,{moved:()=>focus})}',
    focus: fixtures.focus.replace('composerId:id,expiresTimeoutId:0,focusAnimationFrameId:null', 'focusAnimationFrameId:null,composerId:id,extra:true,expiresTimeoutId:0'),
    state: fixtures.state.replace('contentSide:read(side),mode:"split"', 'mode:"split",contentSide:read(side)'),
  };
  const patched = rewriteRspackThreadTabs(sources.menu, context(sources));
  assert.match(patched, /"focus":\["detachedFocus","moved"\]/);
  assert.match(patched, /"fullWidth":\["state","fullWidth"\]/);
  assert.match(patched, /await panelThreadTabs\.menu\(root,target,surface\)/);
  new vm.Script(`(${patched})`);
});

function harness(t, unified = false) {
  const savedDocument = globalThis.document, savedRuntime = globalThis.__codexPanelRspack__;
  globalThis.document = { documentElement: { lang: 'zh-CN' } };
  t.after(() => { globalThis.document = savedDocument; globalThis.__codexPanelRspack__ = savedRuntime; delete globalThis.__codexPanelThreadTabsReady__; });
  const scopes = new Map(), callbacks = new Set(), actions = [], location = Symbol(), blocked = Symbol(), layoutState = Symbol(), threadId = Symbol(), fullWidth = Symbol();
  let focusId = null;
  const tabs = { tabById$: Symbol(), activeTab$: Symbol() };
  function scope(id) {
    if (!scopes.has(id)) scopes.set(id, { node: {}, value: { conversationId: id, hostId: 'local', pathname: `/local/${id}`, routeKind: 'local-thread' }, tabs: new Map(), selected: null, layout: { mode: 'full' },
      get(atom, tabId) { if (atom === blocked) return false; if (atom === tabs.tabById$) return this.tabs.get(tabId); if (atom === tabs.activeTab$) return this.tabs.get(this.selected); if (atom === layoutState) return this.layout; if (atom === fullWidth) return this.fullWidth; },
    });
    return scopes.get(id);
  }
  const root = { location: { pathname: '/local/first', search: '' }, get(atom, value) { if (atom === location) return this.location; if (atom === threadId) return value; } };
  const native = {
    location, blockedScope: blocked, layoutState, threadId, chatGptId: Symbol(),
    ...(unified ? { fullWidth } : {}),
    parseRoute: value => ({ ...value, routeKind: 'local-thread', conversationId: value.pathname.split('/').at(-1) }),
    threadScope: (_root, id) => scope(id), routeId: route => route.conversationId, routeKey: route => route.pathname, routeScope: value => value,
    mainId: (_scope, id) => `client:${id}`, localId: id => `local:${id}`,
    tabs,
    open(owner, target, title, options) { const tabId = `orbit-activity:${target.hostId}:${target.threadId}`; owner.tabs.set(tabId, { tabId, props: { conversationId: target.threadId, hostId: target.hostId } }); owner.selected = tabId; actions.push(['open', target.threadId, title, options]); },
    layout(owner, view, value) { owner.fullWidth = value.mode === 'full'; owner.layout = unified ? { mode: 'split', contentSide: 'right' } : value; if (view !== 'chat') owner.selected = view.tabId; actions.push(['layout', owner.value.conversationId, view, value]); },
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

test('a detached archiveGroup sidebar keeps tab focus, row highlight and readiness', async t => {
  const h = harness(t), child = h.target('second'), navigations = [];
  await (await h.runtime.menu(h.root, child, 'sidebar')).find(item => item.id === 'panel-thread-split').onSelect();
  h.runtime.mark('menu');
  assert.equal(globalThis.__codexPanelThreadTabsReady__, false);
  const source = fixtures.sidebar
    .replace('let result=', 'const click=()=>{let result=')
    .replace('React.startTransition(()=>{});let output=', 'React.startTransition(()=>{});return result;};let output=')
    .replace('};let output=', '};let archive=()=>highlighted,output=')
    .replace('primaryAction:null,label:"codex.localTaskRow.archiveTask"', 'primaryAction:click,onArchive:archive,archiveGroup:props.archiveGroup')
    .replace('return output}}', 'return output}t.row=row;}');
  const patched = rewriteRspackThreadTabs(source, context());
  assert.ok(patched, 'the sidebar no longer contains the archive action translation key');
  const module = { exports: {} };
  const sandbox = vm.createContext({ module, __codexPanelRspackTabsV1__: h.runtime,
    provider: 'local', summary: null, fallback: null, id: 'second', state: null, access: null,
    nav: { go(root, id, host) { navigations.push({ id, host }); return true; } },
    load: name => name === 'navigation' ? { go(root, id, host) { navigations.push({ id, host }); return true; } } : { useSyncExternalStore: (_subscribe, snapshot) => snapshot(), startTransition: callback => callback() },
  });
  vm.runInContext(`(${patched})(module,module.exports,load)`, sandbox);
  assert.equal(globalThis.__codexPanelThreadTabsReady__, true, 'the independently loaded sidebar completes the native pair');
  const row = () => module.exports.row({ root: h.root, conversationId: sandbox.id, isActive: false, archiveGroup: null, dataAttributes: { keep: 'original' } });
  assert.equal(row().isActive, true);
  assert.equal(row().onArchive(), false, 'archive still observes the native page active state');
  assert.equal(row().dataAttributes.keep, 'original');
  assert.equal(row().dataAttributes['data-app-action-sidebar-thread-active'], 'true');
  h.runtime.focusExisting(h.root, h.target('first'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row().isActive, false);
  row().primaryAction();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.focus(), 'local:second');
  assert.equal(h.root.location.pathname, '/local/first');
  assert.equal(navigations.length, 0, 'an open tab is focused instead of navigating to another page');
  assert.equal(row().dataAttributes['data-app-action-sidebar-thread-selected'], 'true');
  assert.equal(row().onArchive(), false, 'tab focus does not rewrite archive callbacks');
  assert.equal(h.scope('first').tabs.size, 1);
  sandbox.id = 'third';
  row().primaryAction();
  assert.deepEqual(navigations, [{ id: 'third', host: 'local' }], 'unopened conversations retain native navigation');
});

test('a full-width tab offers split view when native layout mode remains split', async t => {
  const h = harness(t, true), child = h.target('second');
  await (await h.runtime.menu(h.root, child, 'sidebar')).find(item => item.id === 'panel-thread-tab').onSelect();
  assert.equal(h.scope('first').layout.mode, 'split');
  assert.equal(h.scope('first').fullWidth, true);
  let menu = await h.runtime.menu(h.root, child, 'sidebar');
  assert.deepEqual(menu.map(item => item.id), ['panel-thread-split', 'panel-thread-restore']);
  await menu.find(item => item.id === 'panel-thread-split').onSelect();
  assert.equal(h.scope('first').fullWidth, false);
  menu = await h.runtime.menu(h.root, child, 'sidebar');
  assert.deepEqual(menu.map(item => item.id), ['panel-thread-tab', 'panel-thread-restore']);
  assert.equal(h.scope('first').tabs.size, 1);
});

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

for (const [name, notification] of [
  ['inline options', fixtures.notification],
  ['nested handler and reordered fields', fixtures.notification
    .replace(';if(review', ';const handle=()=>{if(review')
    .replace('scope:R,navigate:O,location:P,thread:l,navigationState:e.state', 'thread:l,navigationState:e.state,navigate:O,scope:R,location:P')
    .replace('replace:null==s&&e.replace,state:"/cloud-environments/new"===a?s:e.state', 'state:"/cloud-environments/new"===a?s:e.state,replace:null==s&&e.replace')
    .slice(0, -2) + '};return handle()}}'],
  ['shared options', fixtures.notification.replace('O(a,{replace:null==s&&e.replace,state:"/cloud-environments/new"===a?s:e.state})',
    'let options={replace:null==s&&e.replace,state:"/cloud-environments/new"===a?s:e.state};if(e.fromSpace)return O(a,options);O(a,options)')],
]) {
test(`notification clicks with ${name} focus an existing split conversation and retain native navigation otherwise`, async t => {
  const h = harness(t), child = h.target('second'), navigations = [];
  await (await h.runtime.menu(h.root, child, 'sidebar')).find(item => item.id === 'panel-thread-split').onSelect();
  h.runtime.focusExisting(h.root, h.target('first'));
  await new Promise(resolve => setImmediate(resolve));
  const module = { exports: {} };
  let effects = 0;
  const source = rewriteRspackThreadTabs(notification, context()) ?? notification;
  vm.runInNewContext(`(${source})(module,{},()=>{});`, {
    module, R: h.root, P: h.root.location, normalize: value => value, review: () => false,
    beforeNavigation: () => effects++, __codexPanelRspackTabsV1__: h.runtime,
    O(path, options) { navigations.push({ path, options }); h.root.location = { pathname: path, search: '' }; },
  });
  const notify = (id, extra = {}) => module.exports({ path: `/local/${id}`, notificationThread: { hostId: 'local', conversationId: id }, ...extra });
  await notify('second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.location.pathname, '/local/first');
  assert.equal(h.focus(), 'local:second');
  assert.deepEqual(h.scope('first').layout, { mode: 'split', contentSide: 'right' });
  assert.equal(h.scope('first').tabs.size, 1);
  assert.equal(navigations.length, 0);
  assert.equal(effects, 1, 'native notification effects still execute');

  await notify('second', { fromSpace: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigations.length, 0, 'both native navigation branches focus the existing tab');

  h.root.location = { pathname: '/local/third', search: '' };
  await notify('second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.location.pathname, '/local/first');
  assert.equal(h.focus(), 'local:second');
  assert.equal(h.scope('first').tabs.size, 1);

  await notify('third');
  assert.equal(h.root.location.pathname, '/local/third');
  const state = { openRequestUserInputAsyncQuestion: { hostId: 'local', threadId: 'second' } };
  await notify('second', { state });
  assert.equal(navigations.at(-1).options.state, state, 'notification actions keep their native navigation state');
  await module.exports({ path: '/local/first', replace: true });
  assert.equal(navigations.at(-1).path, '/local/first');
  assert.equal(navigations.at(-1).options.replace, true);
});
}

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
  assert.equal(changed.size, 3);
});
