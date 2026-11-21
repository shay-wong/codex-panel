import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { sourceAst, propertyName, propertyValue, unwrap, isFunction, returnValue, unique, applyEdits } from './codex-source-ast.mjs';
import { createCodexProviderQuotaRuntime } from './codex-provider-quota.mjs';
import { readCodexRspack, readCodexRspackIdentity, rspackSourceContext } from './codex-rspack-source.mjs';
import { rewriteRspackQuota } from './codex-rspack-quota.mjs';
import { rewriteRspackDot, rewriteRspackUltrafast, rewriteRspackProjectlessChat } from './codex-rspack-capabilities.mjs';
import { createRspackThreadTabsRuntime, rewriteRspackThreadTabs } from './codex-rspack-tabs.mjs';
import { buildNativeServiceBindings, createPetAnimationRuntime, rewriteRspackPets, installPetAudioBinding } from './codex-rspack-pets.mjs';
import { readBuiltinLumi } from './pet-animations.mjs';
import { buildCodexUpdateBindings, findCodexRspackRequire } from './codex-update.mjs';

const transformers = { quota: rewriteRspackQuota, ultrafast: rewriteRspackUltrafast, dot: rewriteRspackDot, tabs: rewriteRspackThreadTabs, queue: rewriteRspackQueue, pets: rewriteRspackPets, projectlessChat: rewriteRspackProjectlessChat };
const responsePatches = new WeakMap();
const preparedPlans = new Map();
const planCacheFormat = 1;
const featureTerms = {
  quota: ['data-codex-composer-root'], ultrafast: ['serviceTierSettings'], dot: ['isCapable'],
  tabs: ['paneItems', 'dataAttributes', 'navigationState'], queue: ['queuedMessages', 'QueuedMessageList'],
  pets: ['The original Codex companion.', '/settings/account_user_setting', 'data-codex-pet-state'],
  projectlessChat: ['canStartProjectlessChat', 'startNewConversation'],
};

