import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareCodexRspack, prepareCodexRspackPlan } from '../scripts/codex-rspack.mjs';
import { readCodexRspack } from '../scripts/codex-rspack-source.mjs';

const run = promisify(execFile);
const loaderUrl = new URL('../scripts/codex-rspack.mjs', import.meta.url).href;
const native = 'function(module){module.exports="native";}';
const entry = 'const table={};function load(id){return table[id];}load.m=table;export{load as __webpack_require__};';
const allFeatures = ['quota', 'ultrafast', 'dot', 'tabs', 'queue', 'pets', 'projectlessChat'];

async function writeArchive(appPath, revision = 'one') {
  const resources = path.join(appPath, 'Contents/Resources');
  await mkdir(resources, { recursive: true });
  const files = {
    'webview/index.html': '<script type="module" src="/assets/main.js"></script>',
    'webview/assets/main.js': entry,
    'webview/chunks/relocated.js': `// ${revision}\nexport const __rspack_esm_ids=[41];export const __webpack_modules__={item:${native}};`,
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
    let read=0,build=0;
    const result=await prepareCodexRspackPlan(${JSON.stringify(f.appPath)},{
      cacheDirectory:${JSON.stringify(f.cacheDirectory)},adapterRevision:${JSON.stringify(f.adapterRevision)},petsOnly:${petsOnly},
      readCatalog:async()=>{read++;${expectedHit ? 'throw Error("catalog must not be read on a disk cache hit")' : `return {main:${JSON.stringify({ urlPath: '/assets/main.js', source: entry })}}`}},
      buildPlan:()=>{build++;${expectedHit ? 'throw Error("plan must not be built on a disk cache hit")' : `return ${JSON.stringify(successfulPlan(petsOnly ? ['pets'] : allFeatures))}`}}
    });console.log(JSON.stringify({read,build,features:Object.keys(result.plan.prepared),main:result.main.urlPath}));`;
  const result = await run(process.execPath, ['--input-type=module', '-e', source], { cwd: path.join(f.root, 'workspace') });
  return JSON.parse(result.stdout);
}

test('same artifact shares one build across concurrent calls, later calls, and a new process', async t => {
  const f = await fixture(t), spy = spies();
  const options = { ...f, ...spy };
  const [first, concurrent] = await Promise.all([prepareCodexRspackPlan(f.appPath, options), prepareCodexRspackPlan(f.appPath, options)]);
  const next = await prepareCodexRspackPlan(f.appPath, options);
  assert.equal(first, concurrent);
  assert.equal(first, next);
  assert.deepEqual(spy.calls, { read: 1, build: 1 });
  const files = await readdir(f.cacheDirectory);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.json'));
  assert.deepEqual(await childCache(f), { read: 0, build: 0, features: allFeatures, main: '/assets/main.js' });
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
