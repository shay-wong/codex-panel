import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { prepareCodexThreadTabs, rewriteCodexThreadTabs } from "../scripts/codex-thread-tabs.mjs";

const initial = 'import{tabs as wrong}from"./other.js";function open(scope,target,title,options){tabs.openTab(scope,kind,{props:{conversationId:target.threadId}})}var kind;function init(){return(init=once(()=>{kind=register(`orbit-activity`,Component,{open:open})}))()}function layout(scope,tab,options){if(options.mode===`full`&&tab.kind===`chat`)return false;}function initLayout(){return(initLayout=once(()=>{}))()}function focus(scope,view){if(view.kind===`chat`){focusChat(scope);return}focusTab(scope,view.tab.tabId)}var host=atom(Route,({get:read})=>read(context).hostId);function navigateRoute(root,...args){return root.get(bridge).navigate(...args)}var layoutState=atom(Route,({get:read})=>read(mode)===`full`?{mode:`full`}:{contentSide:read(side),mode:`split`});function focusInput(id){clear();let request={composerId:id,expiresTimeoutId:0,focusAnimationFrameId:null};}function subscribeInput(listener){return listeners.add(listener),()=>{listeners.delete(listener)}}function currentInput(){let input=selected();return input==null?null:inputs.get(input)?.composerId??null}function clientId(scope,id){return scope.get(identity,localId(id))}export{localId as n,focusInput as j,currentInput as k,subscribeInput as l,clientId as m,layoutState as i,init as a,open as b,tabs as c,initLayout as d,layout as e,focus as f,host as g,navigateRoute as h};';
const primary = 'function active(root){let loc=root.get(location);if(loc==null)return null;let route=parse({pathname:loc.pathname,routeTemplate:loc.pathname,search:loc.search});if(route.routeKind===`other`)return null;return root.active;}async function menu({scope:root,target:target,actions:actions,surface:surface,isUnread:unread,paneItems:paneItems}){let items=[];items.push(...paneItems??[]);return items;}function sidebar(root,id,host,state,shared){let {isActive:active}=root;let highlighted=active!==void 0&&active,summary=null,fallbackHost=null,resolvedHost=host??summary?.hostId??fallbackHost??null,attributes={"data-app-action-sidebar-thread-active":String(active===true),"data-app-action-sidebar-thread-selected":String(active===true)};root.routeActive=highlighted;(0,React.startTransition)(()=>{});let result=navigate(root,id,host===`local`?void 0:host,state==null&&!shared?void 0:{state:state,threadAccess:shared?`shared`:void 0});let cache=[],rendered;return cache[0]!==highlighted?(rendered={isActive:highlighted,dataAttributes:attributes},cache[0]=highlighted,cache[1]=rendered):rendered=cache[1],root.renderedActive=rendered.isActive,root.renderedAttributes=rendered.dataAttributes,result;}';

test("large native modules use bounded CDP responses and release their remote object", async () => {
  const initialUrl = "app://-/assets/app-initial-fixture.js";
  const primaryUrl = "app://-/assets/app-primary-fixture.js";
  const sources = new Map([[initialUrl, initial + "/*" + "x".repeat(10_300_000) + "*/"],
    [primaryUrl, primary + "/*" + "y".repeat(5_100_000) + "*/"]]);
  for (const failChunk of [false, true]) {
    let remote, released = false;
    const existing = [{ url: primaryUrl, source: primary + "/* existing adapter */" }];
    const messages = [];
    const cdp = { async send(method, params) {
      if (method === "Runtime.evaluate") {
        remote = await vm.runInNewContext(params.expression, {
          performance: { getEntriesByType: () => [...sources.keys()].map(name => ({ name })) },
          document: { querySelectorAll: () => [] }, URL, location: { href: initialUrl },
          fetch: async url => ({ ok: sources.has(url), text: async () => sources.get(url) }),
        });
        if (!params.returnByValue) return { result: { objectId: "modules" } };
        throw Error("CDP WebSocket closed: oversized response");
      }
      assert.equal(params.objectId, "modules");
      if (method === "Runtime.releaseObject") { released = true; remote = null; return {}; }
      assert.equal(method, "Runtime.callFunctionOn");
      if (failChunk && params.arguments.length === 2) return { exceptionDetails: { text: "chunk failed" } };
      const value = vm.runInNewContext(`(${params.functionDeclaration})`).apply(remote, params.arguments.map(arg => arg.value));
      assert.ok(JSON.stringify(value).length < 1_000_000, "each CDP response must stay bounded");
      return { result: { value } };
    } };
    const result = await prepareCodexThreadTabs(cdp, existing, message => messages.push(message));
    assert.equal(released, true);
    if (failChunk) {
      assert.equal(result, existing, "a failed read preserves prior adapters");
      assert.match(messages[0], /chunk unreadable/);
    } else {
      assert.equal(result.length, 1);
      assert.equal(result[0].url, primaryUrl);
      assert.equal(result[0].source, rewriteCodexThreadTabs(existing[0].source, sources.get(initialUrl), initialUrl));
      assert.match(result[0].source, /panel-thread-split/);
    }
  }
});

