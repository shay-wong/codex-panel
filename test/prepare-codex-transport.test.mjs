import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('transport compilation follows its target and never reuses another architecture cache', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-transport-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/codex-update-transport.swift'), 'fixture');
  const source = await readFile(new URL('../scripts/prepare-codex-transport.mjs', import.meta.url), 'utf8');
  const implementation = source.slice(source.indexOf('export async function ensureCodexTransport'), source.indexOf('\nif (process.argv'))
    .replace('export async function', 'async function');
  const calls = [];
  const prepare = vm.runInNewContext(`${implementation}; ensureCodexTransport`, {
    process: { platform: 'darwin', env: {} }, projectDirectory: root,
    createHash, randomUUID, access, mkdir, readFile, rename, rm, writeFile, path,
    async execute(command, args) {
      calls.push({ command, args: Array.from(args) });
      assert.equal(command, '/usr/bin/xcrun');
      if (args[0] === 'swiftc') {
        await writeFile(args[args.indexOf('-o') + 1], args[args.indexOf('-target') + 1]);
      } else {
        assert.equal(args[0], 'lipo');
        await writeFile(args[args.indexOf('-output') + 1], 'universal');
      }
    },
  });
  const options = { projectRoot: root, signingIdentity: null };
  const arm = await prepare({ ...options, target: 'aarch64-apple-darwin' });
  assert.equal(await readFile(arm.binaryPath, 'utf8'), 'arm64-apple-macosx12.0');
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0].args.at(-1)), 'CodexTransport');
  await prepare({ ...options, target: 'aarch64-apple-darwin' });
  assert.equal(calls.length, 1, 'same target reuses the cache');
  const intel = await prepare({ ...options, target: 'x86_64-apple-darwin' });
  assert.equal(await readFile(intel.binaryPath, 'utf8'), 'x86_64-apple-macosx12.0');
  assert.equal(calls.length, 2, 'changing target compiles only the requested architecture');
  const universal = await prepare(options);
  assert.equal(await readFile(universal.binaryPath, 'utf8'), 'universal');
  assert.deepEqual(calls.slice(2).map(call => call.args[0]), ['swiftc', 'swiftc', 'lipo']);
  assert.deepEqual(calls.slice(2, 4).map(call => call.args[call.args.indexOf('-target') + 1]),
    ['arm64-apple-macosx12.0', 'x86_64-apple-macosx12.0']);
  await assert.rejects(prepare({ ...options, target: 'x86_64-unknown-linux-gnu' }), /Unsupported Codex transport target/);
  assert.equal(calls.length, 5);
});
