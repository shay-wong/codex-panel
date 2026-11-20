import { parentPort, workerData } from 'node:worker_threads';
import { buildRspackFeaturePlan, buildRspackUpdatePlan, composeRspackFeaturePlans } from './codex-rspack.mjs';
import { readCodexRspack, shareRspackCatalog, sharedRspackCatalog } from './codex-rspack-source.mjs';

let lastPhase, lastTime = 0;
const onProgress = progress => {
  const phase = `${progress.phase}:${progress.feature ?? ''}`;
  const now = performance.now();
  if (phase !== lastPhase || progress.completed === 0 || (progress.total != null && progress.completed === progress.total) || now - lastTime >= 150) {
    lastPhase = phase;
    lastTime = now;
    parentPort.postMessage({ type: 'progress', progress });
  }
};

try {
  let result;
  if (workerData.task === 'read') {
    onProgress({ phase: 'read' });
    const catalog = await readCodexRspack(workerData.appPath, { onProgress, cache: false });
    result = catalog ? shareRspackCatalog(catalog) : null;
  } else {
    const catalog = sharedRspackCatalog(workerData.catalog);
    result = workerData.task === 'compose'
      ? composeRspackFeaturePlans(catalog, workerData.plans, onProgress)
      : workerData.feature === 'nativeUpdate' ? buildRspackUpdatePlan(catalog, onProgress)
        : buildRspackFeaturePlan(catalog, workerData.feature, onProgress);
  }
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
}