test("prepared modules do not depend on another renderer read", async () => {
  const modules = [
    { url: "app://-/assets/app-initial-fixture.js", source: initial },
    { url: "app://-/assets/app-primary-fixture.js", source: primary },
  ];
  const result = await prepareCodexThreadTabs({ send() { throw Error("renderer read unavailable"); } }, modules, () => {});
  assert.notEqual(result, modules);
  assert.match(result[1].source, /panel-thread-split/);
});

test("module discovery survives cleared timing records with preload links or the entry import chain", async () => {
  const urls = ["app://-/assets/app-initial-fixture.js", "app://-/assets/app-primary-fixture.js"];
  for (const entry of ["preload", "direct", "split"]) {
    const useEntry = entry !== "preload";
    const split = entry === "split";
    let remote;
    const entryUrl = "app://-/assets/index-fixture.js";
    const mainUrl = "app://-/assets/app-main-fixture.js";
    const runtimeUrl = "app://-/assets/app-runtime-fixture.js";
    const initialSource = split ? initial.replace(
      "if(view.kind===`chat`){focusChat(scope);return}focusTab(scope,view.tab.tabId)",
      "view.kind===`chat`?focusChat(scope):focusTab(scope,view.tab.tabId)",
    ) : 'const lazy=()=>import(`./app-primary-fixture.js`);' + initial;
    const sources = new Map([
      [entryUrl, split ? 'import "./app-main-fixture.js";' : 'import "./app-initial-fixture.js";'],
      [mainUrl, 'import "./app-initial-fixture.js";import "./app-runtime-fixture.js";'],
      [runtimeUrl, 'import "./app-primary-fixture.js";'],
      [urls[0], initialSource],
      [urls[1], split ? primary.replace("host===`local`?void 0:host", "host") : primary],
    ]);
    const reads = [];
    const result = await prepareCodexThreadTabs({ async send(method, params) {
      if (method === "Runtime.evaluate") {
        remote = await vm.runInNewContext(params.expression, {
          performance: { getEntriesByType: () => [] },
          document: { querySelectorAll: selector => selector.includes("importmap") ? []
            : useEntry ? [{ src: entryUrl }] : selector.includes("modulepreload") ? urls.map(href => ({ href })) : [] },
          URL, location: { href: "app://-/index.html" },
          fetch: async (url, options) => {
            assert.equal(options.cache, "no-store");
            assert.ok(sources.has(url));
            reads.push(url);
            return { ok: true, text: async () => sources.get(url) };
          },
        });
        return { result: { objectId: "modules" } };
      }
      if (method === "Runtime.releaseObject") return {};
      return { result: { value: vm.runInNewContext(`(${params.functionDeclaration})`).apply(remote, params.arguments.map(arg => arg.value)) } };
    } }, [], () => {});
    assert.equal(result.length, 1);
    assert.match(result[0].source, /panel-thread-split/);
    assert.deepEqual(reads, split ? [entryUrl, mainUrl, urls[0], runtimeUrl, urls[1]]
      : useEntry ? [entryUrl, ...urls] : urls, "each module is fetched once");
  }
});

