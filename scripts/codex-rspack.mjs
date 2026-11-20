import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { sourceAst, propertyName, propertyValue, unwrap, isFunction, returnValue, unique, applyEdits } from './codex-source-ast.mjs';
import { createCodexProviderQuotaRuntime } from './codex-provider-quota.mjs';
import { readCodexRspack, readCodexRspackIdentity, rspackSourceContext } from './codex-rspack-source.mjs';
import { rewriteRspackQuota } from './codex-rspack-quota.mjs';
import { rewriteRspackDot, rewriteRspackUltrafast, rewriteRspackProjectlessChat } from './codex-rspack-capabilities.mjs';
import { createRspackThreadTabsRuntime, rewriteRspackThreadTabs } from './codex-rspack-tabs.mjs';
import { createPetAnimationRuntime, rewriteRspackPets, installPetAudioBinding } from './codex-rspack-pets.mjs';
import { readBuiltinLumi } from './pet-animations.mjs';
import { buildCodexUpdateBindings } from './codex-update.mjs';
import { buildNativeServiceBindings } from './codex-rspack-pets.mjs';

const transformers = { quota: rewriteRspackQuota, ultrafast: rewriteRspackUltrafast, dot: rewriteRspackDot, tabs: rewriteRspackThreadTabs, queue: rewriteRspackQueue, pets: rewriteRspackPets, projectlessChat: rewriteRspackProjectlessChat };
const responsePatches = new WeakMap();
const preparedPlans = new Map();
const planCacheFormat = 1;

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

export function buildRspackPlan(catalog, adapters = transformers) {
  const selected = new Set();
  let context;
  const prepared = {}, errors = {}, patches = {};
  for (const [feature, rewrite] of Object.entries(adapters)) {
    context = rspackSourceContext(catalog.factories, selected);
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
  context = rspackSourceContext(catalog.factories, selected);
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
  const nativeUpdate = buildCodexUpdateBindings(catalog.factories);
  const nativeServices = buildNativeServiceBindings(context);
  for (const descriptor of Object.values(nativeUpdate)) if (descriptor) selected.add(descriptor.id);
  const chunks = Object.fromEntries([...selected].map(id => [id, catalog.factories.get(id)?.chunkIds ?? []]));
  return { patches, prepared, errors, chunks, nativeUpdate, nativeServices };
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

export async function prepareCodexRspackPlan(appPath, {
  cacheDirectory, adapterRevision, petsOnly = false, report = console.error,
  readCatalog = readCodexRspack, buildPlan = buildRspackPlan,
} = {}) {
  const adapters = petsOnly ? { pets: rewriteRspackPets } : transformers;
  const features = Object.keys(adapters);
  const build = async () => {
    const catalog = await readCatalog(appPath);
    if (!catalog) return null;
    return { main: catalog.main, plan: buildPlan(catalog, adapters) };
  };
  if (!cacheDirectory || typeof adapterRevision !== 'string' || !adapterRevision) return build();
  const identity = await readCodexRspackIdentity(appPath);
  if (!identity) return null;
  const key = createHash('sha256').update(JSON.stringify([planCacheFormat, identity.key, adapterRevision, petsOnly ? 'pets' : 'full'])).digest('hex');
  const directory = path.resolve(cacheDirectory);
  const memoryKey = `${directory}:${key}`;
  if (preparedPlans.has(memoryKey)) return preparedPlans.get(memoryKey);
  const pending = (async () => {
    const file = path.join(directory, `${key}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.format === planCacheFormat && cached.key === key && reusablePlan(cached, features) && cached.digest === planDigest(cached)) {
        return { main: cached.main, plan: cached.plan };
      }
    } catch { /* Missing or damaged static caches are rebuilt from the installed archive. */ }
    const result = await build();
    if (!reusablePlan(result, features)) return result;
    // An updater may replace the archive while its source is being analyzed.
    if ((await readCodexRspackIdentity(appPath))?.key !== identity.key) return result;
    let temporary;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ format: planCacheFormat, key, digest: planDigest(result), ...result }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) { report(`Panel Rspack cache unavailable: ${error.message}`); }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  })();
  preparedPlans.set(memoryKey, pending);
  try {
    const result = await pending;
    if (!reusablePlan(result, features) || (await readCodexRspackIdentity(appPath))?.key !== identity.key) preparedPlans.delete(memoryKey);
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
export async function prepareCodexRspack(cdp, appPath, preferencesFile, report = console.error, { petsOnly = false, petAnimations = [], cacheDirectory, adapterRevision } = {}) {
  const prepared = await prepareCodexRspackPlan(appPath, { petsOnly, cacheDirectory, adapterRevision, report });
  if (!prepared) return null;
  const { main, plan } = prepared;
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
      if(globalThis.__codexPanelRspack__)return;
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
