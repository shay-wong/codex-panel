import { execFile } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyCodexDelta, assertCodexDeltaBase } from './codex-update-delta.mjs';
import { downloadCodexFile } from './codex-update-transport.mjs';

const execute = promisify(execFile);
const verifySignature = promisify(verify);
const officialHosts = new Set(['updates.oaistatic.com', 'persistent.oaistatic.com']);
const versionPattern = /^\d+(?:\.\d+){1,4}$/;
const buildPattern = /^\d+$/;

function officialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Codex 更新地址不是官方 HTTPS 地址');
  }
  return url;
}

function targetVersion(value, build) {
  if (!versionPattern.test(value ?? '') || !buildPattern.test(String(build ?? ''))) {
    throw new Error('Codex 官方更新检查未提供完整的版本和构建号，请重新检查更新');
  }
  return { availableVersion: value, availableBuildVersion: String(build) };
}

function appcastUrl(installed, architecture, systemVersion, beta, planType) {
  const url = new URL('https://updates.oaistatic.com/codex/app/appcast');
  url.search = new URLSearchParams({ installation_id: randomUUID(), arch: architecture,
    app_version: installed.CFBundleShortVersionString, beta: String(beta), 'os-version': systemVersion, plan_type: planType });
  return url.href;
}

export async function selectCodexUpdateVersion(file, architecture, systemVersion, run = execute) {
  const xml = await readFile(file, 'utf8');
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) throw new Error('Codex 更新清单包含不允许的 XML 声明');
  const xpath = async expression => (await run('/usr/bin/xmllint', ['--nonet', '--xpath', expression, file], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (await xpath('count(/rss/channel)') !== '1') throw new Error('Codex 官方更新清单格式无效');
  const count = Number(await xpath('count(/rss/channel/item)'));
  let latest = null;
  for (let index = 1; index <= count; index++) {
    const item = `/rss/channel/item[${index}]`;
    const fields = ['version', 'shortVersionString', 'hardwareRequirements', 'minimumSystemVersion'];
    const values = fields.map(field => `string((${item}/*[local-name()='${field}'] | ${item}/enclosure/@*[local-name()='${field}'])[1])`);
    const [build, version, hardware, minimumSystemVersion] = (await xpath(`concat(${values.join(", '|', ")})`)).split('|');
    if (hardware && hardware !== architecture) continue;
    if (minimumSystemVersion) {
      if (!versionPattern.test(minimumSystemVersion) || !versionPattern.test(systemVersion)) throw new Error('Codex 更新系统版本要求无效');
      const required = minimumSystemVersion.split('.').map(Number);
      const current = systemVersion.split('.').map(Number);
      const difference = Array.from({ length: Math.max(required.length, current.length) }, (_, i) => (current[i] ?? 0) - (required[i] ?? 0)).find(value => value !== 0) ?? 0;
      if (difference < 0) continue;
    }
    const target = targetVersion(version, build);
    if (!latest || BigInt(target.availableBuildVersion) > BigInt(latest.availableBuildVersion)) latest = target;
  }
  return latest;
}

// Download only the official delta from the installed build to the checked appcast offer.
export async function selectCodexUpdateArchive(file, target, architecture, installedBuild, run = execute) {
  const { availableVersion, availableBuildVersion } = targetVersion(target.availableVersion, target.availableBuildVersion);
  if (!buildPattern.test(String(installedBuild ?? ''))) throw new Error('当前 Codex 构建号无效');
  const item = `/rss/channel/item[(*[local-name()='version'] | enclosure/@*[local-name()='version'])='${availableBuildVersion}' and (*[local-name()='shortVersionString'] | enclosure/@*[local-name()='shortVersionString'])='${availableVersion}']`;
  const xpath = async expression => (await run('/usr/bin/xmllint', ['--nonet', '--xpath', expression, file], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const count = Number(await xpath(`count(${item})`));
  if (count === 0) return null;
  if (count !== 1) throw new Error('Codex 官方更新清单中的目标版本不唯一');
  const enclosure = `${item}/*[local-name()='deltas']/enclosure[@*[local-name()='deltaFrom']='${installedBuild}']`;
  if (Number(await xpath(`count(${enclosure})`)) !== 1) throw new Error('官方未提供从当前 Codex 版本到目标版本的增量包');
  const attr = name => xpath(`string(${enclosure}/@${name})`);
  const sparkleAttr = name => xpath(`string(${enclosure}/@*[local-name()='${name}'])`);
  const [url, length, signature, hardware, executableSize, locales] = await Promise.all([
    attr('url'), attr('length'), sparkleAttr('edSignature'),
    xpath(`string((${item}/*[local-name()='hardwareRequirements'] | ${item}/enclosure/@*[local-name()='hardwareRequirements'])[1])`),
    sparkleAttr('deltaFromSparkleExecutableSize'), sparkleAttr('deltaFromSparkleLocales'),
  ]);
  if (hardware && hardware !== architecture) throw new Error('Codex 官方更新安装包的架构不匹配');
  if (!Number.isSafeInteger(Number(length)) || Number(length) <= 0) throw new Error('Codex 官方更新安装包大小无效');
  if (Buffer.from(signature, 'base64').length !== 64) throw new Error('Codex 官方更新缺少有效的 Ed25519 签名');
  const resolved = officialUrl(url);
  if (!resolved.pathname.endsWith('.delta')) throw new Error('Codex 官方更新未提供有效的增量包');
  return { url: resolved.href, length: Number(length), signature, deltaFrom: String(installedBuild),
    deltaFromSparkleExecutableSize: executableSize || null, deltaFromSparkleLocales: locales || null };
}

async function readAppInfo(appPath, run) {
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')], { timeout: 15_000 });
  const info = JSON.parse(stdout);
  targetVersion(info.CFBundleShortVersionString, info.CFBundleVersion);
  return info;
}

async function verifyOfficialApp(appPath, target, architecture, run) {
  if ((await lstat(appPath)).isSymbolicLink()) throw new Error('Codex 暂存安装包不能是符号链接');
  const info = await readAppInfo(appPath, run);
  if (info.CFBundleShortVersionString !== target.availableVersion || String(info.CFBundleVersion) !== target.availableBuildVersion) {
    throw new Error('Codex 暂存安装包版本与官方检查结果不一致');
  }
  if (typeof info.CFBundleExecutable !== 'string' || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw new Error('Codex 暂存安装包的可执行文件无效');
  const binary = path.join(appPath, 'Contents/MacOS', info.CFBundleExecutable);
  const { stdout: architectures } = await run('/usr/bin/lipo', ['-archs', binary], { timeout: 15_000 });
  if (!architectures.trim().split(/\s+/).includes(architecture === 'x64' ? 'x86_64' : architecture)) throw new Error('Codex 暂存安装包的架构不匹配');
  const check = async (file, identifier, deep) => {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Codex 签名组件不能是符号链接');
    await run('/usr/bin/codesign', ['--verify', '--strict', ...(deep ? ['--deep'] : []), file], { timeout: 120_000 });
    const details = (await run('/usr/bin/codesign', ['-dv', '--verbose=4', file], { timeout: 15_000 })).stderr;
    const lines = details.split(/\r?\n/);
    if (!lines.includes(`Identifier=${identifier}`) || !lines.includes('TeamIdentifier=2DC432GLL2')) throw new Error('Codex 安装包官方签名身份不匹配');
  };
  await check(appPath, 'com.openai.codex', true);
  let cli = path.join(appPath, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  try { await access(cli); } catch { cli = path.join(appPath, 'Contents/Resources/codex'); }
  await check(cli, 'codex', false);
}

async function verifyArchive(bytes, signature, publicKey) {
  const rawKey = Buffer.from(publicKey ?? '', 'base64');
  if (rawKey.length !== 32) throw new Error('当前 Codex 安装包未提供有效的官方更新公钥');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
  if (!await verifySignature(null, bytes, key, Buffer.from(signature, 'base64'))) throw new Error('Codex 更新安装包 Ed25519 签名验证失败');
}

export function createCodexUpdateDownload({ appPath, dataDirectory, getPlanType }, dependencies = {}) {
  const { downloadFile = downloadCodexFile, run = execute, architecture = process.arch, platform = process.platform,
    selectArchive = selectCodexUpdateArchive, applyDelta = applyCodexDelta, assertDeltaBase = assertCodexDeltaBase } = dependencies;
  const root = path.join(dataDirectory, 'codex-update');
  const staged = path.join(root, 'staged');
  let state = null;
  let task = Promise.resolve();
  let active = null;
  const status = (phase, message) => ({ phase, ready: phase === 'ready', available: true,
    downloading: ['preparing', 'downloading', 'verifying'].includes(phase), checking: false, message });
  const failed = error => { state = status('failed', `Codex 更新下载失败：${error.message ?? error}`); };
  const ready = target => { state = status('ready', `更新 ${target.availableVersion} 已下载，可安装并重新连接`); };

  async function restore() {
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(staged, 'metadata.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') failed(error); return; }
    try {
      if (metadata.version !== 1 || metadata.architecture !== architecture) throw new Error('Codex 暂存更新信息无效');
      const target = targetVersion(metadata.availableVersion, metadata.availableBuildVersion);
      const installed = await readAppInfo(appPath, run);
      if (BigInt(installed.CFBundleVersion) >= BigInt(target.availableBuildVersion)) {
        await rm(staged, { recursive: true, force: true });
        state = null;
        return;
      }
      await verifyOfficialApp(path.join(staged, 'ChatGPT.app'), target, architecture, run);
      ready(target);
    } catch (error) { failed(error); }
  }

  async function download(session) {
    const { offer, controller } = session;
    const signal = controller.signal;
    const running = () => { signal.throwIfAborted(); if (active !== session) throw new Error('下载已取消'); };
    const command = (file, args, options = {}) => run(file, args, { ...options, signal });
    try {
      running();
      if (!session.archive) {
        if (platform !== 'darwin') throw new Error('直接下载 Codex 更新目前仅支持 macOS');
        if (!['arm64', 'x64'].includes(architecture)) throw new Error('Codex 更新不支持当前架构');
        session.target = targetVersion(offer.availableVersion, offer.availableBuildVersion);
        session.installed = await readAppInfo(appPath, command);
        if (BigInt(session.installed.CFBundleVersion) >= BigInt(session.target.availableBuildVersion)) throw new Error('该 Codex 更新已经安装，请重新检查更新');
        await mkdir(root, { recursive: true, mode: 0o700 });
        session.temporary = path.join(root, `.download-${randomUUID()}`);
        await mkdir(session.temporary, { mode: 0o700 });
        const planType = await offer.getPlanType?.() ?? offer.planType ?? 'unknown';
        running();
        const systemVersion = (await command('/usr/bin/sw_vers', ['-productVersion'], { timeout: 15_000 })).stdout.trim();
        const appcast = path.join(session.temporary, 'appcast.xml');
        for (const beta of typeof offer.beta === 'boolean' ? [offer.beta] : [false, true]) {
          await downloadFile({ url: appcastUrl(session.installed, architecture, systemVersion, beta, planType), destination: appcast, expectedLength: null,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
          const xml = await readFile(appcast, { encoding: 'utf8', signal });
          if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) throw new Error('Codex 更新清单包含不允许的 XML 声明');
          session.archive = await selectArchive(appcast, session.target, architecture, session.installed.CFBundleVersion, command);
          if (session.archive) break;
        }
        if (!session.archive) throw new Error('官方更新清单中未找到已检查到的版本，请重新检查更新');
        await assertDeltaBase({ appPath, deltaFromSparkleExecutableSize: session.archive.deltaFromSparkleExecutableSize,
          deltaFromSparkleLocales: session.archive.deltaFromSparkleLocales, signal }, { run: command });
        session.archivePath = path.join(session.temporary, 'update.delta');
      }
      running();
      const { archive, archivePath, target, installed, temporary } = session;
      const downloaded = await stat(archivePath).then(value => value.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (downloaded > archive.length) throw new Error('Codex 更新安装包超过官方声明大小');
      if (downloaded < archive.length) {
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
        state = status('downloading', `正在下载 Codex ${target.availableVersion} · ${Math.floor(downloaded / archive.length * 100)}%`);
        await downloadFile({ url: archive.url, destination: archivePath, expectedLength: archive.length,
          offset: downloaded, signal: downloadSignal, onProgress(bytes) {
            if (!signal.aborted && active === session) state = status('downloading', `正在下载 Codex ${target.availableVersion} · ${Math.floor(bytes / archive.length * 100)}%`);
          } });
        if ((await stat(archivePath)).size !== archive.length) throw new Error('Codex 更新安装包下载不完整');
      }
      running();
      state = status('verifying', '正在验证 Codex 更新安装包…');
      await verifyArchive(await readFile(archivePath, { signal }), archive.signature, installed.SUPublicEDKey);
      running();
      await applyDelta({ appPath, deltaPath: archivePath, destination: path.join(temporary, 'ChatGPT.app'), signal,
        deltaFromSparkleExecutableSize: archive.deltaFromSparkleExecutableSize,
        deltaFromSparkleLocales: archive.deltaFromSparkleLocales }, { run: command });
      await verifyOfficialApp(path.join(temporary, 'ChatGPT.app'), target, architecture, command);
      running();
      await rm(archivePath);
      await rm(path.join(temporary, 'appcast.xml'));
      await writeFile(path.join(temporary, 'metadata.json'), JSON.stringify({ version: 1, ...target,
        installedVersion: installed.CFBundleShortVersionString, installedBuildVersion: String(installed.CFBundleVersion),
        architecture }), { mode: 0o600, signal });
      running();
      await rm(staged, { recursive: true, force: true });
      running();
      await rename(temporary, staged);
      session.temporary = null;
      session.published = true;
      running();
      ready(target);
    } catch (error) {
      if (!session.paused && !session.cancelled && active === session) failed(error);
    } finally {
      if (!session.paused && session.temporary) {
        await rm(session.temporary, { recursive: true, force: true }).catch(() => {});
        session.temporary = null;
      }
      if (session.cancelled && session.published) await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    status: () => state && { ...state },
    restore,
    async check({ beta, planType = 'unknown' }) {
      const signal = AbortSignal.timeout(30_000);
      const command = (file, args, options = {}) => run(file, args, { ...options, signal });
      planType = await getPlanType?.() ?? planType;
      const installed = await readAppInfo(appPath, command);
      const systemVersion = (await command('/usr/bin/sw_vers', ['-productVersion'], { timeout: 15_000 })).stdout.trim();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = path.join(root, `.check-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        const file = path.join(temporary, 'appcast.xml');
        await downloadFile({ url: appcastUrl(installed, architecture, systemVersion, beta, planType),
          destination: file, expectedLength: null, signal });
        const target = await selectCodexUpdateVersion(file, architecture, systemVersion, command);
        return { installedVersion: installed.CFBundleShortVersionString,
          ...(target && BigInt(target.availableBuildVersion) > BigInt(installed.CFBundleVersion)
            ? { status: 'available', ...target, beta, planType }
            : { status: 'up_to_date' }) };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    },
    start(offer) {
      if (active && ['preparing', 'downloading', 'paused', 'verifying', 'ready'].includes(state?.phase)) return;
      const session = { offer, controller: new AbortController(), paused: false, cancelled: false };
      active = session;
      state = status('preparing', '正在准备下载 Codex 更新…');
      task = task.then(() => download(session));
    },
    pause() {
      if (active && state?.phase === 'downloading') {
        active.paused = true;
        active.controller.abort();
        state = status('paused', '下载已暂停');
      }
      return state && { ...state };
    },
    resume() {
      if (active && state?.phase === 'paused') {
        const session = active;
        state = status('preparing', '正在继续下载 Codex 更新…');
        task = task.then(() => {
          if (session.cancelled || active !== session) return;
          session.paused = false;
          session.controller = new AbortController();
          return download(session);
        });
      }
      return state && { ...state };
    },
    cancel() {
      if (active && ['preparing', 'downloading', 'paused', 'verifying'].includes(state?.phase)) {
        const session = active;
        session.cancelled = true;
        session.paused = false;
        session.controller.abort();
        active = null;
        state = status('cancelled', '已取消下载');
        task = task.then(async () => {
          if (session.temporary) await rm(session.temporary, { recursive: true, force: true }).catch(() => {});
          session.temporary = null;
        });
      }
      return state && { ...state };
    },
    clearFailure() { if (['failed', 'cancelled'].includes(state?.phase)) state = null; },
    wait: () => task,
  };
}
