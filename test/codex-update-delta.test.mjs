import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { applyCodexDelta, assertCodexDeltaBase } from '../scripts/codex-update-delta.mjs';
import { ensureCodexDeltaTool } from '../scripts/prepare-codex-delta.mjs';

const execute = promisify(execFile);
const tool = process.env.CODEX_DELTA_TEST_TOOL;
const archive = process.env.CODEX_DELTA_TEST_ARCHIVE;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-delta-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('delta preflight matches Sparkle size, permissions and every required locale', async t => {
  const root = await fixture(t);
  const appPath = path.join(root, 'ChatGPT.app');
  const framework = path.join(appPath, 'Contents/Frameworks/Sparkle.framework');
  await mkdir(path.join(framework, 'Resources/en.lproj'), { recursive: true });
  await writeFile(path.join(framework, 'Sparkle'), 'sparkle');
  await chmod(path.join(framework, 'Sparkle'), 0o755);
  const options = { appPath, deltaFromSparkleExecutableSize: '7', deltaFromSparkleLocales: 'en' };
  await assert.doesNotReject(assertCodexDeltaBase(options));
  await assert.rejects(assertCodexDeltaBase({ ...options, deltaFromSparkleExecutableSize: '8' }), /基础文件不匹配/);
  await assert.rejects(assertCodexDeltaBase({ ...options, deltaFromSparkleLocales: 'en,fr' }), /fr/);
  await chmod(path.join(framework, 'Sparkle'), 0o644);
  await assert.rejects(assertCodexDeltaBase(options), /权限/);
});

test('official BinaryDelta creates and applies a patch without modifying the source', { skip: !tool || process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  const appPath = path.join(root, 'Old.app');
  const next = path.join(root, 'New.app');
  const destination = path.join(root, 'Patched.app');
  const deltaPath = path.join(root, 'update.delta');
  await mkdir(appPath);
  await mkdir(next);
  await writeFile(path.join(appPath, 'large.txt'), 'original line\n'.repeat(10_000));
  await writeFile(path.join(next, 'large.txt'), `${'original line\n'.repeat(5_000)}modified line\n${'original line\n'.repeat(5_000)}`);
  await writeFile(path.join(appPath, 'removed'), 'old');
  await writeFile(path.join(next, 'added'), 'new');
  await symlink('large.txt', path.join(appPath, 'link'));
  await symlink('added', path.join(next, 'link'));
  await execute(tool, ['create', appPath, next, deltaPath]);
  await applyCodexDelta({ appPath, deltaPath, destination }, { helperPath: tool });
  assert.deepEqual(await readFile(path.join(destination, 'large.txt')), await readFile(path.join(next, 'large.txt')));
  assert.equal(await readFile(path.join(destination, 'added'), 'utf8'), 'new');
  await assert.rejects(readFile(path.join(destination, 'removed')), { code: 'ENOENT' });
  assert.equal(await readlink(path.join(destination, 'link')), 'added');
  assert.equal(await readFile(path.join(appPath, 'removed'), 'utf8'), 'old');
  assert.equal(await readlink(path.join(appPath, 'link')), 'large.txt');
  await assert.rejects(applyCodexDelta({ appPath, deltaPath, destination: appPath }, { helperPath: tool }), /独立的暂存/);
  await writeFile(path.join(appPath, 'large.txt'), 'base changed');
  await assert.rejects(applyCodexDelta({ appPath, deltaPath, destination: path.join(root, 'Wrong.app') }, { helperPath: tool }), /expected hash/);
  assert.equal(await readFile(path.join(appPath, 'large.txt'), 'utf8'), 'base changed');
});

test('preparation verifies and extracts the pinned official tool and license offline', { skip: !archive || process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  const result = await ensureCodexDeltaTool({ cacheDirectory: path.join(root, 'cache'), archivePath: archive });
  const { stdout } = await execute(result.binaryPath, ['info']);
  assert.match(stdout, /BinaryDelta version/);
  assert.match(await readFile(result.licensePath, 'utf8'), /Copyright \(c\) 2006-2013 Andy Matuschak/);
  assert.deepEqual(await ensureCodexDeltaTool({ cacheDirectory: path.join(root, 'cache') }), result);
  const invalidArchive = path.join(root, 'invalid.tar.xz');
  await writeFile(invalidArchive, 'invalid');
  await assert.rejects(ensureCodexDeltaTool({ cacheDirectory: path.join(root, 'invalid'), archivePath: invalidArchive }), /校验失败/);
});
