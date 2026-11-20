import { sourceAst, property, propertyName, propertyValue, unwrap, isFunction, returnValue, applyEdits } from "./codex-source-ast.mjs";
import { absoluteModuleImports, esmFunction, esmOwnNodes, esmSameBinding, readCodexEsmModules } from "./codex-provider-quota.mjs";

const literal = (node, value) => unwrap(node)?.value === value || (unwrap(node)?.type === "TemplateLiteral"
  && unwrap(node).expressions.length === 0 && unwrap(node).quasis[0].value.cooked === value);
const member = (node,name) => node?.type === "MemberExpression" && propertyName(node) === name;
const equals = (node,name,value) => node?.type === "BinaryExpression" && ["===","=="].includes(node.operator)
  && (member(node.left,name) && literal(node.right,value) || member(node.right,name) && literal(node.left,value));
const one = items => items.length === 1 ? items[0] : null;

function exportedOwner(ast,node) {
  for(let parent=ast.parent(node);parent;parent=ast.parent(parent))if(isFunction(parent)&&ast.exportName(parent))return parent;
  return null;
}

function nativeTabs(ast) {
  const registration=one(ast.all(node=>node.type === "CallExpression" && literal(node.arguments[0],"orbit-activity") && property(node.arguments[2],"open")));
  if(!registration)return null;
  const open=ast.value(propertyValue(registration.arguments[2],"open"));
  if(!isFunction(open))return null;
  const controllerCall=one(esmOwnNodes(ast,open,node=>node.type === "CallExpression" && member(unwrap(node.callee),"openTab")));
  if(!controllerCall)return null;
  const init=exportedOwner(ast,registration),controller=unwrap(controllerCall.callee).object;
  const layout=one(ast.all(isFunction).filter(fn=>fn.params.length === 3 && esmOwnNodes(ast,fn,node=>equals(node,"mode","full")).length
    && esmOwnNodes(ast,fn,node=>equals(node,"kind","chat")).length));
  const focus=one(ast.all(isFunction).filter(fn=>fn.params.length === 2 && esmOwnNodes(ast,fn,node=>equals(node,"kind","chat")).length
    && esmOwnNodes(ast,fn,node=>member(node,"tabId")).length));
  const navigate=one(ast.all(isFunction).filter(fn=>fn.params.length === 2 && fn.params[1].type === "RestElement"
    && esmOwnNodes(ast,fn,node=>node.type === "CallExpression" && member(unwrap(node.callee),"navigate")).length));
  const hostCalls=ast.all(node=>node.type === "CallExpression" && isFunction(node.arguments[1])
    && member(returnValue(node.arguments[1]),"hostId"));
  const host=one(hostCalls.map(call=>ast.parent(call)).filter(node=>node?.type === "VariableDeclarator" || node?.type === "AssignmentExpression"));
  const layoutCalls=ast.all(node=>node.type === "CallExpression" && isFunction(node.arguments[1])
    && esmOwnNodes(ast,node.arguments[1],candidate=>candidate.type === "ObjectExpression" && literal(propertyValue(candidate,"mode"),"full")).length
    && esmOwnNodes(ast,node.arguments[1],candidate=>candidate.type === "ObjectExpression" && literal(propertyValue(candidate,"mode"),"split")).length);
  const layoutState=one(layoutCalls.map(call=>ast.parent(call)).filter(node=>node?.type === "VariableDeclarator" || node?.type === "AssignmentExpression"));
  const layoutInit=layoutState&&exportedOwner(ast,layoutState);
  // Top-level state is already initialized by importing this module.
  if(layoutState&&!layoutInit&&esmFunction(ast,layoutState))return null;
  const input=one(ast.all(isFunction).filter(fn=>esmOwnNodes(ast,fn,node=>node.type === "ObjectExpression" && property(node,"composerId")
    && property(node,"expiresTimeoutId") && property(node,"focusAnimationFrameId")).length));
  const snapshot=one(ast.all(isFunction).filter(fn=>fn.params.length===0&&esmOwnNodes(ast,fn,node=>member(node,"composerId")).length));
  const subscribe=one(ast.all(isFunction).filter(fn=>fn.params.length===1&&esmOwnNodes(ast,fn,node=>node.type === "CallExpression" && member(unwrap(node.callee),"add")
    && esmSameBinding(ast,node.arguments[0],fn.params[0])).length&&ast.all(node=>node.type === "CallExpression" && member(unwrap(node.callee),"delete")
    && esmSameBinding(ast,node.arguments[0],fn.params[0]),fn).length));
  const client=one(ast.all(isFunction).filter(fn=>{
    const value=returnValue(fn);
    return fn.params.length===2&&value?.type === "CallExpression"&&member(unwrap(value.callee),"get")
      && esmSameBinding(ast,unwrap(value.callee).object,fn.params[0])&&value.arguments[1]?.type === "CallExpression"
      && esmSameBinding(ast,value.arguments[1].arguments[0],fn.params[1]);
  }));
  const local=client&&returnValue(client).arguments[1].callee;
  const nodes=[init,open,controller,layoutInit,layout,focus,host?.id??host?.left,navigate,layoutState?.id??layoutState?.left,input,snapshot,subscribe,client,local];
  const names=nodes.map(node=>node&&ast.exportName(node));
  return names.every((name,index)=>index===3||Boolean(name))?names:null;
}

