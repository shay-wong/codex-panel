import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

async function transportTool() {
  for (const file of ['../tools/CodexTransport', '../.tmp/codex-transport/CodexTransport']) {
    const candidate = path.resolve(scriptRoot, file);
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Codex 系统下载工具未打包，请重新安装 Codex Panel');
}

export async function downloadCodexFile({ url, destination, expectedLength, offset = 0, signal, onProgress }, { helperPath } = {}) {
  signal?.throwIfAborted();
  const helper = helperPath ?? await transportTool();
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(helper, [String(url), destination, String(expectedLength ?? 0), String(offset)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error;
    let stderr = '';
    const lines = createInterface({ input: child.stdout });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', value => { error = value; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    lines.on('line', line => {
      if (error || signal?.aborted) return;
      try {
        const progress = JSON.parse(line);
        if (!Number.isSafeInteger(progress.downloaded) || progress.downloaded < 0) throw new Error('Codex 下载进度无效');
        onProgress?.(progress.downloaded);
      } catch (value) { error = value; abort(); }
    });
    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      lines.close();
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else if (code !== 0) reject(new Error(stderr.trim() || `Codex 系统下载失败：${exitSignal ?? code}`));
      else resolve();
    });
  });
}
