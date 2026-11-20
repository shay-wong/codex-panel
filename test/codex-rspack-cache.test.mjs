import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import vm from 'node:vm';
import { applyCodexRspackFeature, buildCodexRspackInWorker, prepareCodexRspack, prepareCodexRspackPlan } from '../scripts/codex-rspack.mjs';
import { readCodexRspack } from '../scripts/codex-rspack-source.mjs';

const run = promisify(execFile);
const loaderUrl = new URL('../scripts/codex-rspack.mjs', import.meta.url).href;
const native = 'function(module){module.exports="native";}';
const entry = 'const table={};function load(id){return table[id];}load.m=table;export{load as __webpack_require__};';
const allFeatures = ['quota', 'ultrafast', 'dot', 'tabs', 'queue', 'pets', 'projectlessChat'];

async function writeArchive(appPath, revision = 'one', factoryCount = 1, factorySource = native) {
  const resources = path.join(appPath, 'Contents/Resources');
  await mkdir(resources, { recursive: true });
  const files = {
    'webview/index.html': '<script type="module" src="/assets/main.js"></script>',
    'webview/assets/main.js': entry,
    'webview/chunks/relocated.js': `// ${revision}\nexport const __rspack_esm_ids=[41];export const __webpack_modules__={${factoryCount === 1 ? `item:${factorySource}` : Array.from({ length: factoryCount }, (_, index) => `"item-${index}":${factorySource.replace('{', `{/* ${index} */`)}`).join(',')}};`,
  };
  const header = { files: {} }, bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text), parts = name.split('/');
    let directory = header;
    for (const name of parts.slice(0, -1)) directory = directory.files[name] ??= { files: {} };
    directory.files[parts.at(-1)] = { offset: String(offset), size: body.length };
    bodies.push(body); offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(json.length + 8, 4); prefix.writeUInt32LE(json.length, 12);
  await writeFile(path.join(resources, 'app.asar'), Buffer.concat([prefix, json, ...bodies]));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-rspack-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'fixtures/Codex.app');
  const cacheDirectory = path.join(root, 'data/codex-adapters');
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  await writeArchive(appPath);
  return { root, appPath, cacheDirectory, adapterRevision: 'adapter-one' };
}

function successfulPlan(features) {
  return {
    patches: { item: [{ before: native, after: native.replace('"native"', '"adapted"'), features }] },
    prepared: Object.fromEntries(features.map(feature => [feature, true])), errors: {},
    chunks: { item: [41] }, nativeUpdate: {}, nativeServices: {},
  };
}

function spies() {
  const calls = { read: 0, build: 0 };
  return {
    calls,
    readCatalog: async app => { calls.read++; return readCodexRspack(app); },
    buildPlan: (catalog, adapters) => {
      calls.build++;
      assert.equal(catalog.factories.get('item').source, native);
      return successfulPlan(Object.keys(adapters));
    },
  };
}

async function childCache(f, { expectedHit = true, petsOnly = false } = {}) {
  const source = `import {prepareCodexRspackPlan} from ${JSON.stringify(loaderUrl)};
    let read=0,build=0; const ready=[];
    const result=await prepareCodexRspackPlan(${JSON.stringify(f.appPath)},{
      cacheDirectory:${JSON.stringify(f.cacheDirectory)},adapterRevision:${JSON.stringify(f.adapterRevision)},petsOnly:${petsOnly},
      onFeaturePrepared:({feature})=>ready.push(feature),
      readCatalog:async()=>{read++;${expectedHit ? 'throw Error("catalog must not be read on a disk cache hit")' : `return {main:${JSON.stringify({ urlPath: '/assets/main.js', source: entry })}}`}},
      buildPlan:()=>{build++;${expectedHit ? 'throw Error("plan must not be built on a disk cache hit")' : `return ${JSON.stringify(successfulPlan(petsOnly ? ['pets'] : allFeatures))}`}}
    });console.log(JSON.stringify({read,build,ready,features:Object.keys(result.plan.prepared),main:result.main.urlPath}));`;
  const result = await run(process.execPath, ['--input-type=module', '-e', source], { cwd: path.join(f.root, 'workspace') });
  return JSON.parse(result.stdout);
}

test('same artifact shares one build across concurrent calls, later calls, and a new process', async t => {
  const f = await fixture(t), spy = spies();
  const options = { ...f, ...spy };
  const notifications = [[], [], []];
  const prepare = index => prepareCodexRspackPlan(f.appPath, { ...options,
    onFeaturePrepared: ({ feature }) => notifications[index].push(feature),
  });
  const [first, concurrent] = await Promise.all([prepare(0), prepare(1)]);
  const next = await prepare(2);
  const ready = ['nativeUpdate', ...allFeatures];
  assert.deepEqual(notifications, [ready, ready, ready]);
  assert.equal(first, concurrent);
  assert.equal(first, next);
  assert.deepEqual(spy.calls, { read: 1, build: 1 });
  const files = await readdir(f.cacheDirectory);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.json'));
  assert.deepEqual(await childCache(f), { read: 0, build: 0, ready, features: allFeatures, main: '/assets/main.js' });
});

