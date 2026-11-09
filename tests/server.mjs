// Local E2E harness: boots an isolated Panel server on 127.0.0.1.
// - Data lives in a throwaway temp directory (never the developer's `.data`).
// - The Codex executable is pointed at a nonexistent path and external
//   fetches are disabled, so a test can never reach Codex or the network.
//   The path must not end in .js/.mjs/.cjs: `executableCommand` runs a
//   Node-script extension through `process.execPath`, which would make the
//   "disabled" stand-in a real node process instead of a missing binary.
// - Static web UI is served from dist/web (run `npm run build:web` first).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer, resolveServerOptions } from '../server/app.mjs';

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalPath(path.dirname(value)), path.basename(value));
  }
}

const port = Number(process.argv[2] ?? '4310');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'panel-e2e-')));
const workspace = path.join(directory, 'workspace');
const skillPath = path.join(directory, 'skills', 'manage-panel', 'SKILL.md');
await mkdir(workspace);
await mkdir(path.dirname(skillPath), { recursive: true });
await writeFile(skillPath, 'Isolated E2E skill fixture.\n');
const noExternalFetch = async () => {
  throw new Error('External requests disabled in local E2E');
};
const options = {
  dataDirectory: path.join(directory, 'data'),
  staticDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)),
  skillPath,
  nativeSkillPath: skillPath,
  skillsDirectory: path.join(directory, 'skills'),
  codexExecutable: path.join(directory, 'disabled-codex'),
  processEnv: { PATH: '', HOME: directory, CODEX_HOME: path.join(directory, 'codex') },
  jiraFetch: noExternalFetch,
  remoteFetch: noExternalFetch,
};
const production = resolveServerOptions();
const resolved = resolveServerOptions(options);
for (const key of ['dataDirectory', 'databasePath', 'attachmentsDirectory', 'cloudConfigPath', 'jiraConfigPath', 'clientStoragePath', 'codexStatePath', 'codexProcessesPath', 'skillsDirectory', 'skillPath', 'nativeSkillPath', 'codexExecutable']) {
  const target = await canonicalPath(resolved[key]);
  const active = await canonicalPath(production[key]);
  assert.ok(target.startsWith(directory + path.sep), `${key} must stay in the E2E directory`);
  assert.ok(target !== active && !target.startsWith(active + path.sep) && !active.startsWith(target + path.sep), `${key} overlaps production`);
}
process.chdir(workspace);
console.log(`E2E isolated data=${resolved.dataDirectory} workspace=${workspace}; Jira/cloud requests disabled`);
const app = createPanelServer(options);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
await app.listen({ host: '127.0.0.1', port });
