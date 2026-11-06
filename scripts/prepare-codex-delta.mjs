import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveUrl = 'https://github.com/sparkle-project/Sparkle/releases/download/2.9.1/Sparkle-2.9.1.tar.xz';
const hashes = {
  archive: 'c0dde519fd2a43ddfc6a1eb76aec284d7d888fe281414f9177de3164d98ba4c7',
  binary: '5c31312b5dd6bbfa4d3adf79360f0851b9369a72b5facf7f7b4df0906f4fcf67',
  license: '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe',
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function ensureCodexDeltaTool({ projectRoot = projectDirectory, cacheDirectory, archivePath } = {}) {
  if (process.platform !== 'darwin') throw new Error('Codex 增量更新工具仅支持 macOS');
  const cache = cacheDirectory ?? path.join(projectRoot, '.tmp/codex-delta/2.9.1');
  const result = { binaryPath: path.join(cache, 'BinaryDelta'), licensePath: path.join(cache, 'Sparkle-LICENSE') };
  try {
    if (hash(await readFile(result.binaryPath)) === hashes.binary && hash(await readFile(result.licensePath)) === hashes.license) return result;
  } catch {}
  const temporary = `${cache}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true });
  try {
    let archive;
    if (archivePath) archive = await readFile(archivePath);
    else {
      const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`下载 Sparkle 增量工具失败：HTTP ${response.status}`);
      archive = Buffer.from(await response.arrayBuffer());
    }
    if (hash(archive) !== hashes.archive) throw new Error('Sparkle 增量工具下载校验失败');
    const archiveFile = path.join(temporary, 'Sparkle.tar.xz');
    await writeFile(archiveFile, archive);
    await execute('/usr/bin/tar', ['-xJf', archiveFile, '-C', temporary, './bin/BinaryDelta', './LICENSE'], { timeout: 30_000 });
    const binary = await readFile(path.join(temporary, 'bin/BinaryDelta'));
    const license = await readFile(path.join(temporary, 'LICENSE'));
    if (hash(binary) !== hashes.binary || hash(license) !== hashes.license) throw new Error('Sparkle 增量工具内容校验失败');
    await writeFile(path.join(temporary, 'BinaryDelta'), binary);
    await chmod(path.join(temporary, 'BinaryDelta'), 0o755);
    await writeFile(path.join(temporary, 'Sparkle-LICENSE'), license);
    await rm(path.join(temporary, 'bin'), { recursive: true });
    await rm(path.join(temporary, 'LICENSE'));
    await rm(archiveFile);
    await rm(cache, { recursive: true, force: true });
    await rename(temporary, cache);
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureCodexDeltaTool().then(result => console.log(result.binaryPath)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