test('startup reports a pending analysis immediately and reports cached preparation without analyzing again', async t => {
  const f = await fixture(t), spy = spies(), messages = [];
  let release, reached;
  const readStarted = new Promise(resolve => { reached = resolve; });
  const pendingRead = new Promise(resolve => { release = resolve; });
  const pending = prepareCodexRspackPlan(f.appPath, {
    ...f, ...spy, onProgress: message => messages.push(message),
    readCatalog: async app => { reached(); await pendingRead; return spy.readCatalog(app); },
  });
  await readStarted;
  assert.deepEqual(messages.map(progress => progress.phase), ['cache', 'read']);
  assert.equal(spy.calls.build, 0, 'the progress is visible before analysis completes');
  release();
  await pending;
  messages.length = 0;
  const cdp = { on() {}, async send(method) {
    if (method === 'Runtime.evaluate') {
      assert.deepEqual(messages.map(progress => progress.phase), ['cache', 'prepared']);
      return { result: { value: ['app://-/assets/main.js'] } };
    }
    return {};
  } };
  await prepareCodexRspack(cdp, f.appPath, null, () => {}, { ...f, onProgress: message => messages.push(message) });
  assert.deepEqual(messages.map(progress => progress.phase), ['cache', 'prepared']);
  assert.deepEqual(spy.calls, { read: 1, build: 1 });
});

test('native features analyze concurrently in two workers and publish results before final composition', async t => {
  const f = await fixture(t);
  await writeArchive(f.appPath, 'worker', 8_000, native.replace('"native"', '"native data-codex-pet-state data-codex-composer-root"'));
  const progress = [], completed = [], active = new Set();
  let analyzing = false, heartbeats = 0, maximumActive = 0;
  const timer = setInterval(() => { if (analyzing) heartbeats++; }, 1);
  t.after(() => clearInterval(timer));
  const result = await buildCodexRspackInWorker(f.appPath, { onProgress: item => {
    progress.push(item);
    if (item.phase === 'adapt') {
      analyzing = true;
      active.add(item.feature);
      maximumActive = Math.max(maximumActive, active.size);
    }
    if (item.phase === 'compose') assert.equal(completed.length, allFeatures.length + 1);
  }, onFeaturePrepared: ({ feature }) => { completed.push(feature); active.delete(feature); } });
  clearInterval(timer);
  assert.ok(heartbeats > 0, 'main-loop heartbeats continue during native module analysis');
  assert.ok(progress.some(item => item.phase === 'read' && item.asset === 'webview/chunks/relocated.js'));
  const features = [...new Set(progress.filter(item => item.phase === 'adapt').map(item => item.feature))];
  assert.deepEqual(features.toSorted(), ['nativeUpdate', ...allFeatures].toSorted());
  assert.equal(maximumActive, 2, 'independent feature analysis overlaps with at most two workers');
  assert.deepEqual(completed.toSorted(), ['nativeUpdate', ...allFeatures].toSorted());
  assert.ok(progress.some(item => item.phase === 'adapt' && item.moduleId === 'item-0' && item.completed === 0));
  assert.ok(progress.some(item => item.phase === 'compose' && item.completed === 0 && item.total === 0));
  assert.deepEqual(result.plan.prepared, Object.fromEntries(allFeatures.map(feature => [feature, false])));
});

test('one ambiguous native descriptor still lets the other features finish', async t => {
  const f = await fixture(t), ready = [];
  const service = 'function(module,exports,load){let current;function publish(value){current=value}load.d(exports,{setAppServices:()=>publish,appServices:()=>current});}';
  await writeArchive(f.appPath, 'ambiguous-service', 2, service);
  const { plan } = await buildCodexRspackInWorker(f.appPath, { onFeaturePrepared: ({feature}) => ready.push(feature) });
  assert.match(plan.errors.pets, /ambiguous/);
  assert.deepEqual(ready.toSorted(), ['nativeUpdate', ...allFeatures].toSorted());
});

