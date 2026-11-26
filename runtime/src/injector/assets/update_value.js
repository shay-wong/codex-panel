async function readNativeUpdateValue(kind, binding) {
  const load=await findCodexRspackRequire();
  if (load) {
    const cached=globalThis.__codexPanelNativeUpdate__;
    binding=globalThis.__codexPanelRspack__?.nativeUpdate?.[kind]??(cached?.load===load?cached[kind]:null)??binding;
    if (!binding?.id) return {needsNativeUpdateBinding:true,rspack:true};
    globalThis.__codexPanelNativeUpdate__={...(cached?.load===load?cached:{}),load,[kind]:binding};
  } else if (!binding?.url) return {needsNativeUpdateBinding:true,rspack:false};
  const module=load
    ? await (globalThis.__codexPanelRspack__?.loadModule?.(binding.id) ?? load(binding.id))
    : await import(binding.url);
  const value=module[binding.name];
  if(kind==="subscription") {
    if(typeof value!=="function")throw Error("无法识别 Codex 原生更新状态订阅");
    let state;
    const unsubscribe=value(next=>{state=next;});
    unsubscribe();
    if(!state)throw Error("Codex 尚未提供更新状态，请稍后重试");
    return {isUpdateReady:state.isUpdateReady,lifecycleState:state.lifecycleState,downloadProgressPercent:state.downloadProgressPercent,downloadedUpdateAppBrand:state.downloadedUpdateAppBrand};
  }
  if(value?.scope?.__scopeBrand!=="AppScope"||typeof value.resolve!=="function")throw Error("无法识别当前 Codex 更新频道");
  for(const anchor of document.querySelectorAll('nav[data-app-navigation-rail], [data-codex-composer-root]')) {
    const key=Object.keys(anchor).find(key=>key.startsWith("__reactFiber$"));
    for(let fiber=anchor[key];fiber;fiber=fiber.return) {
      const chain=fiber.memoizedProps?.value;
      const node=chain instanceof Map?chain.get(value.scope.id):null;
      if(node?.token!==value.scope||!node.store?.get)continue;
      const state=node.store.get(value.resolve(node,chain));
      if(state.isLoading||typeof state.enabled!=="boolean")throw Error("Codex 更新频道尚未就绪");
      return {beta:state.enabled};
    }
  }
  throw Error("Codex 更新频道尚未就绪");
}
