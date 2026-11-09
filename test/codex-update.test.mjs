import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { downloadCodexUpdate, readCodexUpdateChannel, readCodexUpdateState, readCodexUpdateStatus } from '../scripts/codex-update.mjs';

test('reads cached update state when resource timings have been cleared', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panel-update-state-'));
  try {
    const entry = pathToFileURL(path.join(directory, 'index-fixture.js')).href;
    const runtime = new URL('./app-runtime-fixture.js', entry).href;
    const url = new URL('./initialize-app-host-services-fixture.js', entry).href;
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const source = 'const listeners=new Set(),state={isUpdateReady:true,lifecycleState:"ready",downloadedUpdateAppBrand:"codex"};function subscribe(e){return listeners.add(e),state!=null&&e(state),()=>{listeners.delete(e)}}function stateChanged(){}export{subscribe as N}';
    await writeFile(new URL(url), source);
    const sources = new Map([[entry, 'import "./app-runtime-fixture.js";'], [runtime, 'import "./initialize-app-host-services-fixture.js";'], [url, source]]);
    for (const resources of [[{ name: url }], []]) {
      const reads = [];
      const cdp = { send: async (_method, params) => {
        const evaluate = new Function('performance', 'document', 'fetch', 'location', `return ${params.expression}`);
        const value = await evaluate(
          { getEntriesByType: () => resources },
          { querySelectorAll: () => [{ src: entry }] },
          async target => { reads.push(target); assert.ok(sources.has(target)); return { ok: true, text: async () => sources.get(target) }; },
          { href: entry },
        );
        return { result: { value } };
      } };
      assert.deepEqual(await readCodexUpdateState(cdp), { ready: true, downloading: false, progress: null });
      assert.deepEqual(reads, resources.length ? [url] : [entry, runtime, url]);
      reads.length = 0;
      assert.deepEqual(await readCodexUpdateState(cdp), { ready: true, downloading: false, progress: null });
      assert.deepEqual(reads, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('does not offer installation for idle, offered-only or downloading updates', async () => {
  for (const value of [
    { isUpdateReady: false, lifecycleState: 'idle', downloadedUpdateAppBrand: null },
    { isUpdateReady: true, lifecycleState: 'ready', downloadedUpdateAppBrand: null },
    { isUpdateReady: true, lifecycleState: 'downloading', downloadedUpdateAppBrand: 'codex' },
  ]) assert.deepEqual(await readCodexUpdateState({ send: async () => ({ result: { value } }) }), { ready: false, downloading: value.lifecycleState === 'downloading', progress: null });
});

function idleCdp() {
  return { send: async (_method, params) => ({ result: { value: params.expression.includes('appBetaPreferencesByAccountId')
    ? { beta: false } : { isUpdateReady: false, lifecycleState: 'idle', downloadedUpdateAppBrand: null } } }) };
}

function updateChecker(check) {
  return { status: () => null, clearFailure() {}, check };
}

test('reports latest only after the official feed check succeeds without blocking readiness', async () => {
  for (const status of ['up_to_date', 'error', 'unavailable']) {
    let finishCheck;
    let checks = 0;
    const cdp = idleCdp();
    const download = updateChecker(async ({ beta }) => {
      assert.equal(beta, false);
      checks++;
      return new Promise(resolve => { finishCheck = resolve; });
    });
    assert.deepEqual(await readCodexUpdateStatus(cdp, { download }), { ready: false, available: false, downloading: false, message: '正在检查更新…', checking: true });
    await new Promise(resolve => setImmediate(resolve));
    finishCheck({ status, installedVersion: '26.1027.61615' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await readCodexUpdateStatus(cdp, { download }), {
      ready: false, available: false, downloading: false, checking: false,
      message: `${status === 'up_to_date' ? '当前已是最新版' : '暂时无法检查更新'} · 26.1027.61615`,
    });
    assert.equal(checks, 1);
    assert.equal((await readCodexUpdateStatus(cdp, { force: true, download })).checking, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2);
    await readCodexUpdateStatus(cdp, { force: true, download });
    assert.equal(checks, 2);
    finishCheck({ status: 'up_to_date' });
  }
});

test('available update downloads in the background without opening native confirmation', async () => {
  const cdp = idleCdp();
  let state = null;
  let starts = 0;
  const getPlanType = async () => 'plus';
  const download = {
    ...updateChecker(async () => ({ status: 'available', availableVersion: '26.new', availableBuildVersion: '42', installedVersion: '26.old' })),
    status: () => state,
    start(result) {
      starts++;
      assert.equal(result.availableVersion, '26.new');
      assert.equal(result.availableBuildVersion, '42');
      assert.equal(result.getPlanType, getPlanType);
      state = { ready: false, available: true, downloading: true, message: '正在下载更新 · 0%', checking: false };
    },
  };
  await readCodexUpdateStatus(cdp, { download });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await downloadCodexUpdate(cdp, download, { getPlanType })).downloading, true);
  assert.equal((await downloadCodexUpdate(cdp, download)).downloading, true);
  assert.equal(starts, 1);
  state = { ...state, message: '正在下载更新 · 42%' };
  assert.match((await readCodexUpdateStatus(cdp, { download })).message, /42%/);
  state = { ...state, ready: true, downloading: false, message: '更新已下载并验证，可安装并重启' };
  assert.equal((await readCodexUpdateStatus(cdp, { download })).ready, true);
});

test('retry after reconnect refreshes the offer when the old check is no longer available', async () => {
  let state = { ready: false, available: true, downloading: false, checking: false, message: '上次下载失败' };
  const download = { ...updateChecker(async () => ({ status: 'available', availableVersion: '26.new', availableBuildVersion: '42' })),
    status: () => state, clearFailure() { state = null; }, start() { assert.fail('must check before downloading'); } };
  const cdp = idleCdp();
  assert.equal((await downloadCodexUpdate(cdp, download)).checking, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readCodexUpdateStatus(cdp, { download })).available, true);
});

test('manual checking refreshes a cached result without repeating checks on every poll', async () => {
  let checks = 0;
  let result = { status: 'up_to_date', installedVersion: '26.1027.61615' };
  const cdp = idleCdp();
  const download = updateChecker(async () => { checks++; return result; });
  await readCodexUpdateStatus(cdp, { download });
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 5; index++) {
    const status = await readCodexUpdateStatus(cdp, { download });
    assert.equal(status.checking, false);
    assert.match(status.message, /当前已是最新版/);
  }
  assert.equal(checks, 1);
  result = { status: 'available', availableVersion: '26.new', availableBuildVersion: '42' };
  assert.equal((await readCodexUpdateStatus(cdp, { force: true, download })).checking, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readCodexUpdateStatus(cdp, { download })).available, true);
  assert.equal(checks, 2);
});