test('publishing native descriptors reuses loaded exports and leaves UI factories alone until reload', async () => {
  const loads = [], chunks = [], cache = { desktop: { services: 'available' } };
  const require = id => { loads.push(id); return cache[id]; };
  require.m = { desktop() { throw Error('cached factory must not execute again'); } };
  require.e = async chunk => {
    chunks.push(chunk);
    require.m.update = () => {};
    cache.update = { subscribe: () => 'subscribed' };
  };
  const context = vm.createContext({ __codexPanelUpdateRequire__: require });
  let evaluations = 0;
  const cdp = { async send(method, { expression }) {
    assert.equal(method, 'Runtime.evaluate');
    evaluations++;
    return { result: { value: Array.from(await vm.runInContext(expression, context)) } };
  } };
  const plan = successfulPlan(['pets']);
  assert.deepEqual(await applyCodexRspackFeature(cdp, plan), []);
  assert.equal(evaluations, 0);
  const desktop = { id: 'desktop', exportName: 'services' };
  const update = { id: 'update', name: 'subscribe' };
  assert.deepEqual(await applyCodexRspackFeature(cdp, { ...plan, nativeServices: { desktopServices: desktop } }), ['nativeServices']);
  const runtime = context.__codexPanelRspack__;
  assert.deepEqual(await applyCodexRspackFeature(cdp, { ...plan, chunks: { update: [19] }, nativeUpdate: { subscription: update } }), ['nativeUpdate']);
  assert.equal(runtime, context.__codexPanelRspack__);
  assert.deepEqual(loads, []);
  assert.deepEqual(chunks, []);
  const service = runtime.nativeServices.desktopServices;
  assert.equal((await runtime.loadModule(service.id))[service.exportName], 'available');
  const subscription = runtime.nativeUpdate.subscription;
  assert.equal((await runtime.loadModule(subscription.id))[subscription.name](), 'subscribed');
  assert.deepEqual(loads, ['desktop', 'update']);
  assert.deepEqual(chunks, [19]);
});

test('archive identity and adapter revision each invalidate the static cache', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  await writeArchive(f.appPath, 'two-with-new-bytes');
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const updated = { ...f, adapterRevision: 'adapter-two' };
  await prepareCodexRspackPlan(f.appPath, { ...updated, ...spy });
  assert.deepEqual(spy.calls, { read: 3, build: 3 });
  assert.equal((await readdir(f.cacheDirectory)).length, 3);
  assert.equal((await childCache(updated)).build, 0);
});

test('damaged disk cache rebuilds atomically and is reusable by the next process', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const [file] = await readdir(f.cacheDirectory);
  await writeFile(path.join(f.cacheDirectory, file), '{invalid');
  assert.equal((await childCache(f, { expectedHit: false })).build, 1);
  assert.equal((await childCache(f)).read, 0);
  const valid = await readFile(path.join(f.cacheDirectory, file), 'utf8');
  await writeFile(path.join(f.cacheDirectory, file), valid.replace('adapted', 'damaged'));
  assert.equal((await childCache(f, { expectedHit: false })).build, 1, 'valid JSON with corrupted patch bytes must rebuild');
  assert.equal((await childCache(f)).build, 0);
  assert.deepEqual(await readdir(f.cacheDirectory), [file]);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDirectory, file), 'utf8')).format, 1);
});

test('full and pets-only caches stay separate and failed plans are retried', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const pets = await prepareCodexRspackPlan(f.appPath, { ...f, ...spy, petsOnly: true });
  assert.deepEqual(Object.keys(pets.plan.prepared), ['pets']);
  assert.equal(spy.calls.build, 2);
  assert.deepEqual((await childCache(f, { petsOnly: true })).features, ['pets']);
  const broken = { ...f, adapterRevision: 'broken-adapter' };
  const failed = () => ({ ...successfulPlan(allFeatures), prepared: { quota: false }, errors: { quota: 'not prepared' } });
  let failures = 0;
  for (let i = 0; i < 2; i++) await prepareCodexRspackPlan(f.appPath, { ...broken, readCatalog: spy.readCatalog, buildPlan: () => { failures++; return failed(); } });
  assert.equal(failures, 2);
  assert.equal((await readdir(f.cacheDirectory)).length, 2);
});

test('a disk hit still reads current preferences and uses each renderer URL', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const preferences = path.join(f.root, 'data/preferences.json');
  const calls = [];
  const cdp = host => ({ on() {}, async send(method, params) {
    calls.push({ host, method, params });
    if (method === 'Runtime.evaluate') return { result: { value: [`${host}/assets/main.js`] } };
    return {};
  } });
  await writeFile(preferences, JSON.stringify({ customProviderQuotaFix: false }));
  const first = await prepareCodexRspack(cdp('app://first'), f.appPath, preferences, () => {}, f);
  await writeFile(preferences, JSON.stringify({ customProviderQuotaFix: true }));
  const second = await prepareCodexRspack(cdp('app://second'), f.appPath, preferences, () => {}, f);
  assert.ok(first.source.includes('quota.setEnabled(false)'));
  assert.ok(second.source.includes('quota.setEnabled(true)'));
  assert.deepEqual(calls.filter(call => call.method === 'Fetch.enable').map(call => call.params.patterns[0].urlPattern), ['app://first/assets/main.js', 'app://second/assets/main.js']);
  assert.deepEqual(spy.calls, { read: 1, build: 1 });
  const [file] = await readdir(f.cacheDirectory);
  const persisted = await readFile(path.join(f.cacheDirectory, file), 'utf8');
  assert.equal(persisted.includes('customProviderQuotaFix'), false);
  assert.equal(persisted.includes('app://first'), false);
  assert.equal(persisted.includes('app://second'), false);
});