function sidebarSource(ast) {
  const active=one(ast.all(isFunction).filter(fn=>fn.params.length===1&&esmOwnNodes(ast,fn,node=>equals(node,"routeKind","other")).length
    && esmOwnNodes(ast,fn,node=>node.type === "ObjectExpression" && property(node,"pathname")).length));
  const menu=one(ast.all(isFunction).filter(fn=>fn.async&&fn.params.length===1&&["scope","target","surface","paneItems"].every(name=>property(fn.params[0],name))));
  if(!active||!menu)return null;
  const paneItems=propertyValue(menu.params[0],"paneItems");
  const push=one(esmOwnNodes(ast,menu,node=>node.type === "CallExpression"&&member(unwrap(node.callee),"push")&&node.arguments.length===1
    &&node.arguments[0].type === "SpreadElement"&&node.arguments[0].argument.type === "LogicalExpression"
    &&node.arguments[0].argument.operator === "??"&&esmSameBinding(ast,node.arguments[0].argument.left,paneItems)));
  const navigation=one(ast.all(node=>node.type === "CallExpression"&&node.arguments.length===4
    &&ast.all(candidate=>candidate.type === "ObjectExpression"&&property(candidate,"state")&&property(candidate,"threadAccess"),node.arguments[3]).length));
  if(!push||!navigation)return null;
  const row=esmFunction(ast,navigation),root=navigation.arguments[0],conversation=navigation.arguments[1];
  if(!row)return null;
  const nativeActive=one(esmOwnNodes(ast,row,node=>node.type === "ObjectPattern"&&property(node,"isActive")));
  const activeRef=nativeActive&&propertyValue(nativeActive,"isActive");
  const highlighted=activeRef&&one(esmOwnNodes(ast,row,node=>node.type === "VariableDeclarator"&&node.init?.type === "LogicalExpression"
    &&node.init.operator==="&&"&&esmSameBinding(ast,node.init.right,activeRef)&&node.init.left.type === "BinaryExpression"
    &&esmSameBinding(ast,node.init.left.left,activeRef)));
  const resolved=one(esmOwnNodes(ast,row,node=>node.type === "VariableDeclarator"&&node.init?.type === "LogicalExpression"&&node.init.operator==="??"
    &&ast.all(candidate=>member(candidate,"hostId"),node.init).length));
  const react=one(esmOwnNodes(ast,row,node=>node.type === "CallExpression"&&member(unwrap(node.callee),"startTransition")));
  const presentation=highlighted&&one(esmOwnNodes(ast,row,node=>node.type === "ObjectExpression"&&esmSameBinding(ast,propertyValue(node,"isActive"),highlighted.id)
    &&property(node,"dataAttributes")));
  if(!highlighted||!resolved||!react||!presentation)return null;
  const declaration=ast.parent(resolved);
  if(declaration?.type!=="VariableDeclaration")return null;
  const statement=ast.enclosing(presentation,node=>node.type === "ReturnStatement"||node.type === "VariableDeclaration"||node.type === "ExpressionStatement");
  if(!statement)return null;
  return {active,menu,push,navigation,row,root,conversation,highlighted,resolved,react:unwrap(react.callee).object,presentation,declaration,statement};
}

