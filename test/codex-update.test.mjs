import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readCodexUpdateState, readCodexUpdateStatus } from '../scripts/codex-update.mjs';

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
      assert.deepEqual(await readCodexUpdateState(cdp), { ready: true });
      assert.deepEqual(reads, resources.length ? [url] : [entry, runtime, url]);
      reads.length = 0;
      assert.deepEqual(await readCodexUpdateState(cdp), { ready: true });
      assert.deepEqual(reads, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('does not offer installation for idle, offered-only or downloading updates', async () => {
  for (const value of [
    { isUpdateReady: false, lifecycleState: 'idle', downloadedUpdateAppBrand: null },
    { isUpdateReady: true, lifecycleState: 'ready', downloadedUpdateAppBrand: null },
    { isUpdateReady: true, lifecycleState: 'downloading', downloadedUpdateAppBrand: 'codex' },
  ]) assert.deepEqual(await readCodexUpdateState({ send: async () => ({ result: { value } }) }), { ready: false });
});

test('reports latest only after the official quiet check succeeds without blocking readiness', async () => {
  for (const status of ['up_to_date', 'error', 'unavailable']) {
    let finishCheck;
    let checks = 0;
    const cdp = { send: async (_method, params) => {
      if (params.expression.includes('checkForUpdateInformation')) {
        checks++;
        return new Promise(resolve => { finishCheck = resolve; });
      }
      return { result: { value: { isUpdateReady: false, lifecycleState: 'idle', downloadedUpdateAppBrand: null } } };
    } };
    assert.deepEqual(await readCodexUpdateStatus(cdp), { ready: false, message: '正在检查更新…', checking: true });
    finishCheck({ result: { value: { status, installedVersion: '26.1027.61615' } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await readCodexUpdateStatus(cdp), {
      ready: false, checking: false,
      message: `${status === 'up_to_date' ? '当前已是最新版' : '暂时无法检查更新'} · 26.1027.61615`,
    });
    assert.equal(checks, 1);
    assert.equal((await readCodexUpdateStatus(cdp, { force: true })).checking, true);
    assert.equal(checks, 2);
    await readCodexUpdateStatus(cdp, { force: true });
    assert.equal(checks, 2);
    finishCheck({ result: { value: { status: 'up_to_date' } } });

  }
});