function harness({deferNavigation=false,nativeHostArgument=false}={}) {
  const source = nativeHostArgument ? primary.replace("let result=navigate(root,id,host===`local`?void 0:host,",
    "host=host===`local`?void 0:host;let result=navigate(root,id,host,") : primary;
  const patched = rewriteCodexThreadTabs(source, initial, "app://-/assets/app-initial-fixture.js");
  assert.ok(patched);
  assert.match(patched, /c as panelThreadTabs2/);
  let focusedComposer=null;const composerFocuses=[],subscriptions=[];
  const hostAtom = {}, layoutAtom = {}, activeAtom = {}, scopes = new Map(), layouts = [], opens = [], focuses = [], navigations = [];
  function getScope(id, host = "local") {
    const key = `${host}:${id}`;
    if (!scopes.has(key)) {
      const tabs = new Map(), state = {mode:"full",active:null,focusPane:"main"};
      scopes.set(key, { node: {}, tabs, state, value: { routeKind: "local-thread", conversationId: id, pathname: `/local/${id}`, search: "?project=test" },
        get: (atom, tabId) => atom === hostAtom ? host : atom === layoutAtom ? state : atom === activeAtom ? tabs.get(state.active) : tabs.get(tabId) });
    }
    return scopes.get(key);
  }
  const root = { active: getScope("first"), get: () => ({ pathname: "/local/first", search: "" }) };
  const context = {
    React:{startTransition:callback=>callback(),useSyncExternalStore:(subscribe,snapshot)=>{subscriptions.push(subscribe);return snapshot();}},
    panelThreadTabs9(id){
      composerFocuses.push(id);
      // 真实现场：主页面用恢复后的 client ID，内容标签注册 local:<会话 ID>。
      const mounted=[`client-new:${root.active.value.conversationId}`,...[...root.active.tabs.values()].map(tab=>`local:${tab.props.conversationId}`)];
      if(mounted.includes(id))focusedComposer=id;
    },
    panelThreadTabs10:()=>focusedComposer,
    panelThreadTabs11:()=>()=>{},
    panelThreadTabs12:(_scope,id)=>`client-new:${id}`,
    panelThreadTabs13:id=>`local:${id}`,
    console, requestAnimationFrame: callback=>setImmediate(callback), panelThreadTabs6: hostAtom, panelThreadTabs8: layoutAtom,
    panelThreadTabs7: (_root,path) => {
      navigations.push({path});
      const apply=()=>{ root.active=getScope(path.split("?")[0].split("/").at(-1)); };
      deferNavigation?queueMicrotask(apply):apply();
    },
    navigate(_root, id, host = "local") { navigations.push({id,host}); root.active=getScope(id,host); return true; },
    panelThreadTabs5(scope, view) {
      focuses.push({scope,view});
      // 原生只在激活不同标签时切换分栏，重复激活已有标签保持焦点区域。
      if(view.kind==="chat")scope.state.focusPane="main";
      else if(scope.state.active!==view.tab.tabId){scope.state.active=view.tab.tabId;scope.state.focusPane="right-panel";}
    },
    location: {}, parse: () => ({ routeKind: "local-thread" }), document: { documentElement: { lang: "zh-CN" } },
    panelThreadTabs0() {}, panelThreadTabs3() {},
    panelThreadTabs1(scope, target, title, options) {
      opens.push({ target, options });
      const id = `orbit-activity:${target.hostId}:${target.threadId}`;
      scope.tabs.set(id, { tabId: id, props: { conversationId: target.threadId, hostId:target.hostId, shouldResume: false } });
    },
    panelThreadTabs2: { tabById$: {}, activeTab$: activeAtom,
      updateTab(scope, id, patch) { scope.tabs.set(id, { ...scope.tabs.get(id), ...patch }); },
      closeTab(scope,id) { scope.tabs.delete(id); } },
    panelThreadTabs4(scope, view, options) { scope.state.mode=options.mode; scope.state.active=view.tab?.tabId??null; scope.state.focusPane=view.kind==="chat"?"main":"right-panel"; layouts.push({scope,view,options:JSON.parse(JSON.stringify(options))}); },
  };
  const api = vm.runInNewContext(patched.replace(/^import[^;]+;/, "") + ";({menu,sidebar,panelThreadIsActive})", context);
  const target = { hostId: "local", conversationId: "second", threadSummary: { title: "Second" } };
  return {...api,root,target,getScope,layouts,opens,focuses,navigations,composerFocuses,subscriptions,currentComposer:()=>focusedComposer};
}

