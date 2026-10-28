const identifier = "[A-Za-z_$][\\w$]*";

// 复用原生已有会话标签，不使用会在关闭时丢弃会话的临时侧聊。
export function rewriteCodexThreadTabs(source, initialSource, initialUrl) {
  const registration = initialSource.match(new RegExp(`(${identifier})=(${identifier})\\(\x60orbit-activity\x60,[^;]+?open:(${identifier})\\}\\)`));
  if (!registration) return null;
  const openName = registration[3];
  const openStart = initialSource.indexOf(`function ${openName}(`);
  const openBody = initialSource.slice(openStart, initialSource.indexOf("var ", openStart));
  const controller = openBody.match(new RegExp(`(${identifier})\\.openTab\\(`))?.[1];
  const init = initialSource.slice(openStart).match(new RegExp(`function (${identifier})\\(\\)\\{return\\(\\1=`))?.[1];
  const layout = initialSource.match(new RegExp(`function (${identifier})\\((${identifier}),(${identifier}),(${identifier})\\)\\{if\\(\\4\\.mode===\x60full\x60&&\\3\\.kind===\x60chat\x60`))?.[1];
  const layoutStart = initialSource.indexOf(`function ${layout}(`);
  const layoutInit = initialSource.slice(layoutStart).match(new RegExp(`function (${identifier})\\(\\)\\{return\\(\\1=`))?.[1];
  // 同名标识符也可能出现在 import 中，必须只读取模块自己的导出表。
  const exports = initialSource.slice(initialSource.lastIndexOf("export{"));
  const exported = name => exports.match(new RegExp(`(?:,|\\{)${name?.replace(/\$/g, "\\$")} as (${identifier})(?=,|\\})`))?.[1];
  const focus = initialSource.match(new RegExp(`function (${identifier})\\((${identifier}),(${identifier})\\)\\{if\\(\\3\\.kind===\x60chat\x60\\)\\{${identifier}\\(\\2\\);return\\}${identifier}\\(\\2,\\3\\.tab\\.tabId\\)`))?.[1];
  const host = initialSource.match(new RegExp(`(${identifier})=${identifier}\\(${identifier},\\(\\{get:(${identifier})\\}\\)=>\\2\\(${identifier}\\)\\.hostId\\)`))?.[1];
  const navigateRoute = initialSource.match(new RegExp(`function (${identifier})\\((${identifier}),\\.\\.\\.(${identifier})\\)\\{return \\2\\.get\\(${identifier}\\)\\.navigate\\(\\.\\.\\.\\3\\)`))?.[1];
  const layoutState = initialSource.match(new RegExp(`(${identifier})=${identifier}\\(${identifier},\\(\\{get:(${identifier})\\}\\)=>\\2\\(${identifier}\\)===\x60full\x60\\?\\{mode:\x60full\x60\\}:\\{contentSide:\\2\\(${identifier}\\),mode:\x60split\x60\\}\\)`))?.[1];
  const composerFocus = initialSource.match(/function ([\w$]+)\(([\w$]+)\)\{[\w$]+\(\);let [\w$]+=\{composerId:\2,expiresTimeoutId:0,focusAnimationFrameId:null\}/);
  const composerSnapshot = initialSource.match(/function ([\w$]+)\(\)\{let ([\w$]+)=[\w$]+\(\);return \2==null\?null:[\w$]+\.get\(\2\)\?\.composerId\?\?null\}/);
  const composerSubscribe = initialSource.slice(composerFocus?.index, composerSnapshot?.index).match(/function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.add\(\2\),\(\)=>\{\3\.delete\(\2\)\}\}/)?.[1];
  const composerId = initialSource.match(/function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \2\.get\([\w$]+,([\w$]+)\(\3\)\)\}/);
  const names = [init, openName, controller, layoutInit, layout, focus, host, navigateRoute, layoutState, composerFocus?.[1], composerSnapshot?.[1], composerSubscribe, composerId?.[1], composerId?.[4]].map(exported);
  if (!controller || !init || !layout || !layoutInit || names.some(name => !name)) return null;
  const activeScope = source.match(new RegExp(`function (${identifier})\\((${identifier})\\)\\{let ${identifier}=\\2\\.get\\(${identifier}\\);if\\(${identifier}==null\\)return null;let ${identifier}=${identifier}\\(\\{pathname:[^}]+\\}\\);if\\(${identifier}\\.routeKind===\x60other\x60`))?.[1];
  const menus = [...source.matchAll(new RegExp(`async function ${identifier}\\(\\{scope:(${identifier}),target:(${identifier}),[^}]+surface:(${identifier}),[^}]+paneItems:(${identifier})\\}\\)`, "g"))];
  if (!activeScope || menus.length !== 1) return null;
  const [, scope, target, surface, paneItems] = menus[0];
  const insertion = new RegExp(`(${identifier})\\.push\\(\\.\\.\\.${paneItems}\\?\\?\\[\\]\\)`);
  const match = source.match(insertion);
  if (!match || source.match(new RegExp(insertion.source, "g"))?.length !== 1) return null;
  // 只拦截侧栏会话行的导航，不改变深链、工具调用或其他原生导航。
  const navigations = [...source.matchAll(new RegExp(`(${identifier})=(${identifier})\\((${identifier}),(${identifier}),(${identifier})===\x60local\x60\\?void 0:\\5,(${identifier})==null&&!(${identifier})\\?void 0:\\{state:\\6,threadAccess:\\7\\?\x60shared\x60:void 0\\}\\)`, "g"))];
  if (navigations.length !== 1) return null;
  const [navigation, result, navigate, root, conversation, hostId] = navigations[0];
  const rowStart = source.lastIndexOf("function ", navigations[0].index);
  const rowEnd = source.indexOf("function ", navigations[0].index);
  const row = source.slice(rowStart, rowEnd < 0 ? source.length : rowEnd);
  const activeProp = row.match(/isActive:([\w$]+)/)?.[1];
  const activeValue = row.match(new RegExp(`(${identifier})=${activeProp}!==void 0&&${activeProp},`));
  const resolvedHost = row.match(new RegExp(`(${identifier})=${hostId}\\?\\?${identifier}\\?\\.hostId\\?\\?${identifier}\\?\\?null,`));
  const react = row.match(/\(0,([\w$]+)\.startTransition\)/)?.[1];
  if (!activeValue || !resolvedHost || !react) return null;
  const presentationStart = row.lastIndexOf(";let ", row.lastIndexOf(`isActive:${activeValue[1]}`));
  if (presentationStart < 0) return null;
  // 只替换最终行样式与 React 缓存依赖，保留归档等操作对主页面状态的判断。
  const presentation = row.slice(presentationStart).replace(new RegExp(`\\b${activeValue[1].replace(/\$/g, "\\$")}\\b`, "g"), "panelThreadRowActive");
  const attributes = presentation.match(/dataAttributes:([\w$]+)/)?.[1];
  if (!attributes) return null;
  // 原生样式也读取 selected 属性；视觉焦点变化时必须和 isActive 同步。
  const activePresentation = presentation.replace(`dataAttributes:${attributes}`, `dataAttributes:panelThreadRowActive===${activeValue[1]}?${attributes}:{...${attributes},"data-app-action-sidebar-thread-active":String(panelThreadRowActive),"data-app-action-sidebar-thread-selected":String(panelThreadRowActive)}`);
  const activeRow = (row.slice(0,presentationStart) + activePresentation).replace(resolvedHost[0], resolvedHost[0] + `panelThreadRowActive=panelThreadIsActive(${root},{conversationId:${conversation},hostId:${resolvedHost[1]}??"local"},${activeValue[1]},(0,${react}.useSyncExternalStore)(panelThreadTabs11,panelThreadTabs10,panelThreadTabs10)),`);
  source = source.slice(0,rowStart) + activeRow + source.slice(rowEnd < 0 ? source.length : rowEnd);
  const imports = `import {${names.map((name, index) => `${name} as panelThreadTabs${index}`).join(",")}} from ${JSON.stringify(initialUrl)};`;
  const helper = `
const panelThreadOwners=new Map();
function panelThreadView(root,target){
  const scope=${activeScope}(root),id=\`orbit-activity:\${target.hostId}:\${target.conversationId}\`;
  panelThreadTabs0();panelThreadTabs3();
  for(const [key,owner] of panelThreadOwners){
    if(!owner.get(panelThreadTabs2.tabById$,key))panelThreadOwners.delete(key);
  }
  const isMain=owner=>owner?.value.routeKind==="local-thread"&&owner.value.conversationId===target.conversationId&&owner.get(panelThreadTabs6)===target.hostId;
  if(isMain(scope))return{scope,view:{kind:"chat"}};
  const owner=panelThreadOwners.get(id),tab=(owner??scope)?.get(panelThreadTabs2.tabById$,id);
  if(tab)return{scope:owner??scope,view:{kind:"content",tab}};
  for(const owner of panelThreadOwners.values()){
    if(isMain(owner))return{scope:owner,view:{kind:"chat"}};
  }
  return scope?{scope,view:null}:null;
}
function panelThreadModeAvailable(root,target,split){
  const found=panelThreadView(root,target);
  if(!found?.view)return true;
  if(found.view.kind==="chat")return false;
  const isSplit=found.scope.get(panelThreadTabs8).mode==="split"&&found.scope.get(panelThreadTabs2.activeTab$)?.tabId===found.view.tab.tabId;
  return split!==isSplit;
}
function panelThreadCanRestore(root,target){
  const found=panelThreadView(root,target);
  if(!found?.view)return false;
  if(found.view.kind==="content")return true;
  return [...panelThreadOwners.values()].some(owner=>owner.node===found.scope.node);
}
async function panelRevealThread(root,found){
  if(${activeScope}(root)?.node===found.scope.node)return;
  const owner=found.scope.value;
  panelThreadTabs7(root,owner.pathname+(owner.search??""));
  const deadline=Date.now()+5000;
  while(${activeScope}(root)?.node!==found.scope.node){
    if(Date.now()>deadline)throw Error("无法切换到会话所在页面");
    await new Promise(resolve=>requestAnimationFrame(resolve));
  }
}
function panelCloseThreadTab(scope,id){
  panelThreadTabs2.closeTab(scope,id,{recordCloseUndo:false});
  if(scope.get(panelThreadTabs2.tabById$,id)!=null)throw Error("无法移出会话标签页");
  panelThreadOwners.delete(id);
}
function panelRemoveDuplicate(target){
  const id=\`orbit-activity:\${target.hostId}:\${target.conversationId}\`,owner=panelThreadOwners.get(id);
  if(owner)panelCloseThreadTab(owner,id);
}
function panelThreadIsActive(root,target,fallback,composerId){
  const scope=${activeScope}(root);
  if(!scope||![...panelThreadOwners.values()].some(owner=>owner.node===scope.node))return fallback;
  const tab=scope.get(panelThreadTabs2.activeTab$),props=tab?.props;
  let selected=null;
  if(panelThreadOwners.get(tab?.tabId)?.node===scope.node&&composerId===panelThreadTabs13(props.conversationId)){
    selected={conversationId:props.conversationId,hostId:props.hostId};
  }else if(scope.value.routeKind==="local-thread"&&composerId===panelThreadTabs12(scope,scope.value.conversationId)){
    selected={conversationId:scope.value.conversationId,hostId:scope.get(panelThreadTabs6)};
  }
  return selected?selected.conversationId===target.conversationId&&selected.hostId===target.hostId:fallback;
}
function panelFocusThread(root,target){
  const found=panelThreadView(root,target);
  if(!found?.view)return false;
  if(found.view.kind==="chat")panelRemoveDuplicate(target);
  panelRevealThread(root,found).then(()=>{
    panelThreadTabs5(found.scope,found.view);
    // 内容标签注册原始 local 身份，主页面才使用恢复后的 client 身份。
    panelThreadTabs9(found.view.kind==="content"?panelThreadTabs13(target.conversationId):panelThreadTabs12(found.scope,target.conversationId));
  }).catch(console.error);
  return true;
}
async function panelOpenThreadTab(root,target,split){
  let found=panelThreadView(root,target);
  if(!found)throw Error("请先打开一个会话");
  await panelRevealThread(root,found);
  const {scope}=found;
  if(!found.view){
    panelThreadTabs1(scope,{hostId:target.hostId,threadId:target.conversationId},target.threadSummary?.title,{canInteract:true});
    found=panelThreadView(root,target);
    if(!found.view)throw Error("无法打开会话标签页");
    const tab=found.view.tab;
    panelThreadTabs2.updateTab(scope,tab.tabId,{props:{...tab.props,shouldResume:true}});
    panelThreadOwners.set(tab.tabId,scope);
  }
  if(found.view.kind==="chat")panelRemoveDuplicate(target);
  if(split&&found.view.kind==="chat"){panelThreadTabs5(scope,found.view);return;}
  panelThreadTabs4(scope,found.view,split?{mode:"split",contentSide:"right"}:{mode:"full"});
}
async function panelRestoreThread(root,target){
  const found=panelThreadView(root,target);
  if(!found?.view)return;
  await panelRevealThread(root,found);
  if(found.view.kind==="chat")panelRemoveDuplicate(target);
  if(found.view.kind==="content"){
    panelCloseThreadTab(found.scope,found.view.tab.tabId);
    ${navigate}(root,target.conversationId,target.hostId==="local"?undefined:target.hostId);
  }
  const deadline=Date.now()+5000;
  for(;;){
    const current=panelThreadView(root,target);
    if(current?.view?.kind==="chat"){
      // full 只改变布局；独立页面还需移出同组会话标签，保留原会话和文件标签。
      for(const [id,owner] of panelThreadOwners){
        if(owner.node===current.scope.node)panelCloseThreadTab(owner,id);
      }
      panelThreadTabs4(current.scope,current.view,{mode:"full"});return;
    }
    if(Date.now()>deadline)throw Error("无法恢复独立会话页面");
    await new Promise(resolve=>requestAnimationFrame(resolve));
  }
}

`;
  // 原生菜单使用 SVG data URL，沿用它的图标尺寸、着色和对齐。
  const icons = [
    '<path d="M7 3.5H4.5a1 1 0 0 0-1 1V13M7.5 6.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/><path d="M11.5 9v5m-2.5-2.5h5"/>',
    '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M10 4v12"/>',
    '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 7h14"/>',
  ].map(paths => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`));
  const items = `${surface}===\`sidebar\`&&${activeScope}(${scope})&&${match[1]}.push(...[false,true].filter(split=>panelThreadModeAvailable(${scope},${target},split)).map(split=>({id:split?"panel-thread-split":"panel-thread-tab",icon:split?${JSON.stringify(icons[1])}:${JSON.stringify(icons[0])},message:{id:split?"panel.thread.openSplit":"panel.thread.openTab",defaultMessage:document.documentElement.lang.startsWith("zh")?(split?"在右侧并排打开":"在新标签页中打开"):(split?"Open side by side":"Open in new tab")},selectAfterClose:true,onSelect:()=>panelOpenThreadTab(${scope},${target},split)}))),`;
  const restore = `${surface}===\x60sidebar\x60&&panelThreadCanRestore(${scope},${target})&&${match[1]}.push({id:"panel-thread-restore",icon:${JSON.stringify(icons[2])},message:{id:"panel.thread.restore",defaultMessage:document.documentElement.lang.startsWith("zh")?"恢复为独立页面":"Restore as standalone page"},selectAfterClose:true,onSelect:()=>panelRestoreThread(${scope},${target})}),`;
  const focusNavigation = `${result}=panelFocusThread(${root},{conversationId:${conversation},hostId:${hostId}})||${navigation.slice(result.length + 1)}`;
  return imports + source.replace(match[0], items + restore + match[0]).replace(navigation, focusNavigation) + "\n" + helper;
}