export function rewriteRspackQueue(source, context) {
  if (source.includes('data-codex-panel-queued-messages') || source.includes('panelQueueRequire')) return null;
  if (!source.includes('queuedMessages') && !source.includes('QueuedMessageList')) return null;
  const ast = context?.ast?.(source) ?? sourceAst(source, { factory: true });
  const queueList = ast.exports().get('QueuedMessageList');
  if (queueList) {
    const component = ast.value(queueList);
    const items = ast.all(node => node.type === 'CallExpression' && propertyName(unwrap(node.callee)) === 'jsx'
      && propertyName(unwrap(node.arguments[0])) === 'Item'
      && propertyValue(node.arguments[1], 'initial'), component);
    const props = unique(items, 'Native queued-message rail is unsupported').arguments[1];
    return applyEdits(source, [{ start: props.start + 1, end: props.start + 1, text: '"data-codex-panel-queued-messages":"",' }]);
  }
  const subscriptions = ast.all(node => node.type === 'CallExpression' && propertyName(unwrap(node.callee)) === 'subscribe'
    && propertyValue(node.arguments[0], 'field')?.value === 'queuedMessages');
  const candidates = subscriptions.flatMap(rpc => {
    const callback = ast.enclosing(rpc, isFunction);
    const subscription = callback && ast.enclosing(callback, node => node.type === 'CallExpression' && node.arguments.includes(callback));
    const callee = subscription && unwrap(subscription.callee);
    return subscription && callee.type === 'MemberExpression' && subscription.arguments.length >= 3 ? [{ subscription, callee }] : [];
  });
  if (!candidates.length) return null;
  const { callee, subscription: subscriptionCall } = unique(candidates, 'Native queued-follow-up subscription is ambiguous');
  const signalCandidates = [];
  for (const module of context.modulesContaining('statsigEvaluations')) {
    const dependency = context.moduleAst(module.id);
    for (const member of dependency.all(node => node.type === 'MemberExpression' && propertyName(node) === 'statsigEvaluations')) {
      const mount = dependency.enclosing(member, node => node.type === 'Property' && propertyName(node) === 'onMount');
      const create = mount && dependency.enclosing(mount, node => node.type === 'CallExpression');
      const declaration = create && dependency.enclosing(create, node => node.type === 'VariableDeclarator');
      const descriptor = declaration && context.exportOf(dependency, declaration.id);
      if (descriptor && !signalCandidates.some(value => value.id === descriptor.id && value.exportName === descriptor.exportName)) signalCandidates.push(descriptor);
    }
  }
  const versionCandidates = [];
  for (const module of context.modulesContaining('appServerVersion$')) {
    const dependency = context.moduleAst(module.id);
    for (const member of dependency.all(node => node.type === 'MemberExpression' && propertyName(node) === 'appServerVersion$')) {
      const read = dependency.parent(member);
      if (read?.type !== 'CallExpression' || !read.arguments.includes(member)) continue;
      const callback = dependency.enclosing(read, isFunction);
      let result = callback && unwrap(dependency.value(returnValue(callback)));
      if (result?.type === 'LogicalExpression' && result.operator === '??' && result.right.type === 'Literal' && result.right.value === null) result = unwrap(dependency.value(result.left));
      if (result !== read) continue;
      const create = callback && dependency.parent(callback);
      if (create?.type !== 'CallExpression' || !create.arguments.includes(callback)) continue;
      const declaration = dependency.enclosing(create, node => node.type === 'VariableDeclarator');
      const descriptor = declaration && context.exportOf(dependency, declaration.id);
      if (descriptor) versionCandidates.push(descriptor);
    }
  }
  const publication = unique(signalCandidates, 'Native settings publication is unsupported');
  const version = unique(versionCandidates, 'Native core version signal is unsupported');
  const require = ast.factory.params[2];
  if (require?.type !== 'Identifier') throw new Error('Native queue factory require is unsupported');
  const subscription = `(${ast.text(subscriptionCall.callee)})`;
  const load = descriptor => `panelQueueRequire(${JSON.stringify(descriptor.id)})[${JSON.stringify(descriptor.exportName)}]`;
  const reactive = `((...panelQueueArgs)=>panelQueueArgs[0].watch(({get:panelQueueGet})=>{panelQueueGet(${load(publication)});panelQueueGet(${load(version)},panelQueueArgs[1].hostId);return ${subscription}(...panelQueueArgs)}))`;
  const firstStatement = ast.factory.body.body.find(node => !node.directive)?.start ?? ast.factory.body.end - 1;
  return applyEdits(source, [
    { start: firstStatement, end: firstStatement, text: `const panelQueueRequire=${ast.text(require)};` },
    { start: callee.start, end: callee.end, text: reactive },
  ]);
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

export function buildRspackFeaturePlan(catalog, feature, onProgress, rewrite = transformers[feature]) {
  const selected = new Set(), context = rspackSourceContext(catalog.factories, selected);
  const patches = {}, errors = {};
  const total = [...catalog.factories.values()].reduce((count, module) => count + (module.variants?.length ?? 1), 0);
  let count = 0, completed = 0, moduleId;
  const terms = rewrite === transformers[feature] ? featureTerms[feature] : null;
  for (const module of catalog.factories.values()) {
    for (const variant of module.variants ?? [module]) {
      moduleId = module.id;
      onProgress?.({ phase: 'adapt', feature, moduleId, completed, total });
      try {
        if (!terms || terms.some(term => variant.contains?.(term) ?? variant.source.includes(term))) {
          const changed = rewrite(variant.source, { ...context, moduleId: module.id });
          if (changed && changed !== variant.source) {
            new vm.Script(`(${changed})`);
            (patches[module.id] ??= []).push({ before: variant.source, after: changed, features: [feature] });
            count++;
          }
        }
      } catch (error) { errors[feature] = error.message; }
      completed++;
    }
  }
  onProgress?.({ phase: 'adapt', feature, moduleId, completed, total });
  const prepared = { [feature]: count > 0 && !errors[feature] };
  if (!count && !errors[feature]) errors[feature] = '未找到兼容的原生模块';
  const nativeServices = feature === 'pets' ? buildNativeServiceBindings(context) : {};
  const chunks = Object.fromEntries([...selected].map(id => [id, catalog.factories.get(id)?.chunkIds ?? []]));
  return { patches: prepared[feature] ? patches : {}, prepared, errors, chunks, nativeServices, nativeUpdate: {} };
}

export function buildRspackUpdatePlan(catalog, onProgress) {
  onProgress?.({ phase: 'adapt', feature: 'nativeUpdate', completed: 0, total: 1 });
  const nativeUpdate = buildCodexUpdateBindings(catalog.factories);
  const chunks = Object.fromEntries(Object.values(nativeUpdate).filter(Boolean).map(descriptor => [descriptor.id, catalog.factories.get(descriptor.id)?.chunkIds ?? []]));
  onProgress?.({ phase: 'adapt', feature: 'nativeUpdate', completed: 1, total: 1 });
  return { patches: {}, prepared: {}, errors: {}, chunks, nativeServices: {}, nativeUpdate };
}

export function composeRspackFeaturePlans(catalog, plans, onProgress, adapters = transformers) {
  const prepared = Object.assign({}, ...plans.map(plan => plan.prepared));
  const errors = Object.assign({}, ...plans.map(plan => plan.errors));
  const chunks = Object.assign({}, ...plans.map(plan => plan.chunks));
  const nativeServices = Object.assign({}, ...plans.map(plan => plan.nativeServices));
  const nativeUpdate = Object.assign({}, ...plans.map(plan => plan.nativeUpdate));
  const patches = {}, selected = new Set(), context = rspackSourceContext(catalog.factories, selected);
  const candidates = [...new Set(plans.flatMap(plan => Object.keys(plan.patches)))];
  const total = candidates.reduce((count, id) => count + (catalog.factories.get(id).variants?.length ?? 1), 0);
  let completed = 0, moduleId;
  for (const id of candidates) {
    const module = catalog.factories.get(id), variants = [];
    for (const variant of module.variants ?? [module]) {
      moduleId = id;
      onProgress?.({ phase: 'compose', moduleId, completed, total });
      const matches = plans.flatMap(plan => plan.patches[id] ?? []).filter(patch => patch.before === variant.source);
      if (matches.length === 1) variants.push(matches[0]);
      else if (matches.length > 1) {
        let after = variant.source;
        const features = [];
        for (const [feature, rewrite] of Object.entries(adapters)) {
          if (!prepared[feature]) continue;
          const changed = rewrite(after, { ...context, moduleId: id });
          if (changed && changed !== after) { after = changed; features.push(feature); }
        }
        new vm.Script(`(${after})`);
        variants.push({ before: variant.source, after, features });
      }
      completed++;
    }
    if (variants.length) patches[id] = variants;
  }
  onProgress?.({ phase: 'compose', moduleId, completed, total });
  for (const id of selected) chunks[id] = catalog.factories.get(id)?.chunkIds ?? [];
  return { patches, prepared, errors, chunks, nativeUpdate, nativeServices };
}

export function buildRspackPlan(catalog, adapters = transformers, onProgress) {
  const plans = Object.entries(adapters).map(([feature, rewrite]) => buildRspackFeaturePlan(catalog, feature, onProgress, rewrite));
  const native = buildRspackUpdatePlan(catalog);
  if (!('pets' in adapters)) {
    const selected = new Set();
    native.nativeServices = buildNativeServiceBindings(rspackSourceContext(catalog.factories, selected));
    for (const id of selected) native.chunks[id] = catalog.factories.get(id)?.chunkIds ?? [];
  }
  return composeRspackFeaturePlans(catalog, [...plans, native], onProgress, adapters);
}

function reusablePlan(value, features) {
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const plan = value?.plan;
  return object(value?.main) && typeof value.main.source === 'string' && typeof value.main.urlPath === 'string'
    && object(plan) && object(plan.prepared) && object(plan.errors) && Object.keys(plan.errors).length === 0
    && features.every(feature => plan.prepared[feature] === true)
    && object(plan.patches) && Object.values(plan.patches).every(variants => Array.isArray(variants)
      && variants.every(variant => typeof variant.before === 'string' && typeof variant.after === 'string'
        && Array.isArray(variant.features) && variant.features.every(feature => typeof feature === 'string')))
    && object(plan.chunks) && Object.values(plan.chunks).every(Array.isArray)
    && object(plan.nativeUpdate) && object(plan.nativeServices);
}

const planDigest = value => createHash('sha256').update(JSON.stringify([value.main, value.plan])).digest('hex');

function runRspackWorker(workerData, { onProgress, unrefWorkers = false } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./codex-rspack-worker.mjs', import.meta.url), {
      workerData,
      execArgv: [],
    });
    let received = false, result, failure;
    worker.on('message', message => {
      if (message.type === 'progress') onProgress?.(message.progress);
      else {
        received = true;
        if (message.type === 'error') failure = new Error(message.message);
        else result = message.result;
      }
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (failure) reject(failure);
      else if (!received || code !== 0) reject(new Error(`Codex adaptation worker exited before completing (${code})`));
      else resolve(result);
    });
    if (unrefWorkers) worker.unref();
  });
}

