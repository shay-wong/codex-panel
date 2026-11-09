import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCodexUpdateDownload, selectCodexUpdateArchive } from '../scripts/codex-update-download.mjs';
import { downloadCodexUpdate, readCodexUpdateStatus } from '../scripts/codex-update.mjs';

const target = { availableVersion: '26.1029.61003', availableBuildVersion: '24614' };
const execute = promisify(execFile);
const appcast = `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
  <item><sparkle:version>24614</sparkle:version><sparkle:shortVersionString>26.1029.61003</sparkle:shortVersionString><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion></item>
  <item><sparkle:version>99999</sparkle:version><sparkle:shortVersionString>26.1105.10000</sparkle:shortVersionString><sparkle:hardwareRequirements>x64</sparkle:hardwareRequirements></item>
  <item><sparkle:version>99998</sparkle:version><sparkle:shortVersionString>26.1105.10000</sparkle:shortVersionString><sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion></item>
</channel></rss>`;

test('selects the exact target delta from the installed build without falling back to a complete ZIP', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panel-appcast-'));
  try {
    const file = path.join(directory, 'appcast.xml');
    const signature = Buffer.alloc(64).toString('base64');
    const full = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.zip';
    const delta = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-24141-24614.delta';
    await writeFile(file, `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
      <item><sparkle:version>25000</sparkle:version><sparkle:shortVersionString>26.1105.10000</sparkle:shortVersionString><enclosure url="${full}" length="99" sparkle:edSignature="${signature}"/></item>
      <item><sparkle:version>${target.availableBuildVersion}</sparkle:version><sparkle:shortVersionString>${target.availableVersion}</sparkle:shortVersionString><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <sparkle:deltas><enclosure url="https://persistent.oaistatic.com/wrong.delta" length="1" sparkle:deltaFrom="24000" sparkle:edSignature="${signature}"/>
      <enclosure url="${delta}" length="55" sparkle:deltaFrom="24141" sparkle:edSignature="${signature}" sparkle:deltaFromSparkleExecutableSize="123" sparkle:deltaFromSparkleLocales="en,zh-Hans"/></sparkle:deltas>
      <enclosure url="${full}" length="99" sparkle:edSignature="${signature}"/></item>
    </channel></rss>`);
    assert.deepEqual(await selectCodexUpdateArchive(file, target, 'arm64', '24141'), {
      url: delta, length: 55, signature, deltaFrom: '24141', deltaFromSparkleExecutableSize: '123', deltaFromSparkleLocales: 'en,zh-Hans',
    });
    assert.equal(await selectCodexUpdateArchive(file, { ...target, availableBuildVersion: '24613' }, 'arm64', '24141'), null);
    await assert.rejects(selectCodexUpdateArchive(file, target, 'x64', '24141'), /架构不匹配/);
    await assert.rejects(selectCodexUpdateArchive(file, target, 'arm64', '24001'), /未提供.*增量包/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture(t, { badSignature = false, downloadError, downloadArchive, feed = '<rss><channel/></rss>' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panel-direct-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, 'installed/ChatGPT.app');
  const dataDirectory = path.join(directory, 'data');
  await mkdir(appPath, { recursive: true });
  const archive = Buffer.from('isolated official delta fixture');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, archive, privateKey).toString('base64');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  let installedBuild = '24141';
  const commands = [];
  const requests = [];
  const applied = [];
  const run = async (command, args) => {
    commands.push([command, args]);
    if (command.endsWith('/sw_vers')) return { stdout: '26.1\n', stderr: '' };
    if (command.endsWith('/xmllint')) return execute(command, args);
    if (command.endsWith('/plutil')) {
      const installed = args.at(-1).startsWith(appPath);
      return { stdout: JSON.stringify({ CFBundleShortVersionString: installed ? '26.1027.61615' : target.availableVersion,
        CFBundleVersion: installed ? installedBuild : target.availableBuildVersion, CFBundleExecutable: 'ChatGPT', SUPublicEDKey: rawPublicKey }), stderr: '' };
    }
    if (command.endsWith('/lipo')) return { stdout: 'arm64\n', stderr: '' };
    if (command.endsWith('/codesign')) {
      const identifier = path.basename(args.at(-1)) === 'codex' ? 'codex' : 'com.openai.codex';
      return { stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=2DC432GLL2\n` };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const downloadFile = async ({ url, destination, expectedLength, signal, offset = 0, onProgress }) => {
    requests.push(new URL(url));
    if (new URL(url).pathname.endsWith('/appcast')) {
      assert.equal(expectedLength, null);
      await writeFile(destination, feed, { signal });
      return;
    }
    assert.equal(expectedLength, archive.length);
    if (downloadError) throw new Error(downloadError);
    if (downloadArchive) return downloadArchive(archive, { destination, offset, signal, onProgress });
    await writeFile(destination, archive, { signal });
    onProgress?.(archive.length);
  };
  const options = { appPath, dataDirectory };
  const dependencies = { platform: 'darwin', architecture: 'arm64', run, downloadFile,
    selectArchive: async (_file, selectedTarget, architecture, sourceBuild) => {
      assert.deepEqual(selectedTarget, target);
      assert.equal(architecture, 'arm64');
      assert.equal(sourceBuild, installedBuild);
      return { url: 'https://persistent.oaistatic.com/codex-app-prod/fixture.delta', length: archive.length,
        signature: badSignature ? Buffer.alloc(64).toString('base64') : signature };
    },
    assertDeltaBase: async () => {},
    applyDelta: async ({ deltaPath, destination, signal }) => {
      signal.throwIfAborted();
      assert.deepEqual(await readFile(deltaPath), archive, 'resume must reconstruct the exact signed delta');
      applied.push(destination);
      await mkdir(path.join(destination, 'Contents/Resources'), { recursive: true });
      await writeFile(path.join(destination, 'Contents/Resources/codex'), 'fixture CLI');
    } };
  return { options, dependencies, commands, requests, applied, archive, installedBuild: value => { installedBuild = value; } };
}

test('checks the official feed despite a skipped native update and preserves the selected channel', { skip: process.platform !== 'darwin' }, async t => {
  const setup = await fixture(t, { feed: appcast });
  const download = createCodexUpdateDownload({ ...setup.options, getPlanType: async () => 'pro' }, setup.dependencies);
  const cdp = { send: async (_method, params) => {
    assert.ok(!params.expression.includes('checkForUpdateInformation'), 'never ask the updater to filter skipped versions');
    return { result: { value: params.expression.includes('appBetaPreferencesByAccountId')
      ? { beta: true } : { isUpdateReady: false, lifecycleState: 'idle' } } };
  } };
  assert.equal((await readCodexUpdateStatus(cdp, { download })).checking, true);
  await waitFor(async () => !(await readCodexUpdateStatus(cdp, { download })).checking);
  const result = await readCodexUpdateStatus(cdp, { download });
  assert.equal(result.available, true);
  assert.match(result.message, /26.1029.61003/);
  assert.equal(setup.requests[0].searchParams.get('beta'), 'true');
  assert.equal(setup.requests[0].searchParams.get('plan_type'), 'pro');
  assert.equal(setup.requests.length, 1);
  assert.equal(setup.applied.length, 0);
  setup.installedBuild(target.availableBuildVersion);
  assert.equal((await readCodexUpdateStatus(cdp, { download, force: true })).checking, true);
  await waitFor(async () => !(await readCodexUpdateStatus(cdp, { download })).checking);
  assert.match((await readCodexUpdateStatus(cdp, { download })).message, /当前已是最新版/);
  assert.equal(setup.requests.length, 2);
  assert.deepEqual(await readdir(path.join(setup.options.dataDirectory, 'codex-update')), []);
});

test('an invalid official feed reports an error rather than the latest version', { skip: process.platform !== 'darwin' }, async t => {
  const setup = await fixture(t, { feed: '' });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  const cdp = { send: async (_method, params) => ({ result: { value: params.expression.includes('appBetaPreferencesByAccountId')
    ? { beta: false } : { isUpdateReady: false, lifecycleState: 'idle' } } }) };
  await readCodexUpdateStatus(cdp, { download });
  await waitFor(async () => !(await readCodexUpdateStatus(cdp, { download })).checking);
  const result = await readCodexUpdateStatus(cdp, { download });
  assert.equal(result.available, false);
  assert.match(result.message, /暂时无法检查更新/);
  assert.doesNotMatch(result.message, /当前已是最新版/);
});

test('downloads in the background, verifies signature, stages, restores, and drops an installed update', async t => {
  const setup = await fixture(t);
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  assert.equal(download.status(), null);
  await download.restore();
  assert.equal(setup.commands.length, 0, 'no stage must not read the installed App');
  let resolvePlan;
  download.start({ ...target, getPlanType: () => new Promise(resolve => { resolvePlan = resolve; }) });
  assert.equal(download.status().downloading, true);
  while (!resolvePlan) await new Promise(resolve => setImmediate(resolve));
  resolvePlan('pro');
  await download.wait();
  assert.equal(download.status().ready, true);
  const staged = path.join(setup.options.dataDirectory, 'codex-update/staged');
  assert.deepEqual(JSON.parse(await readFile(path.join(staged, 'metadata.json'), 'utf8')), {
    version: 1, ...target, installedVersion: '26.1027.61615', installedBuildVersion: '24141', architecture: 'arm64',
  });
  assert.equal(setup.requests[0].searchParams.get('plan_type'), 'pro');
  assert.equal(setup.requests[0].searchParams.get('beta'), 'false');
  assert.ok(setup.commands.some(([command, args]) => command.endsWith('/codesign') && args.includes('--deep')));
  assert.ok(setup.commands.some(([command, args]) => command.endsWith('/codesign') && path.basename(args.at(-1)) === 'codex'));
  await assert.rejects(readFile(path.join(staged, 'update.delta')), { code: 'ENOENT' });
  const restarted = createCodexUpdateDownload(setup.options, setup.dependencies);
  await restarted.restore();
  assert.equal(restarted.status().ready, true);
  setup.installedBuild(target.availableBuildVersion);
  const updated = createCodexUpdateDownload(setup.options, setup.dependencies);
  await updated.restore();
  assert.equal(updated.status(), null);
  await assert.rejects(readFile(path.join(staged, 'metadata.json')), { code: 'ENOENT' });
});

test('rejects invalid archive signatures before extraction and allows retry', async t => {
  const setup = await fixture(t, { badSignature: true });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  download.start({ ...target, planType: 'pro' });
  await download.wait();
  assert.equal(download.status().ready, false);
  assert.equal(download.status().available, true);
  assert.equal(download.status().downloading, false);
  assert.match(download.status().message, /Ed25519 签名验证失败/);
  assert.equal(setup.applied.length, 0);
  download.clearFailure();
  assert.equal(download.status(), null);
  download.start({ ...target, planType: 'pro' });
  assert.equal(download.status().downloading, true);
  await download.wait();
});

test('reports native transport failure without applying an update', async t => {
  const setup = await fixture(t, { downloadError: 'Codex 更新地址不是官方 HTTPS 地址' });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  download.start({ ...target, planType: 'pro' });
  await download.wait();
  assert.match(download.status().message, /不是官方 HTTPS 地址/);
  assert.equal(setup.requests.length, 2);
  assert.equal(setup.applied.length, 0);
});

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function partialFile(setup) {
  const root = path.join(setup.options.dataDirectory, 'codex-update');
  const directories = await readdir(root).catch(() => []);
  const partial = directories.find(name => name.startsWith('.download-'));
  return partial && path.join(root, partial, 'update.delta');
}

async function pauseAfterChunk(archive, { destination, signal, onProgress }) {
  await writeFile(destination, archive.subarray(0, 9), { signal });
  onProgress?.(9);
  signal.throwIfAborted();
  await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

for (const nativeResumeMode of ['append', 'overwrite']) {
  test(`resumes native transfer at the saved offset when transport uses ${nativeResumeMode}`, async t => {
    const offsets = [];
    let requests = 0;
    const setup = await fixture(t, { downloadArchive: async (archive, options) => {
      requests++;
      offsets.push(options.offset);
      if (requests === 1) return pauseAfterChunk(archive, options);
      const offset = nativeResumeMode === 'append' ? options.offset : 0;
      await writeFile(options.destination, archive.subarray(offset), { flag: offset ? 'a' : 'w', signal: options.signal });
      options.onProgress?.(archive.length);
    } });
    const download = createCodexUpdateDownload(setup.options, setup.dependencies);
    download.start({ ...target, planType: 'pro' });
    await waitFor(async () => {
      const file = await partialFile(setup);
      return file && await stat(file).then(info => info.size === 9).catch(() => false);
    });
    assert.equal(download.pause().phase, 'paused');
    // Resume immediately while the old stream is still settling.
    assert.equal(download.resume().phase, 'preparing');
    await download.wait();
    assert.equal(download.status().phase, 'ready');
    assert.deepEqual(offsets, [0, 9]);
    assert.equal(setup.applied.length, 1);
  });
}

test('propagates native resume validation failure without applying corrupt bytes', async t => {
  let requests = 0;
  const setup = await fixture(t, { downloadArchive: (archive, options) => {
    if (++requests === 1) return pauseAfterChunk(archive, options);
    throw new Error('Codex 更新续传范围与已下载文件不一致');
  } });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  download.start({ ...target, planType: 'pro' });
  await waitFor(async () => {
    const file = await partialFile(setup);
    return file && await stat(file).then(info => info.size === 9).catch(() => false);
  });
  download.pause();
  download.resume();
  await download.wait();
  assert.equal(download.status().phase, 'failed');
  assert.match(download.status().message, /续传范围/);
  assert.equal(setup.applied.length, 0);
});

test('cancels a partial download, cleans it after abort settles, and retries after reconnect', async t => {
  let requests = 0;
  const setup = await fixture(t, { downloadArchive: async (archive, options) => {
    if (++requests === 1) return pauseAfterChunk(archive, options);
    await writeFile(options.destination, archive, { signal: options.signal });
    options.onProgress?.(archive.length);
  } });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  download.start({ ...target, planType: 'pro' });
  await waitFor(async () => {
    const file = await partialFile(setup);
    return file && await stat(file).then(info => info.size === 9).catch(() => false);
  });
  assert.equal(download.cancel().phase, 'cancelled');
  assert.equal(download.status().available, true);
  assert.equal(download.status().downloading, false);
  await download.wait();
  assert.equal(await partialFile(setup), undefined);
  assert.equal(setup.applied.length, 0);
  const cdp = { send: async (_method, params) => {
    if (params.expression.includes('appBetaPreferencesByAccountId')) return { result: { value: { beta: false } } };
    return { result: { value: { isUpdateReady: false, lifecycleState: 'idle' } } };
  } };
  let checks = 0;
  download.check = async () => { checks++; return { status: 'available', ...target }; };
  assert.equal((await downloadCodexUpdate(cdp, download)).checking, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readCodexUpdateStatus(cdp, { download })).available, true);
  assert.equal(checks, 1);
  await downloadCodexUpdate(cdp, download);
  await download.wait();
  assert.equal(download.status().phase, 'ready');
  assert.equal(setup.applied.length, 1);
});

test('cancels delta application without publishing a ready update', async t => {
  const setup = await fixture(t);
  let applicationStarted;
  const started = new Promise(resolve => { applicationStarted = resolve; });
  setup.dependencies.applyDelta = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    applicationStarted();
  });
  const download = createCodexUpdateDownload(setup.options, setup.dependencies);
  download.start({ ...target, planType: 'pro' });
  await started;
  assert.equal(download.status().phase, 'verifying');
  assert.equal(download.pause().phase, 'verifying');
  assert.equal(download.cancel().phase, 'cancelled');
  await download.wait();
  assert.equal(await partialFile(setup), undefined);
  await assert.rejects(readFile(path.join(setup.options.dataDirectory, 'codex-update/staged/metadata.json')), { code: 'ENOENT' });
});
