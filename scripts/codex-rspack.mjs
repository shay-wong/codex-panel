import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCodexProviderQuotaRuntime } from './codex-provider-quota.mjs';
import { readCodexRspack, rspackSourceContext } from './codex-rspack-source.mjs';
import { rewriteRspackQuota } from './codex-rspack-quota.mjs';
import { rewriteRspackDot, rewriteRspackUltrafast } from './codex-rspack-capabilities.mjs';
import { createRspackThreadTabsRuntime, rewriteRspackThreadTabs } from './codex-rspack-tabs.mjs';

const transformers = { quota: rewriteRspackQuota, ultrafast: rewriteRspackUltrafast, dot: rewriteRspackDot, tabs: rewriteRspackThreadTabs, queue: rewriteRspackQueue };
const responsePatches = new WeakMap();

export function rewriteRspackQueue(source, context) {
  if (!source.includes('field:"queuedMessages"') || !source.includes('messages:void 0') || source.includes('panelQueueRequire')) return null;
  const id = '[A-Za-z_$][\\w$]*';
  const require = source.match(new RegExp(`^function\\s*[^\\(]*\\(${id},${id},(${id})\\)`))?.[1];
  const beforeQueue = source.slice(0, source.indexOf('field:"queuedMessages"'));
  const subscriptions = [...beforeQueue.matchAll(new RegExp(`\\(0,(${id})\\.(${id})\\)\\(${id},${id},\\(`, 'g'))];
  const publication = context.findModule(['statsigEvaluations', 'hasEvaluations', 'onMount:']);
  const signal = publication?.source.match(new RegExp(`let ${id}=${id}\\((${id})\\);if\\(${id}\\?\\.hasEvaluations`))?.[1];
  const exported = signal && publication.source.slice(publication.source.lastIndexOf('.d('))
    .match(new RegExp(`(${id}):(?:\\(\\)=>)?${signal.replaceAll('$', '\\$')}(?=[,}])`))?.[1];
  if (!require || subscriptions.length !== 1 || !publication || !exported) {
    throw new Error('Native queued-follow-up subscription is unsupported');
  }
  const subscription = `(0,${subscriptions[0][1]}.${subscriptions[0][2]})`;
  // A restored rollout must reload the server queue after an empty startup snapshot.
  const reactive = `((...panelQueueArgs)=>panelQueueArgs[0].watch(({get:panelQueueGet})=>{panelQueueGet(panelQueueRequire(${JSON.stringify(publication.id)}).${exported});return ${subscription}(...panelQueueArgs)}))`;
  return source.replace(/^(function\s*[^\(]*\([^)]*\)\{)/, `$1const panelQueueRequire=${require};`)
    .replace(subscription, reactive);
}

export async function installRspackResponse(cdp, url, source, report = console.error) {
  let patch = responsePatches.get(cdp);
  if (!patch) {
    patch = { url, source };
    responsePatches.set(cdp, patch);
    cdp.on('Fetch.requestPaused', async event => {
      try {
        if (event.request.url !== patch.url || event.responseStatusCode !== 200) {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
          return;
        }
        const headers = (event.responseHeaders ?? []).filter(header => !['content-length', 'content-encoding'].includes(header.name.toLowerCase()));
        await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
          responseHeaders: headers, body: Buffer.from(patch.source).toString('base64') });
      } catch (error) {
        report(`Panel Rspack entry unavailable: ${error.message}`);
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      }
    });
  }
  Object.assign(patch, { url, source });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: url, resourceType: 'Script', requestStage: 'Response' }] });
}

export function buildRspackPlan(catalog, adapters = transformers) {
  const selected = new Set();
  const context = rspackSourceContext(catalog.factories, selected);
  const prepared = {}, errors = {}, patches = {};
  for (const [feature, rewrite] of Object.entries(adapters)) {
    let count = 0;
    for (const module of catalog.factories.values()) {
      for (const variant of module.variants ?? [module]) {
        try {
          const changed = rewrite(variant.source, { ...context, moduleId: module.id });
          if (changed && changed !== variant.source) {
            new vm.Script(`(${changed})`);
            count++;
          }
        } catch (error) { errors[feature] = error.message; }
      }
    }
    prepared[feature] = count > 0 && !errors[feature];
    if (!count && !errors[feature]) errors[feature] = '未找到兼容的原生模块';
  }
  for (const module of catalog.factories.values()) {
    const variants = [];
    for (const variant of module.variants ?? [module]) {
      let after = variant.source;
      const features = [];
      for (const [feature, rewrite] of Object.entries(adapters)) {
        if (!prepared[feature]) continue;
        const changed = rewrite(after, { ...context, moduleId: module.id });
        if (changed && changed !== after) { after = changed; features.push(feature); }
      }
      if (features.length) {
        new vm.Script(`(${after})`);
        variants.push({ before: variant.source, after, features });
      }
    }
    if (variants.length) patches[module.id] = variants;
  }
  const chunks = Object.fromEntries([...selected].map(id => [id, catalog.factories.get(id)?.chunkIds ?? []]));
  return { patches, prepared, errors, chunks };
}

