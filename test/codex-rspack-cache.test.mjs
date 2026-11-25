import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import vm from 'node:vm';
import { applyCodexRspackFeature, buildCodexRspackInWorker, prepareCodexRspack, prepareCodexRspackPlan } from '../scripts/codex-rspack.mjs';
import { readCodexRspack, readCodexRspackIdentity } from '../scripts/codex-rspack-source.mjs';

const run = promisify(execFile);
const loaderUrl = new URL('../scripts/codex-rspack.mjs', import.meta.url).href;
const native = 'function(module){module.exports="native";}';
const entry = 'const table={};function load(id){return table[id];}load.m=table;export{load as __webpack_require__};';
const allFeatures = ['quota', 'ultrafast', 'dot', 'tabs', 'queue', 'pets', 'projectlessChat', 'repositoryBranchPrefix', 'settingsPresentation'];
const allJobs = ['nativeUpdate', 'nativeServices', ...allFeatures];
const revisions = { catalog: 'catalog-one', compose: 'compose-one', features: Object.fromEntries(allJobs.map(feature => [feature, 'one'])) };

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
  return { root, appPath, cacheDirectory, revisions };
}

async function planFiles(directory) {
  return (await readdir(directory)).filter(name => name.endsWith('.json'));
}

function successfulFeature(feature) {
  const plan = successfulPlan(allFeatures.includes(feature) ? [feature] : []);
  if (allFeatures.includes(feature)) plan.patches = { [feature]: [{ before: native, after: native.replace('"native"', '"adapted"'), features: [feature] }] };
  if (feature === 'nativeUpdate') { plan.patches = {}; plan.nativeUpdate = { subscription: { id: 'item', name: 'update' } }; }
  if (feature === 'nativeServices') { plan.patches = {}; plan.nativeServices = { desktopServices: { id: 'item', exportName: 'services' } }; }
  return plan;
}

function successfulPlan(features) {
  return {
    patches: { item: [{ before: native, after: native.replace('"native"', '"adapted"'), features }] },
    prepared: Object.fromEntries(features.map(feature => [feature, true])), errors: {},
    chunks: { item: [41] }, nativeUpdate: {}, nativeServices: {},
  };
}

function fixtureCompose(_catalog, plans) {
  return { patches: Object.assign({}, ...plans.map(plan => plan.patches)), prepared: Object.assign({}, ...plans.map(plan => plan.prepared)),
    errors: Object.assign({}, ...plans.map(plan => plan.errors)), chunks: Object.assign({}, ...plans.map(plan => plan.chunks)),
    nativeUpdate: Object.assign({}, ...plans.map(plan => plan.nativeUpdate)), nativeServices: Object.assign({}, ...plans.map(plan => plan.nativeServices)) };
}

function spies() {
  const calls = { read: 0, build: 0, features: [] };
  return {
    calls,
    report() {},
    composePlan: fixtureCompose,
    readCatalog: async app => { calls.read++; return readCodexRspack(app); },
    buildFeaturePlan: (catalog, feature) => {
      calls.build++; calls.features.push(feature);
      assert.equal(catalog.factories.get('item').source, native);
      return successfulFeature(feature);
    },
  };
}