test("menu reuses one view for tab/split and sidebar focuses it without changing layout", async () => {
  const h=harness(),{root,target}=h;
  const items=await h.menu({scope:root,target,surface:"sidebar"});
  assert.equal(items[0].message.defaultMessage,"在新标签页中打开");
  assert.equal(items[1].message.defaultMessage,"在右侧并排打开");
  assert.match(items[0].icon,/^data:image\/svg\+xml;utf8,/);
  assert.match(decodeURIComponent(items[1].icon),/M10 4v12/);
  await items[0].onSelect();
  const tabMenu=await h.menu({scope:root,target,surface:"sidebar"});
  assert.equal(tabMenu.some(item=>item.id==="panel-thread-tab"),false);
  assert.ok(tabMenu.some(item=>item.id==="panel-thread-split"));
  await tabMenu.find(item=>item.id==="panel-thread-split").onSelect();
  const splitMenu=await h.menu({scope:root,target,surface:"sidebar"});
  assert.equal(splitMenu.some(item=>item.id==="panel-thread-split"),false);
  assert.ok(splitMenu.some(item=>item.id==="panel-thread-tab"));
  assert.ok(splitMenu.some(item=>item.id==="panel-thread-restore"));
  assert.equal(h.opens.length,1);
  assert.equal(h.opens[0].options.canInteract,true);
  assert.equal(root.active.tabs.get("orbit-activity:local:second").props.shouldResume,true);
  assert.deepEqual(h.layouts.map(x=>x.options),[{mode:"full"},{mode:"split",contentSide:"right"}]);
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(h.navigations.length,0);
  assert.equal(h.focuses.at(-1).view.tab.props.conversationId,"second");
  assert.equal(h.layouts.length,2,"sidebar focus preserves layout");
  const main=await h.menu({scope:root,target:{hostId:"local",conversationId:"first"},surface:"sidebar"});
  assert.equal(main.some(item=>item.id==="panel-thread-split"||item.id==="panel-thread-tab"),false);
  assert.ok(main.some(item=>item.id==="panel-thread-restore"));
  await main[0].onSelect();
  assert.equal(h.opens.length,1,"main chat is never duplicated");
  assert.equal(h.layouts.at(-1).view.kind,"chat");
  assert.equal((await h.menu({scope:root,target,surface:"header"})).length,0);
});

test("sidebar returns to retained owner and restore removes tab before opening standalone page", async () => {
  const h=harness(),{root,target}=h;
  const items=await h.menu({scope:root,target,surface:"sidebar"});
  await items[1].onSelect();
  const owner=root.active;
  h.sidebar(root,"third","local");
  assert.equal(root.active.value.conversationId,"third");
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(root.active,owner);
  assert.equal(h.navigations.at(-1).path,"/local/first?project=test");
  assert.equal(h.focuses.at(-1).view.tab.props.conversationId,"second");
  h.sidebar(root,"third","local");
  const again=await h.menu({scope:root,target,surface:"sidebar"});
  await again[0].onSelect();
  assert.equal(root.active,owner);
  assert.equal(h.opens.length,1,"another page cannot create another copy");
  const restore=again.find(item=>item.id==="panel-thread-restore");
  assert.equal(restore.message.defaultMessage,"恢复为独立页面");
  await restore.onSelect();
  assert.equal(owner.tabs.size,0);
  assert.equal(root.active.value.conversationId,"second");
  assert.equal(h.layouts.at(-1).view.kind,"chat");
  assert.deepEqual(h.layouts.at(-1).options,{mode:"full"});
  h.sidebar(root,"first","local");
  assert.equal(root.active.value.conversationId,"first");
  await (await h.menu({scope:root,target,surface:"sidebar"}))[0].onSelect();
  assert.equal(h.opens.length,2,"restored chat may be explicitly opened again");
});

test("same conversation id on a different host remains a different target", async () => {
  const h=harness(),{root,target}=h;
  await (await h.menu({scope:root,target,surface:"sidebar"}))[0].onSelect();
  h.sidebar(root,"second","remote");
  assert.equal(h.navigations.at(-1).host,"remote");
  assert.equal(h.focuses.length,0);
});

test("native default-host navigation focuses the existing local tab", async () => {
  const h=harness({nativeHostArgument:true}),{root,target}=h;
  await (await h.menu({scope:root,target,surface:"sidebar"}))[1].onSelect();
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(h.navigations.length,0);
  assert.equal(h.currentComposer(),"local:second");
  assert.equal(root.active.state.mode,"split");
});


