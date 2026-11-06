import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function ensureCodexTransport({ projectRoot = projectDirectory, cacheDirectory } = {}) {
  if (process.platform !== 'darwin') throw new Error('Codex 系统下载工具仅支持 macOS');
  const source = path.join(projectRoot, 'scripts/codex-update-transport.swift');
  const fingerprint = createHash('sha256').update(await readFile(source)).update('universal-macos12-swift5-v2').digest('hex');
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
    for (const architecture of ['arm64', 'x86_64']) {
      await execute('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${architecture}-apple-macosx12.0`, source, '-o', path.join(temporary, architecture)], { timeout: 120_000 });
    }
    await execute('/usr/bin/xcrun', ['lipo', '-create', path.join(temporary, 'arm64'), path.join(temporary, 'x86_64'), '-output', path.join(temporary, 'CodexTransport')]);
    await execute('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', '-', path.join(temporary, 'CodexTransport')]);
    await rm(path.join(temporary, 'arm64'));
    await rm(path.join(temporary, 'x86_64'));
    await writeFile(path.join(temporary, 'source.sha256'), fingerprint);
    await rm(cache, { recursive: true, force: true });
    await rename(temporary, cache);
    return { binaryPath };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureCodexTransport().then(result => console.log(result.binaryPath)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
