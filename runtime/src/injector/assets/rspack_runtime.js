function createCodexRspackRuntime(plan) {
  let nativeRequire, entryWrapped = false;
  const runtime = {
    prepared: plan.prepared,
    nativeUpdate: plan.nativeUpdate,
    nativeServices: plan.nativeServices,
    get require() { return nativeRequire; },
    get entryWrapped() { return entryWrapped; },
    mergeDescriptors(next, require) {
      Object.assign(plan.patches, next.patches);
      Object.assign(plan.prepared, next.prepared);
      Object.assign(plan.chunks, next.chunks);
      Object.assign(plan.nativeUpdate, next.nativeUpdate);
      Object.assign(plan.nativeServices, next.nativeServices);
      if (require) nativeRequire = require;
    },
    wrapFactories(table, require) {
      nativeRequire = require;
      const originalSource = factory => {
        const original = factory.__codexPanelOriginalFactory__ ?? factory;
        const text = String(original);
        return /^(?:async\s+)?function\b/.test(text) ? text
          : text.replace(/^(async\s+)?[^ (]+\s*\(/, (_, prefix = '') => `${prefix}function(`);
      };
      const adapt = (id, factory) => {
        if (typeof factory !== 'function' || factory.__codexPanelOriginalFactory__ || !plan.patches[id]) return factory;
        const patch = plan.patches[id].find(candidate => candidate.before === originalSource(factory));
        if (!patch) { console.error(`Panel Rspack module changed before loading: ${id}`); return factory; }
        const replacement = new Function(`return (${patch.after})`)();
        function patchedFactory(...args) {
          const result = replacement.apply(this, args);
          for (const feature of patch.features) {
            if (feature === 'quota' && !globalThis.__codexPanelProviderQuotaV1__.applied) {
              globalThis.__codexPanelProviderQuotaV1__.applied = true;
              console.info('Panel custom-provider quota fix: native module executed.');
            }
          }
          return result;
        }
        Object.defineProperty(patchedFactory, '__codexPanelOriginalFactory__', { value: factory });
        return patchedFactory;
      };
      for (const id of Object.keys(table)) table[id] = adapt(id, table[id]);
      // 服务接口可提前取得 require；只有真正接管模块注册才能复用页面的适配状态。
      entryWrapped = true;
      return new Proxy(table, { set(target, id, value) { target[id] = adapt(id, value); return true; } });
    },
    async loadModule(id) {
      if (!nativeRequire) throw new Error('Codex 原生模块尚未初始化');
      if (!nativeRequire.m[id]) {
        const chunks = plan.chunks[id];
        if (!chunks?.length) throw new Error(`Codex 原生模块未找到：${id}`);
        await Promise.all(chunks.map(chunk => nativeRequire.e(chunk)));
      }
      return nativeRequire(id);
    },
  };
  return runtime;
}