export async function buildCodexRspackInWorker(appPath, { petsOnly = false, onProgress, onFeaturePrepared, unrefWorkers = false } = {}) {
  const workerOptions = { onProgress, unrefWorkers };
  const catalog = await runRspackWorker({ task: 'read', appPath }, workerOptions);
  if (!catalog) return null;
  const features = petsOnly ? ['pets'] : Object.keys(transformers);
  const jobs = ['nativeUpdate', ...features.toSorted((a, b) => Number(b === 'pets') - Number(a === 'pets'))];
  const progressByFeature = new Map(jobs.map(feature => [feature, 0]));
  const reportFeatureProgress = progress => {
    if (progress.total > 0) progressByFeature.set(progress.feature, progress.completed / progress.total);
    onProgress?.({ ...progress, percent: [...progressByFeature.values()].reduce((sum, value) => sum + value, 0) / jobs.length * 100 });
  };
  const plans = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const index = next++, feature = jobs[index];
      let plan;
      try { plan = await runRspackWorker({ task: 'feature', catalog, feature }, { ...workerOptions, onProgress: reportFeatureProgress }); }
      catch (error) {
        plan = { patches: {}, chunks: {}, nativeUpdate: {}, nativeServices: {},
          prepared: feature === 'nativeUpdate' ? {} : { [feature]: false }, errors: { [feature]: error.message } };
      }
      plans[index] = plan;
      progressByFeature.set(feature, 1);
      reportFeatureProgress({ phase: 'adapt', feature });
      onFeaturePrepared?.({ feature, plan });
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, lane));
  const plan = await runRspackWorker({ task: 'compose', catalog, plans }, workerOptions);
  return { main: catalog.main, plan };
}