test('a stalled check times out and a late reply cannot replace the retry result', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const replies = [];
  const cdp = idleCdp();
  const download = updateChecker(() => new Promise(resolve => replies.push(resolve)));
  assert.equal((await readCodexUpdateStatus(cdp, { download })).checking, true);
  await new Promise(resolve => setImmediate(resolve));
  now = 35_000;
  assert.equal((await readCodexUpdateStatus(cdp, { download })).checking, false);
  assert.match((await readCodexUpdateStatus(cdp, { download })).message, /超时，请重试/);
  assert.equal(replies.length, 1);
  assert.equal((await readCodexUpdateStatus(cdp, { force: true, download })).checking, true);
  await new Promise(resolve => setImmediate(resolve));
  replies[1]({ status: 'available', availableVersion: '26.new' });
  replies[0]({ status: 'up_to_date' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readCodexUpdateStatus(cdp, { download })).available, true);
});

async function rspackFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panel-rspack-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '84120.fixture.js');
  const source = `
    export let channelState = {enabled: false, isLoading: false};
    export function setChannel(value) { channelState = value; }
    export let nativeState = {isUpdateReady:false,lifecycleState:'idle',downloadedUpdateAppBrand:null,downloadProgressPercent:null};
    const factories = {
      changedState(module, exports) {
        const listeners = new Set(); let state = nativeState;
        const bridge = {async getRestartBlockers(){return []}, stateChanged(value){state=value; for(const listener of listeners)listener(value)}};
        Object.assign(exports, {N:function(callback){return listeners.add(callback),state!=null&&callback(state),()=>{listeners.delete(callback)}}, bridge});
      },
      betaSettings(module, exports) {
        void 'appBetaPreferencesByAccountId desktop_app_beta_policy';
        Object.assign(exports, {H: {scope: {__scopeBrand: 'AppScope', id: Symbol()}, resolve() { return 'beta'; }}});
      }
    };
    const cache = {};
    function load(id){if(!cache[id]){const module={exports:{}};factories[id](module,module.exports,load);cache[id]=module.exports;}return cache[id];}
    load.m=factories;
    export {load as __webpack_require__};
  `;
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(file, source);
  const entry = pathToFileURL(file).href;
  const native = await import(entry);
  const page = {};
  const setting = native.__webpack_require__('betaSettings').H;
  const node = {token: setting.scope, store: {get: () => native.channelState}};
  const anchor = {__reactFiber$fixture: {return: {memoizedProps: {value: new Map([[setting.scope.id, node]])}}}};
  const reads = [];
  const cdp = { send: async (_method, params) => {
    const evaluate = new Function('performance', 'document', 'fetch', 'location', 'globalThis', `return ${params.expression}`);
    const value = await evaluate(
      {getEntriesByType:()=>[]},
      {querySelectorAll:selector=>selector.startsWith('nav[')?[anchor]:[{src:entry}]},
      async url => { reads.push(url); assert.equal(url,entry); return {ok:true,text:async()=>source}; },
      {href:entry},page,
    );
    return {result:{value}};
  } };
  return {native,page,cdp,reads};
}

