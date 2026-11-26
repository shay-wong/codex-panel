import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function ensureCodexTransport({ projectRoot = projectDirectory, cacheDirectory,
  signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-',
  target = 'universal-apple-darwin',
} = {}) {
  if (process.platform !== 'darwin') throw new Error('Codex 系统下载工具仅支持 macOS');
  const architectures = {
    'aarch64-apple-darwin': ['arm64'],
    'x86_64-apple-darwin': ['x86_64'],
    'universal-apple-darwin': ['arm64', 'x86_64'],
  }[target];
  if (!architectures) throw new Error(`Unsupported Codex transport target: ${target}`);
  const source = path.join(projectRoot, 'scripts/codex-update-transport.swift');
  // 架构和签名身份都属于产物的一部分，thin 包不能复用另一架构的缓存。
  const fingerprint = createHash('sha256').update(await readFile(source))
    .update(`macos12-swift5-v4:${target}:${signingIdentity ?? 'unsigned'}`).digest('hex');
  const cache = cacheDirectory ?? path.join(projectRoot, '.tmp/codex-transport');
  const binaryPath = path.join(cache, 'CodexTransport');
  try {
    if ((await readFile(path.join(cache, 'source.sha256'), 'utf8')) === fingerprint) {
      await access(binaryPath);
      return { binaryPath };
    }
  } catch {}
  const temporary = `${cache}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true });
  try {
    const executable = path.join(temporary, 'CodexTransport');
    for (const architecture of architectures) {
      const output = architectures.length === 1 ? executable : path.join(temporary, architecture);
      await execute('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${architecture}-apple-macosx12.0`, source, '-o', output], { timeout: 120_000 });
    }
    if (architectures.length === 2) {
      await execute('/usr/bin/xcrun', ['lipo', '-create', ...architectures.map(architecture => path.join(temporary, architecture)), '-output', executable]);
      for (const architecture of architectures) await rm(path.join(temporary, architecture));
    }
    if (signingIdentity) {
      await execute('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', signingIdentity, path.join(temporary, 'CodexTransport')]);
    }
    await writeFile(path.join(temporary, 'source.sha256'), fingerprint);
    await rm(cache, { recursive: true, force: true });
    await rename(temporary, cache);
    return { binaryPath };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureCodexTransport().then(result => console.log(result.binaryPath)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