// Reuse native persistent conversation tabs and scope ownership.
export function rewriteCodexThreadTabs(source, initialSource, initialUrl) {
  let ast,initial,names,signature;
  try{ast=sourceAst(source);initial=sourceAst(initialSource);names=nativeTabs(initial);signature=sidebarSource(ast);}catch{return null;}
  if(!names||!signature)return null;
  const {active,menu,push,navigation,root,conversation,highlighted,resolved,react,presentation,declaration,statement}=signature;
  const activeScope=ast.text(active.id),navigate=ast.text(navigation.callee);
  const scope=ast.text(propertyValue(menu.params[0],"scope")),target=ast.text(propertyValue(menu.params[0],"target")),surface=ast.text(propertyValue(menu.params[0],"surface"));
  const match=[ast.text(push),ast.text(unwrap(push.callee).object)];
  const imports=`import {${names.map((name,index)=>name&&`${name} as panelThreadTabs${index}`).filter(Boolean).join(",")}} from ${JSON.stringify(initialUrl)};`;
  const helper = `
globalThis.__codexPanelThreadTabsReady__=true;
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
  const items = `${surface}==="sidebar"&&${activeScope}(${scope})&&${match[1]}.push(...[false,true].filter(split=>panelThreadModeAvailable(${scope},${target},split)).map(split=>({id:split?"panel-thread-split":"panel-thread-tab",icon:split?${JSON.stringify(icons[1])}:${JSON.stringify(icons[0])},message:{id:split?"panel.thread.openSplit":"panel.thread.openTab",defaultMessage:document.documentElement.lang.startsWith("zh")?(split?"在右侧并排打开":"在新标签页中打开"):(split?"Open side by side":"Open in new tab")},selectAfterClose:true,onSelect:()=>panelOpenThreadTab(${scope},${target},split)})))`;
  const restore = `${surface}==="sidebar"&&panelThreadCanRestore(${scope},${target})&&${match[1]}.push({id:"panel-thread-restore",icon:${JSON.stringify(icons[2])},message:{id:"panel.thread.restore",defaultMessage:document.documentElement.lang.startsWith("zh")?"恢复为独立页面":"Restore as standalone page"},selectAfterClose:true,onSelect:()=>panelRestoreThread(${scope},${target})})`;
  const attr=propertyValue(presentation,"dataAttributes"),activeName=ast.text(highlighted.id);
  const edits=[
    {start:declaration.end,end:declaration.end,text:`;const panelThreadRowActive=panelThreadIsActive(${ast.text(root)},{conversationId:${ast.text(conversation)},hostId:${ast.text(resolved.id)}??"local"},${activeName},(0,${ast.text(react)}.useSyncExternalStore)(panelThreadTabs11,panelThreadTabs10,panelThreadTabs10));`},
    {start:attr.start,end:attr.end,text:`panelThreadRowActive===${activeName}?${ast.text(attr)}:{...${ast.text(attr)},"data-app-action-sidebar-thread-active":String(panelThreadRowActive),"data-app-action-sidebar-thread-selected":String(panelThreadRowActive)}`},
    {start:push.start,end:push.end,text:`(${items},${restore},${ast.text(push)})`},
    {start:navigation.start,end:navigation.end,text:`(panelFocusThread(${ast.text(root)},{conversationId:${ast.text(conversation)},hostId:${ast.text(resolved.id)}??"local"})||${ast.text(navigation)})`},
    ...ast.references(ast.binding(highlighted.id)).filter(node=>node.start>=statement.start&&node.end<=statement.end).map(node=>({start:node.start,end:node.end,text:"panelThreadRowActive"})),
  ];
  try{return imports+(names[3]?"":"function panelThreadTabs3(){}")+applyEdits(source,edits)+"\n"+helper;}catch{return null;}
}

export async function prepareCodexThreadTabs(cdp, modules, report = console.error) {
  try {
    const hasNative=entries=>entries.some(module=>{try{return nativeTabs(sourceAst(module.source))!==null;}catch{return false;}})
      &&entries.some(module=>{try{return sidebarSource(sourceAst(module.source))!==null;}catch{return false;}});
    const sources=hasNative(modules)?modules:await readCodexEsmModules(cdp,modules,hasNative);
    const initials=sources.filter(module=>{try{return nativeTabs(sourceAst(module.source))!==null;}catch{return false;}});
    const primaries=sources.filter(module=>{try{return sidebarSource(sourceAst(module.source))!==null;}catch{return false;}});
    if(initials.length!==1||primaries.length!==1)throw Error("unsupported or ambiguous native thread tabs structure");
    const [initial,primary]=[initials[0],primaries[0]];
    const rewritten=rewriteCodexThreadTabs(primary.source,initial.source,initial.url);
    if(!rewritten)throw Error("unsupported native thread tabs structure");
    const source=absoluteModuleImports(rewritten,primary.url);
    report("Panel native conversation tabs prepared.");
    return [...modules.filter(module=>module.url!==primary.url),{url:primary.url,source}];
  }catch(error){
    report(`Panel conversation tabs unavailable: ${error.message}`);
    return modules;
  }
}