test("focus waits for native navigation to remount the owner page", async () => {
  const h=harness({deferNavigation:true}),{root,target}=h;
  await (await h.menu({scope:root,target,surface:"sidebar"}))[1].onSelect();
  const owner=root.active;
  h.sidebar(root,"third","local");
  h.sidebar(root,"second","local");
  await new Promise(setImmediate);
  assert.equal(root.active.node,owner.node);
  assert.equal(h.focuses.at(-1).view.tab.props.conversationId,"second");
  assert.equal(h.navigations.at(-1).path,"/local/first?project=test");
});


test("restoring main chat removes its companion conversation tabs without closing files", async () => {
  const h=harness(),{root,target}=h;
  await (await h.menu({scope:root,target,surface:"sidebar"}))[1].onSelect();
  const owner=root.active;
  owner.tabs.set("file:notes",{tabId:"file:notes",props:{path:"notes.md"}});
  const main=await h.menu({scope:root,target:{hostId:"local",conversationId:"first"},surface:"sidebar"});
  await main.find(item=>item.id==="panel-thread-restore").onSelect();
  assert.equal(owner.tabs.has("orbit-activity:local:second"),false,"standalone must not leave companion chat as a tab");
  assert.ok(owner.tabs.has("file:notes"));
  assert.equal(root.active,owner);
  assert.equal(h.layouts.at(-1).view.kind,"chat");
  h.sidebar(root,"second","local");
  assert.equal(root.active.value.conversationId,"second","companion remains available as its own page");
  const restored=await h.menu({scope:root,target,surface:"sidebar"});
  assert.equal(restored.some(item=>item.id==="panel-thread-restore"),false,"standalone companion must not retain restore action");
  const original={hostId:"local",conversationId:"first"};
  const other=await h.menu({scope:root,target:original,surface:"sidebar"});
  assert.deepEqual(Array.from(other,item=>item.id),["panel-thread-tab","panel-thread-split"]);
  h.sidebar(root,"first","local");
  assert.equal((await h.menu({scope:root,target:original,surface:"sidebar"})).some(item=>item.id==="panel-thread-restore"),false,"files alone must not expose conversation restore");
});


test("sidebar moves the input cursor and highlight between both split conversations", async () => {
  const h=harness(),{root,target}=h;
  await (await h.menu({scope:root,target,surface:"sidebar"}))[1].onSelect();
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(h.currentComposer(),"local:second","focus must reach the mounted content-tab composer, not its standalone alias");
  assert.ok(h.subscriptions.length,"sidebar must subscribe to native composer focus changes");
  const main={hostId:"local",conversationId:"first"};
  assert.equal(h.panelThreadIsActive(root,target,false,h.currentComposer()),true);
  assert.equal(h.panelThreadIsActive(root,main,true,h.currentComposer()),false);
  root.isActive=false;
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(root.renderedActive,true,"rendered row uses input focus instead of route highlight");
  assert.equal(root.routeActive,false,"native route-dependent actions keep their original state");
  root.isActive=true;
  h.sidebar(root,"first","local");
  assert.equal(root.renderedActive,false,"main row is inactive while child has input focus");
  assert.equal(root.renderedAttributes["data-app-action-sidebar-thread-selected"],"false","native selection attribute must not retain main-row highlight");
  assert.equal(root.renderedAttributes["data-app-action-sidebar-thread-active"],"false");
  await Promise.resolve();
  assert.equal(h.composerFocuses.at(-1),"client-new:first");
  assert.equal(root.active.state.focusPane,"main");
  assert.equal(h.panelThreadIsActive(root,target,false,h.currentComposer()),false);
  assert.equal(h.panelThreadIsActive(root,main,true,h.currentComposer()),true);
  h.sidebar(root,"second","local"); await Promise.resolve();
  assert.equal(h.currentComposer(),"local:second","focus must reach the mounted content-tab composer, not its standalone alias");

  assert.equal(h.panelThreadIsActive(root,target,false,h.currentComposer()),true);
  assert.equal(h.panelThreadIsActive(root,main,true,h.currentComposer()),false);
  assert.equal(h.layouts.length,1,"switching input focus preserves the split layout");
  assert.equal(h.navigations.length,0);
});