export function createCodexRspackRuntime(plan) {
  let nativeRequire;
  const runtime = {
    prepared: plan.prepared,
    get require() { return nativeRequire; },
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
      runtime.findModule = needles => {
        const terms = Array.isArray(needles) ? needles : [needles];
        const matches = Object.entries(table).filter(([, factory]) => typeof factory === 'function'
          && terms.every(term => originalSource(factory).includes(term)));
        return matches.length === 1 ? { id: matches[0][0], source: originalSource(matches[0][1]) } : null;
      };
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

export function rewriteRspackEntry(source, url) {
  const assignments = [...source.matchAll(/([\w$]+)\.m=([\w$]+),/g)];
  if (assignments.length !== 1) throw new Error('Codex Rspack 模块注册入口不唯一');
  const [assignment, require, table] = assignments[0];
  if (!source.includes(`${table}[`) || !source.includes(`${require}.C=`)) throw new Error('Codex Rspack 模块注册结构不支持');
  return source.replace(assignment, `${require}.m=${table}=globalThis.__codexPanelRspack__?.wrapFactories(${table},${require})??${table},`)
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, url).href)}`)
    .replace(/\bimport\((["'`])\.\.\/\1\+([\w$]+)\.u\(([\w$]+)\)\)/g,
      (_, quote, requireName, chunk) => `import(new URL("../"+${requireName}.u(${chunk}),${JSON.stringify(url)}).href)`)
    .replaceAll('import.meta.url', JSON.stringify(url));
}

export async function prepareCodexRspack(cdp, appPath, preferencesFile, report = console.error) {
  const catalog = await readCodexRspack(appPath);
  if (!catalog) return null;
  const result = await cdp.send('Runtime.evaluate', {
    expression: `([...document.querySelectorAll('script[type="module"][src]')].map(script=>script.src))`, returnByValue: true,
  });
  const url = result.result?.value?.find(candidate => new URL(candidate).pathname === catalog.main.urlPath);
  if (!url) return null;
  const plan = buildRspackPlan(catalog);
  for (const [feature, error] of Object.entries(plan.errors)) report(`Panel Rspack ${feature} unavailable: ${error}`);
  let preferences = {};
  if (preferencesFile) {
    try { preferences = JSON.parse(await readFile(preferencesFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const entry = rewriteRspackEntry(catalog.main.source, url);
  await installRspackResponse(cdp, url, entry, report);
  const source = `(() => {
    if(window!==window.top)return;
    const createState=${createCodexProviderQuotaRuntime};
    const quota=globalThis.__codexPanelProviderQuotaV1__??=createState(${preferences.customProviderQuotaFix === true});
    const speed=globalThis.__codexPanelProviderUltrafastV1__??=createState(${preferences.customProviderUltrafast === true});
    const dot=globalThis.__codexPanelDotEntryV1__??=createState(${preferences.showCustomProviderDot === true});
    quota.setEnabled(${preferences.customProviderQuotaFix === true});speed.setEnabled(${preferences.customProviderUltrafast === true});dot.setEnabled(${preferences.showCustomProviderDot === true});
    if(globalThis.__codexPanelRspack__)return;
    const plan=${JSON.stringify(plan)};
    globalThis.__codexPanelQuotaBootstrapPrepared__=plan.prepared.quota;
    globalThis.__codexPanelUltrafastBootstrapPrepared__=plan.prepared.ultrafast;
    globalThis.__codexPanelDotBootstrapPrepared__=plan.prepared.dot;
    globalThis.__codexPanelRspack__=(${createCodexRspackRuntime})(plan);
    globalThis.__codexPanelRspackTabsV1__=(${createRspackThreadTabsRuntime})();
    quota.prepared=true;
  })();`;
  return { source, prepared: plan.prepared, errors: plan.errors };
}