export async function prepareCodexThreadTabs(cdp, modules, report = console.error) {
  try {
    const loaded = await cdp.send("Runtime.evaluate", {
      expression: `(async()=>{const urls=[...performance.getEntriesByType("resource").map(e=>e.name),...[...document.querySelectorAll('script[type="importmap"]')].flatMap(e=>{try{return Object.keys(JSON.parse(e.textContent).imports??{})}catch{return []}})];return await Promise.all(["initial","primary"].map(async kind=>{const url=urls.find(url=>new RegExp("/app-"+kind+"-[\\\\w-]+\\\\.js$").test(new URL(url,location.href).pathname));if(!url)throw Error("Native thread module missing");const response=await fetch(url);if(!response.ok)throw Error("Native thread module unreadable");return{url,source:await response.text()}}))})()`,
      awaitPromise: true, returnByValue: false,
    });
    const objectId = loaded.result?.objectId;
    if (loaded.exceptionDetails || !objectId) throw Error("native thread modules unreadable");
    const nativeModules = [];
    try {
      // 原生模块合计超过十余 MB，整包返回会断开 CDP；保留远端对象并分块读取。
      for (let index = 0; index < 2; index++) {
        const metadata = await cdp.send("Runtime.callFunctionOn", {
          objectId, functionDeclaration: "function(index){return {url:this[index].url,length:this[index].source.length}}",
          arguments: [{ value: index }], returnByValue: true,
        });
        const value = metadata.result?.value;
        if (metadata.exceptionDetails || typeof value?.url !== "string" || !Number.isSafeInteger(value.length) || value.length <= 0) {
          throw Error("native thread module metadata unreadable");
        }
        let source = "";
        for (let start = 0; start < value.length; start += 500_000) {
          const chunk = await cdp.send("Runtime.callFunctionOn", {
            objectId, functionDeclaration: "function(index,start){return this[index].source.slice(start,start+500000)}",
            arguments: [{ value: index }, { value: start }], returnByValue: true,
          });
          if (chunk.exceptionDetails || typeof chunk.result?.value !== "string"
            || chunk.result.value.length !== Math.min(500_000, value.length - start)) {
            throw Error("native thread module chunk unreadable");
          }
          source += chunk.result.value;
        }
        nativeModules.push({ url: value.url, source });
      }
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId });
    }
    const [initial, original] = nativeModules;
    const primary = modules.find(module => module.url === original.url) ?? original;
    let source = rewriteCodexThreadTabs(primary.source, initial.source, initial.url);
    if (!source) throw Error("unsupported native thread tabs structure");
    source = source.replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, value) => `from${JSON.stringify(new URL(value, primary.url).href)}`)
      .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, value) => `import(${JSON.stringify(new URL(value, primary.url).href)})`)
      .replaceAll("import.meta.url", JSON.stringify(primary.url));
    report("Panel native conversation tabs prepared.");
    return [...modules.filter(module => module.url !== primary.url), { url: primary.url, source }];
  } catch (error) {
    report(`Panel conversation tabs unavailable: ${error.message}`);
    return modules;
  }
}
