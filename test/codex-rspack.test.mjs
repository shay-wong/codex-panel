import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { readCodexRspack, rspackSourceContext } from '../scripts/codex-rspack-source.mjs';
import { buildRspackPlan, createCodexRspackRuntime, installRspackResponse, rewriteRspackEntry } from '../scripts/codex-rspack.mjs';

test('reads current Rspack factories from the installed archive without executing them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-rspack-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Test.app/Contents/Resources');
  await mkdir(resources, { recursive: true });
  const files = {
    'webview/index.html': '<script type="module" src="/assets/123.abc.js"></script>',
    'webview/assets/123.abc.js': 'const load=()=>{};export{load as __webpack_require__};',
    'webview/assets/async/456.def.js': 'export const __rspack_esm_ids=[456];export const __webpack_modules__={abcd(module){throw Error("must not execute");const marker="model_provider";}};',
  };
  const header = { files: {} }; let offset = 0; const bodies = [];
  for (const [name, source] of Object.entries(files)) {
    const body = Buffer.from(source), segments = name.split('/'); let directory = header;
    for (const segment of segments.slice(0, -1)) directory = (directory.files[segment] ??= { files: {} });
    directory.files[segments.at(-1)] = { offset: String(offset), size: body.length };
    bodies.push(body); offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(json.length + 8, 4); prefix.writeUInt32LE(json.length, 12);
  await writeFile(path.join(resources, 'app.asar'), Buffer.concat([prefix, json, ...bodies]));
  const catalog = await readCodexRspack(path.join(root, 'Test.app'));
  assert.equal(catalog.main.urlPath, '/assets/123.abc.js');
  assert.equal(catalog.factories.size, 1);
  assert.match(catalog.factories.get('abcd').source, /^function\(module\)/);
  assert.equal(rspackSourceContext(catalog.factories).findModule('model_provider').id, 'abcd');
});

test('patches initial and lazy factories before native require executes them', async () => {
  const original = 'function(module){module.exports={value:"native"};}';
  const catalog = { factories: new Map([['item', { id: 'item', source: original, chunkIds: [42] }]]) };
  const plan = buildRspackPlan(catalog, { sample: source => source.includes('"native"') ? source.replace('"native"', '"adapted"') : null });
  const calls = [];
  const context = vm.createContext({ console, calls });
  context.plan = plan;
  vm.runInContext(`
    const runtime=(${createCodexRspackRuntime})(plan), table={item:(${original})}, cache={};
    function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;table[id](module,module.exports,load);return module.exports;}
    load.m=runtime.wrapFactories(table,load);
    load.e=async id=>{calls.push(id);load.m.item=(${original});};
    globalThis.runtime=runtime;globalThis.load=load;
  `, context);
  assert.equal(vm.runInContext('load("item").value', context), 'adapted');
  assert.match(context.runtime.findModule('"native"').source, /"native"/);
  vm.runInContext('delete load.m.item;delete cache.item;', context);
  // Only dependency modules requested by a capability are put in the lazy-load map.
  plan.chunks.item = [42];
  assert.equal((await context.runtime.loadModule('item')).value, 'adapted');
  assert.deepEqual(calls, [42]);
});

test('rewrites the registration table while retaining static and lazy module URLs', () => {
  const source = 'let table={};function load(e){return table[e];}load.m=table,load.c={};load.C=()=>{};import*as chunk from"./7.abc.js";const pending=import("../"+load.u(e));const base=import.meta.url;';
  const rewritten = rewriteRspackEntry(source, 'app://-/assets/1.abc.js');
  assert.match(rewritten, /load\.m=table=globalThis\.__codexPanelRspack__\?\.wrapFactories\(table,load\)\?\?table/);
  assert.ok(rewritten.includes('from"app://-/assets/7.abc.js"'));
  assert.ok(rewritten.includes('import(new URL("../"+load.u(e),"app://-/assets/1.abc.js").href)'));
  assert.ok(rewritten.includes('const base="app://-/assets/1.abc.js"'));
});

test('a renderer load before bootstrap registration keeps the native entry working', () => {
  const source = 'let table={item:()=>"native"};function load(id){return table[id]();}load.m=table,load.C=()=>{};load("item");';
  assert.equal(vm.runInNewContext(rewriteRspackEntry(source, 'app://-/assets/1.abc.js')), 'native');
});

test('replaces only the successful main script response and updates the existing handler', async () => {
  const events = new Map(), calls = [];
  const cdp = { on(name, handler) { assert.equal(events.has(name), false); events.set(name, handler); },
    async send(method, value) { calls.push({ method, value }); } };
  const url = 'app://-/assets/1.abc.js';
  await installRspackResponse(cdp, url, 'first');
  await installRspackResponse(cdp, url, 'current');
  const paused = events.get('Fetch.requestPaused');
  await paused({ requestId: 'main', request: { url }, responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Length', value: '100' }, { name: 'Content-Encoding', value: 'gzip' }, { name: 'Content-Type', value: 'text/javascript' }] });
  const replacement = calls.find(call => call.method === 'Fetch.fulfillRequest').value;
  assert.equal(Buffer.from(replacement.body, 'base64').toString(), 'current');
  assert.deepEqual(replacement.responseHeaders, [{ name: 'Content-Type', value: 'text/javascript' }]);
  for (const [requestId, target, status] of [['other', 'app://-/other.js', 200], ['failed', url, 404]]) {
    await paused({ requestId, request: { url: target }, responseStatusCode: status });
    assert.deepEqual(calls.at(-1), { method: 'Fetch.continueRequest', value: { requestId } });
  }
});
