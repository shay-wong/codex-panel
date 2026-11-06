import { execFile } from 'node:child_process';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

export async function assertCodexDeltaBase({ appPath, deltaFromSparkleExecutableSize, deltaFromSparkleLocales, signal }) {
  signal?.throwIfAborted();
  const framework = path.join(appPath, 'Contents/Frameworks/Sparkle.framework');
  // Match Sparkle 2.9.1 SUAppcastDriver: permissions, executable size and every declared locale.
  const executable = await stat(path.join(framework, 'Sparkle'));
  if ((executable.mode & 0o7777) !== 0o755) throw new Error('当前 Codex 的 Sparkle 权限不支持增量更新');
  if (deltaFromSparkleExecutableSize != null && deltaFromSparkleExecutableSize !== '') {
    const expected = Number(deltaFromSparkleExecutableSize);
    if (!Number.isSafeInteger(expected) || expected <= 0 || executable.size !== expected) {
      throw new Error('当前 Codex 与官方增量包的基础文件不匹配，无法进行增量更新');
    }
  }
  const locales = Array.isArray(deltaFromSparkleLocales) ? deltaFromSparkleLocales
    : String(deltaFromSparkleLocales ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const locale of locales) {
    if (typeof locale !== 'string' || !/^[A-Za-z0-9_-]+$/.test(locale)) throw new Error('官方增量包的语言要求无效');
    try { await access(path.join(framework, 'Resources', `${locale}.lproj`)); }
    catch { throw new Error(`当前 Codex 缺少增量更新需要的语言文件：${locale}`); }
  }
  signal?.throwIfAborted();
}

async function deltaTool() {
  const bundled = path.join(scriptRoot, '../tools/BinaryDelta');
  try { await access(bundled); return bundled; } catch {}
  const development = path.join(scriptRoot, '../.tmp/codex-delta/2.9.1/BinaryDelta');
  try { await access(development); return development; }
  catch { throw new Error('Codex 增量更新工具未打包，请重新安装 Codex Panel'); }
}

export async function applyCodexDelta({ appPath, deltaPath, destination, signal }, { run = execute, helperPath } = {}) {
  signal?.throwIfAborted();
  if ((await lstat(appPath)).isSymbolicLink() || !(await lstat(deltaPath)).isFile()) {
    throw new Error('Codex 增量更新路径无效');
  }
  const source = await realpath(appPath);
  const parent = await realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  if (target === source || target.startsWith(`${source}${path.sep}`) || source.startsWith(`${target}${path.sep}`)) {
    throw new Error('Codex 增量更新必须生成到独立的暂存目录');
  }
  try {
    await lstat(target);
    throw new Error('Codex 增量更新的目标已存在');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tool = helperPath ?? await deltaTool();
  if (!(await lstat(tool)).isFile()) throw new Error('Codex 增量更新工具无效');
  // The official CLI verifies the source tree, copies it, applies the patch, and verifies the result.
  await run(tool, ['apply', source, target, await realpath(deltaPath)], {
    timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024, signal,
  });
  signal?.throwIfAborted();
}
