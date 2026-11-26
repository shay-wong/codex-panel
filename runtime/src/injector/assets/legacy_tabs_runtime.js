// 旧版 ESM 页面内的原生标签交互；宿主负责发现并替换两个绑定。

globalThis.__codexPanelThreadTabsReady__=true;
const panelThreadOwners=new Map();
function panelThreadView(root,target){
  const scope=__ACTIVE_SCOPE__(root),id=`orbit-activity:${target.hostId}:${target.conversationId}`;
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
  if(__ACTIVE_SCOPE__(root)?.node===found.scope.node)return;
  const owner=found.scope.value;
  panelThreadTabs7(root,owner.pathname+(owner.search??""));
  const deadline=Date.now()+5000;
  while(__ACTIVE_SCOPE__(root)?.node!==found.scope.node){
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
  const id=`orbit-activity:${target.hostId}:${target.conversationId}`,owner=panelThreadOwners.get(id);
  if(owner)panelCloseThreadTab(owner,id);
}
function panelThreadIsActive(root,target,fallback,composerId){
  const scope=__ACTIVE_SCOPE__(root);
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
    __NAVIGATE__(root,target.conversationId,target.hostId==="local"?undefined:target.hostId);
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