export async function prepareCodexRspackPlan(appPath, {
  cacheDirectory, adapterRevision, petsOnly = false, report = console.error, onProgress, onFeaturePrepared, unrefWorkers = false,
  readCatalog = readCodexRspack, buildPlan = buildRspackPlan,
} = {}) {
  const adapters = petsOnly ? { pets: rewriteRspackPets } : transformers;
  const features = Object.keys(adapters);
  const publishCached = (plan, notify) => {
    if (!notify) return;
    for (const feature of ['nativeUpdate', ...Object.keys(plan.prepared)]) {
      notify({ feature, plan: { ...plan, nativeServices: feature === 'pets' ? plan.nativeServices : {},
        nativeUpdate: feature === 'nativeUpdate' ? plan.nativeUpdate : {} } });
    }
  };
  const build = async notify => {
    if (readCatalog === readCodexRspack && buildPlan === buildRspackPlan) {
      return buildCodexRspackInWorker(appPath, { petsOnly, onProgress, onFeaturePrepared: notify, unrefWorkers });
    }
    onProgress?.({ phase: 'read' });
    const catalog = await readCatalog(appPath, { onProgress });
    if (!catalog) return null;
    const plan = buildPlan(catalog, adapters, onProgress);
    publishCached(plan, notify);
    return { main: catalog.main, plan };
  };
  if (!cacheDirectory || typeof adapterRevision !== 'string' || !adapterRevision) return build(onFeaturePrepared);
  onProgress?.({ phase: 'cache' });
  const identity = await readCodexRspackIdentity(appPath);
  if (!identity) return null;
  const key = createHash('sha256').update(JSON.stringify([planCacheFormat, identity.key, adapterRevision, petsOnly ? 'pets' : 'full'])).digest('hex');
  const directory = path.resolve(cacheDirectory);
  const memoryKey = `${directory}:${key}`;
  const shared = preparedPlans.get(memoryKey);
  if (shared) {
    if (shared.listeners && onFeaturePrepared) {
      for (const event of shared.events) onFeaturePrepared(event);
      shared.listeners.push(onFeaturePrepared);
    } else if (onFeaturePrepared) {
      const result = await shared.pending;
      publishCached(result.plan, onFeaturePrepared);
    }
    return shared.pending;
  }
  const entry = { events: [], listeners: onFeaturePrepared ? [onFeaturePrepared] : [] };
  const publish = event => {
    entry.events.push(event);
    for (const listener of entry.listeners) listener(event);
  };

  const pending = (async () => {
    const file = path.join(directory, `${key}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.format === planCacheFormat && cached.key === key && reusablePlan(cached, features) && cached.digest === planDigest(cached)) {
        publishCached(cached.plan, publish);
        return { main: cached.main, plan: cached.plan };
      }
    } catch { /* Missing or damaged static caches are rebuilt from the installed archive. */ }
    const result = await build(publish);
    if (!reusablePlan(result, features)) return result;
    // An updater may replace the archive while its source is being analyzed.
    if ((await readCodexRspackIdentity(appPath))?.key !== identity.key) return result;
    let temporary;
    try {
      onProgress?.({ phase: 'write' });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ format: planCacheFormat, key, digest: planDigest(result), ...result }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) { report(`Panel Rspack cache unavailable: ${error.message}`); }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  })();
  entry.pending = pending;
  preparedPlans.set(memoryKey, entry);
  try {
    const result = await pending;
    if (!reusablePlan(result, features) || (await readCodexRspackIdentity(appPath))?.key !== identity.key) preparedPlans.delete(memoryKey);
    else preparedPlans.set(memoryKey, { pending });
    return result;
  } catch (error) {
    preparedPlans.delete(memoryKey);
    throw error;
  }
}

export function createCodexRspackRuntime(plan) {
  let nativeRequire;
  const runtime = {
    prepared: plan.prepared,
    nativeUpdate: plan.nativeUpdate,
    nativeServices: plan.nativeServices,
    get require() { return nativeRequire; },
    mergeDescriptors(next, require) {
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

export async function applyCodexRspackFeature(cdp, plan) {
  const { nativeUpdate, nativeServices } = plan;
  if (![...Object.values(nativeUpdate), ...Object.values(nativeServices)].some(Boolean)) return [];
  const descriptors = { chunks: plan.chunks, nativeUpdate, nativeServices };
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async()=>{
      const load=await (${findCodexRspackRequire})();
      if(!load)return [];
      const descriptors=${JSON.stringify(descriptors)};
      let runtime=globalThis.__codexPanelRspack__;
      if(!runtime?.mergeDescriptors){
        runtime=globalThis.__codexPanelRspack__=(${createCodexRspackRuntime})({patches:{},prepared:{},chunks:{},nativeUpdate:{...runtime?.nativeUpdate},nativeServices:{...runtime?.nativeServices}});
      }
      runtime.mergeDescriptors(descriptors,load);
      return ["nativeUpdate","nativeServices"].filter(key=>Object.values(descriptors[key]??{}).some(Boolean));
    })()`, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value ?? [];
}

export function rewriteRspackEntry(source, url) {
  const ast = sourceAst(source);
  const same = (left, right) => left?.type === 'Identifier' && right?.type === 'Identifier'
    && ast.binding(left) != null && ast.binding(left) === ast.binding(right);
  const registrations = ast.all(node => node.type === 'AssignmentExpression' && node.operator === '='
    && node.left.type === 'MemberExpression' && propertyName(node.left) === 'm' && node.right.type === 'Identifier')
    .filter(node => {
      const require = ast.value(node.left.object);
      return isFunction(require) && ast.all(value => value.type === 'MemberExpression' && value.computed && same(value.object, node.right), require).length > 0;
    });
  const registration = unique(registrations, 'Codex Rspack 模块注册入口不唯一');
  const require = ast.text(registration.left.object), table = ast.text(registration.right);
  const edits = [{ start: registration.start, end: registration.end,
    text: `${ast.text(registration.left)}=${table}=globalThis.__codexPanelRspack__?.wrapFactories(${table},${require})??${table}` }];
  const tableDeclaration = ast.parent(ast.binding(registration.right)?.declaration);
  if (tableDeclaration?.type === 'VariableDeclaration' && tableDeclaration.kind === 'const') {
    edits.push({ start: tableDeclaration.start, end: tableDeclaration.start + 'const'.length, text: 'let' });
  }
  const relative = node => node?.type === 'Literal' && typeof node.value === 'string' && /^\.\.?\//.test(node.value)
    || node?.type === 'BinaryExpression' && node.operator === '+' && relative(node.left)
    || node?.type === 'TemplateLiteral' && /^\.\.?\//.test(node.quasis[0]?.value.cooked ?? '');
  for (const node of ast.nodes) {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && relative(node.source)) {
      edits.push({ start: node.source.start, end: node.source.end, text: JSON.stringify(new URL(node.source.value, url).href) });
    } else if (node.type === 'ImportExpression' && relative(node.source)) {
      edits.push({ start: node.source.start, end: node.source.end, text: `new URL(${ast.text(node.source)},${JSON.stringify(url)}).href` });
    } else if (node.type === 'MemberExpression' && propertyName(node) === 'url' && node.object.type === 'MetaProperty'
      && node.object.meta.name === 'import' && node.object.property.name === 'meta') {
      edits.push({ start: node.start, end: node.end, text: JSON.stringify(url) });
    }
  }
  return applyEdits(source, edits);
}
export async function prepareCodexRspack(cdp, appPath, preferencesFile, report = console.error, { petsOnly = false, petAnimations = [], cacheDirectory, adapterRevision, onProgress, onFeaturePrepared, unrefWorkers = false } = {}) {
  const prepared = await prepareCodexRspackPlan(appPath, { petsOnly, cacheDirectory, adapterRevision, report, onProgress, onFeaturePrepared, unrefWorkers });
  if (!prepared) return null;
  const { main, plan } = prepared;
  if (Object.values(plan.prepared).every(Boolean)) onProgress?.({ phase: 'prepared' });
  const result = await cdp.send('Runtime.evaluate', {
    expression: `([...document.querySelectorAll('script[type="module"][src]')].map(script=>script.src))`, returnByValue: true,
  });
  const url = result.result?.value?.find(candidate => new URL(candidate).pathname === main.urlPath);
  if (!url) return null;
  for (const [feature, error] of Object.entries(plan.errors)) report(`Panel Rspack ${feature} unavailable: ${error}`);
  if (petsOnly && !plan.prepared.pets) return { source: '', prepared: plan.prepared, errors: plan.errors };
  if (plan.prepared.pets) await installPetAudioBinding(cdp);
  let preferences = {};
  if (preferencesFile) {
    try { preferences = JSON.parse(await readFile(preferencesFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const petSource = plan.prepared.pets ? `const pets=globalThis.__codexPanelPetAnimations__??=(${createPetAnimationRuntime})([],${JSON.stringify(await readBuiltinLumi())});pets.setSoundEnabled(${preferences.petSounds !== false});pets.setPacks(${JSON.stringify(petAnimations)});` : '';
  const entry = rewriteRspackEntry(main.source, url);
  await installRspackResponse(cdp, url, entry, report);
  if (petsOnly) {
    return { source: `(() => {
      if(window!==window.top)return;
      ${petSource}
      if(globalThis.__codexPanelRspack__){globalThis.__codexPanelRspack__.mergeDescriptors?.(${JSON.stringify(plan)});return;}
      globalThis.__codexPanelRspack__=(${createCodexRspackRuntime})(${JSON.stringify(plan)});
    })();`, prepared: plan.prepared, errors: plan.errors };
  }
  const source = `(() => {
    if(window!==window.top)return;
    const createState=${createCodexProviderQuotaRuntime};
    const quota=globalThis.__codexPanelProviderQuotaV1__??=createState(${preferences.customProviderQuotaFix === true});
    const speed=globalThis.__codexPanelProviderUltrafastV1__??=createState(${preferences.customProviderUltrafast === true});
    const dot=globalThis.__codexPanelDotEntryV1__??=createState(${preferences.showCustomProviderDot === true});
    const projectless=globalThis.__codexPanelProjectlessChatV1__??=createState(${preferences.defaultProjectlessChat === true});
    quota.setEnabled(${preferences.customProviderQuotaFix === true});speed.setEnabled(${preferences.customProviderUltrafast === true});dot.setEnabled(${preferences.showCustomProviderDot === true});
    projectless.setEnabled(${preferences.defaultProjectlessChat === true});
    ${petSource}
    const plan=${JSON.stringify(plan)};
    if(globalThis.__codexPanelRspack__){globalThis.__codexPanelRspack__.mergeDescriptors?.(plan);return;}
    globalThis.__codexPanelQuotaBootstrapPrepared__=plan.prepared.quota;
    globalThis.__codexPanelUltrafastBootstrapPrepared__=plan.prepared.ultrafast;
    globalThis.__codexPanelDotBootstrapPrepared__=plan.prepared.dot;
    globalThis.__codexPanelRspack__=(${createCodexRspackRuntime})(plan);
    globalThis.__codexPanelRspackTabsV1__=(${createRspackThreadTabsRuntime})();
    quota.prepared=true;
  })();`;
  return { source, prepared: plan.prepared, errors: plan.errors };
}