test('Rspack reads native update state without a check and reuses the current document registry', async t => {
  const fixture = await rspackFixture(t);
  assert.deepEqual(await readCodexUpdateState(fixture.cdp), {ready:false,downloading:false,progress:null});
  fixture.native.__webpack_require__('changedState').bridge.stateChanged({isUpdateReady:true,lifecycleState:'downloading',downloadedUpdateAppBrand:null,downloadProgressPercent:42});
  assert.deepEqual(await readCodexUpdateState(fixture.cdp), {ready:false,downloading:true,progress:42});
  fixture.native.__webpack_require__('changedState').bridge.stateChanged({isUpdateReady:true,lifecycleState:'ready',downloadedUpdateAppBrand:'codex',downloadProgressPercent:100});
  assert.deepEqual(await readCodexUpdateState(fixture.cdp), {ready:true,downloading:false,progress:100});
  assert.equal(fixture.reads.length,1);
});

test('reads the effective native update channel without invoking the updater', async t => {
  const fixture = await rspackFixture(t);
  const load = fixture.native.__webpack_require__;
  fixture.page.__codexPanelRspack__ = {require:load,findModule(markers){
    const matches = Object.entries(load.m).filter(([,factory])=>markers.every(marker=>factory.toString().includes(marker)));
    return matches.length===1 ? {id:matches[0][0],source:matches[0][1].toString()} : null;
  }};
  assert.deepEqual(await readCodexUpdateChannel(fixture.cdp), {beta:false});
  fixture.native.setChannel({enabled:true,isLoading:false,policy:'required'});
  assert.deepEqual(await readCodexUpdateChannel(fixture.cdp), {beta:true});
  fixture.native.setChannel({enabled:false,isLoading:true});
  await assert.rejects(readCodexUpdateChannel(fixture.cdp), /尚未就绪/);
  assert.equal(fixture.reads.length,0);
});