async function childCache(f, { expectedHit = true, petsOnly = false } = {}) {
  const source = `import {prepareCodexRspackPlan} from ${JSON.stringify(loaderUrl)};
    import {readCodexRspack} from ${JSON.stringify(new URL('../scripts/codex-rspack-source.mjs', import.meta.url).href)};
    const composePlan=${fixtureCompose};
    let read=0,build=0; const ready=[];
    const result=await prepareCodexRspackPlan(${JSON.stringify(f.appPath)},{
      cacheDirectory:${JSON.stringify(f.cacheDirectory)},revisions:${JSON.stringify(f.revisions)},petsOnly:${petsOnly},report(){},composePlan,
      onFeaturePrepared:({feature})=>ready.push(feature),
      readCatalog:async(app)=>{read++;${expectedHit ? 'throw Error("catalog must not be read on a disk cache hit")' : 'return readCodexRspack(app)'}},
      buildFeaturePlan:()=>{build++;throw Error("cached feature plans must be reused")}
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
  const ready = allJobs;
  assert.deepEqual(notifications.map(items => items.toSorted()), [ready, ready, ready].map(items => items.toSorted()));
  assert.equal(first, concurrent);
  assert.equal(first, next);
  assert.equal(spy.calls.read, 1);
  assert.equal(spy.calls.build, allJobs.length);
  const files = await planFiles(f.cacheDirectory);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.json'));
  assert.deepEqual(await childCache(f), { read: 0, build: 0, ready, features: allFeatures.toSorted((a, b) => Number(b === 'pets') - Number(a === 'pets')), main: '/assets/main.js' });
});

test('unchanged archive contents reuse adaptation after metadata changes, copies, and moves', async t => {
  const f = await fixture(t), spy = spies();
  const archive = path.join(f.appPath, 'Contents/Resources/app.asar');
  const original = await readCodexRspackIdentity(f.appPath);
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  await chmod(archive, 0o640);
  await utimes(archive, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.deepEqual(await readCodexRspackIdentity(f.appPath), original);
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const copy = path.join(f.root, 'fixtures/Copy.app'), moved = path.join(f.root, 'fixtures/Moved.app');
  await cp(f.appPath, copy, { recursive: true });
  assert.equal((await readCodexRspackIdentity(copy)).key, original.key);
  await prepareCodexRspackPlan(copy, { ...f, ...spy });
  await rename(copy, moved);
  assert.equal((await readCodexRspackIdentity(moved)).key, original.key);
  await prepareCodexRspackPlan(moved, { ...f, ...spy });
  assert.equal(spy.calls.read, 1);
  assert.equal(spy.calls.build, allJobs.length);
  assert.equal((await childCache({ ...f, appPath: moved })).read, 0);
});

test('same-size archive content changes invalidate adaptation even with the original modification time', async t => {
  const f = await fixture(t), spy = spies();
  const archive = path.join(f.appPath, 'Contents/Resources/app.asar');
  const time = new Date('2020-01-01');
  await utimes(archive, time, time);
  const original = await readCodexRspackIdentity(f.appPath);
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  await writeArchive(f.appPath, 'two');
  await utimes(archive, time, time);
  const changed = await readCodexRspackIdentity(f.appPath);
  assert.equal(changed.size, original.size);
  assert.equal((await stat(archive)).mtimeMs, time.getTime());
  assert.notEqual(changed.key, original.key);
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  assert.equal(spy.calls.read, 2);
  assert.equal(spy.calls.build, allJobs.length * 2);
  assert.equal((await childCache(f)).build, 0);
});

test('failed or interrupted archive reads never retain a reusable digest', async () => {
  const source = await readFile(new URL('../scripts/codex-rspack-source.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function readCodexRspackIdentity(');
  const end = source.indexOf('\nexport function shareRspackCatalog(', start);
  let failure = 'stream', version = 0n, reads = 0;
  const readIdentity = vm.runInNewContext(`const archiveDigests = new Map(); ${source.slice(start, end).replace('export ', '')}; readCodexRspackIdentity`, {
    path, createHash, realpath: async value => value,
    stat: async () => ({ size: 7n, mtimeNs: 1n, ctimeNs: version, dev: 1n, ino: 1n }),
    createReadStream: async function* () {
      reads++;
      if (failure === 'stream') throw new Error('read failed');
      yield Buffer.from('archive');
      if (failure === 'change') version++;
    },
  });
  await assert.rejects(readIdentity('/isolated/Codex.app'), /read failed/);
  failure = 'change';
  await assert.rejects(readIdentity('/isolated/Codex.app'), /读取期间发生变化/);
  failure = '';
  const result = await readIdentity('/isolated/Codex.app');
  assert.equal(result.key, createHash('sha256').update('archive').digest('hex'));
  assert.equal((await readIdentity('/isolated/Codex.app')).key, result.key);
  assert.equal(reads, 3, 'retry failed reads and reuse the stable successful digest');
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
  assert.equal(spy.calls.read, 1);
  assert.equal(spy.calls.build, allJobs.length);
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
    if (item.phase === 'compose') assert.equal(completed.length, allFeatures.length + 2);
  }, onFeaturePrepared: ({ feature }) => { completed.push(feature); active.delete(feature); } });
  clearInterval(timer);
  assert.ok(heartbeats > 0, 'main-loop heartbeats continue during native module analysis');
  assert.ok(progress.some(item => item.phase === 'read' && item.asset === 'webview/chunks/relocated.js'));
  const features = [...new Set(progress.filter(item => item.phase === 'adapt').map(item => item.feature))];
  assert.deepEqual(features.toSorted(), allJobs.toSorted());
  assert.equal(maximumActive, 2, 'independent feature analysis overlaps with at most two workers');
  const ratios = new Map(allJobs.map(feature => [feature, 0]));
  let lastPercent = 0;
  for (const item of progress.filter(item => item.phase === 'adapt')) {
    ratios.set(item.feature, item.total > 0 ? item.completed / item.total : 1);
    const percent = [...ratios.values()].reduce((sum, ratio) => sum + ratio, 0) / ratios.size * 100;
    assert.ok(Math.abs(item.percent - percent) < 1e-10, 'parallel progress includes completed, active and queued features');
    assert.ok(item.percent >= lastPercent, 'another worker starting does not reset the progress bar');
    lastPercent = item.percent;
  }
  assert.equal(lastPercent, 100);
  assert.deepEqual(completed.toSorted(), allJobs.toSorted());
  assert.ok(progress.some(item => item.phase === 'adapt' && item.moduleId === 'item-0' && item.completed === 0));
  assert.ok(progress.some(item => item.phase === 'compose' && item.completed === 0 && item.total === 0));
  assert.deepEqual(result.plan.prepared, Object.fromEntries(allFeatures.map(feature => [feature, false])));
});

test('one ambiguous native descriptor still lets the other features finish', async t => {
  const f = await fixture(t), ready = [];
  const service = 'function(module,exports,load){let current;function publish(value){current=value}load.d(exports,{setAppServices:()=>publish,appServices:()=>current});}';
  await writeArchive(f.appPath, 'ambiguous-service', 2, service);
  const { plan } = await buildCodexRspackInWorker(f.appPath, { onFeaturePrepared: ({feature}) => ready.push(feature) });
  assert.match(plan.errors.nativeServices, /ambiguous/);
  assert.deepEqual(ready.toSorted(), allJobs.toSorted());
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

test('archive changes invalidate all modules while one adapter revision rebuilds only its own module', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  await writeArchive(f.appPath, 'two-with-new-bytes');
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const updated = { ...f, revisions: { ...revisions, features: { ...revisions.features, dot: 'two' } } };
  spy.calls.features.length = 0;
  await prepareCodexRspackPlan(f.appPath, { ...updated, ...spy });
  assert.equal(spy.calls.read, 3);
  assert.equal(spy.calls.build, allJobs.length * 2 + 1);
  assert.deepEqual(spy.calls.features, ['dot']);
  assert.equal((await planFiles(f.cacheDirectory)).length, 3);
  assert.equal((await childCache(updated)).build, 0);
});

test('damaged disk cache rebuilds atomically and is reusable by the next process', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const [file] = await planFiles(f.cacheDirectory);
  await writeFile(path.join(f.cacheDirectory, file), '{invalid');
  assert.equal((await childCache(f, { expectedHit: false })).build, 0);
  assert.equal((await childCache(f)).read, 0);
  const valid = await readFile(path.join(f.cacheDirectory, file), 'utf8');
  await writeFile(path.join(f.cacheDirectory, file), valid.replace('adapted', 'damaged'));
  assert.equal((await childCache(f, { expectedHit: false })).build, 0, 'damaged composition reuses successful module plans');
  assert.equal((await childCache(f)).build, 0);
  assert.deepEqual(await planFiles(f.cacheDirectory), [file]);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDirectory, file), 'utf8')).format, 2);
});

test('full and pets-only share successful module plans and retry only failed modules', async t => {
  const f = await fixture(t), spy = spies();
  await prepareCodexRspackPlan(f.appPath, { ...f, ...spy });
  const pets = await prepareCodexRspackPlan(f.appPath, { ...f, ...spy, petsOnly: true });
  assert.deepEqual(Object.keys(pets.plan.prepared), ['pets']);
  assert.equal(spy.calls.build, allJobs.length);
  assert.deepEqual((await childCache(f, { petsOnly: true })).features, ['pets']);
  const broken = { ...f, revisions: { ...revisions, features: { ...revisions.features, quota: 'broken' } } };
  let failures = 0;
  spy.calls.features.length = 0;
  const failed = (catalog, feature) => {
    if (feature !== 'quota') return spy.buildFeaturePlan(catalog, feature);
    failures++;
    return { ...successfulFeature(feature), prepared: { quota: false }, errors: { quota: 'not prepared' } };
  };
  for (let i = 0; i < 2; i++) await prepareCodexRspackPlan(f.appPath, { ...broken, ...spy, buildFeaturePlan: failed });
  assert.equal(failures, 2);
  assert.deepEqual(spy.calls.features, []);
  assert.equal((await planFiles(f.cacheDirectory)).length, 2);
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
  assert.equal(spy.calls.read, 1);
  assert.equal(spy.calls.build, allJobs.length);
  const [file] = await planFiles(f.cacheDirectory);
  const persisted = await readFile(path.join(f.cacheDirectory, file), 'utf8');
  assert.equal(persisted.includes('customProviderQuotaFix'), false);
  assert.equal(persisted.includes('app://first'), false);
  assert.equal(persisted.includes('app://second'), false);
});
