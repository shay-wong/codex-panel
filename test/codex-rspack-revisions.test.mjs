import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCodexRspackRevisions } from '../scripts/codex-rspack-revisions.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-rspack-revisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsDirectory = path.join(root, 'workspace/scripts');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await cp(new URL('../scripts/', import.meta.url), scriptsDirectory, { recursive: true });
  return { scriptsDirectory };
}

async function replace(fixture, filename, from, to) {
  const file = path.join(fixture.scriptsDirectory, filename), source = await readFile(file, 'utf8');
  assert.ok(source.includes(from), `${filename} contains the intended change`);
  await writeFile(file, source.replace(from, to));
}

function changed(before, after) {
  return Object.keys(before.features).filter(feature => before.features[feature] !== after.features[feature]);
}

test('runtime UI, phrases and pet assets do not invalidate static adaptation', async t => {
  const f = await fixture(t), before = await getCodexRspackRevisions(f);
  await replace(f, 'codex-rspack-tabs.mjs', 'export function createRspackThreadTabsRuntime() {', 'export function createRspackThreadTabsRuntime() {\n  const changedRuntime = true;');
  await replace(f, 'codex-rspack-pets.mjs', 'export function createPetAnimationRuntime(initialPacks = [], builtinPet) {', 'export function createPetAnimationRuntime(initialPacks = [], builtinPet) {\n  const changedRuntime = true;');
  await replace(f, 'codex-rspack.mjs', 'export function createCodexRspackRuntime(plan) {', 'export function createCodexRspackRuntime(plan) {\n  const changedRuntime = true;');
  await replace(f, 'codex-provider-quota.mjs', 'export function createCodexProviderQuotaRuntime(initialEnabled) {', 'export function createCodexProviderQuotaRuntime(initialEnabled) {\n  const changedRuntime = true;');
  await writeFile(path.join(f.scriptsDirectory, 'pet-animations.mjs'), 'unrelated changed pet media');
  await mkdir(path.join(f.scriptsDirectory, '../inject'), { recursive: true });
  await writeFile(path.join(f.scriptsDirectory, '../inject/codex-panel.user.js'), 'changed phrase editor');
  assert.deepEqual(await getCodexRspackRevisions(f), before);
});

test('independent adapters in one source file have independent revisions', async t => {
  const f = await fixture(t), before = await getCodexRspackRevisions(f);
  await replace(f, 'codex-rspack-capabilities.mjs', 'export function rewriteRspackDot(source, context) {', 'export function rewriteRspackDot(source, context) {\n  const changedAdapter = true;');
  const after = await getCodexRspackRevisions(f);
  assert.deepEqual(changed(before, after), ['dot']);
  assert.equal(before.catalog, after.catalog);
  assert.notEqual(before.compose, after.compose, 'overlapping-factory composition uses the updated adapter');
  await replace(f, 'codex-rspack.mjs', "dot: ['isCapable']", "dot: ['isCapable', 'another-marker']");
  const configured = await getCodexRspackRevisions(f);
  assert.deepEqual(changed(after, configured), ['dot']);
  assert.equal(after.catalog, configured.catalog);
  assert.equal(after.compose, configured.compose);
});

test('shared static helpers invalidate their actual dependents', async t => {
  const f = await fixture(t), before = await getCodexRspackRevisions(f);
  await replace(f, 'codex-provider-quota.mjs', 'export function esmSameBinding(ast, left, right) {', 'export function esmSameBinding(ast, left, right) {\n  const changedHelper = true;');
  const update = await getCodexRspackRevisions(f);
  assert.deepEqual(changed(before, update), ['nativeUpdate']);
  assert.equal(before.catalog, update.catalog);
  assert.equal(before.compose, update.compose);
  await replace(f, 'codex-source-ast.mjs', 'export function sourceAst(source, { factory = false, cache: useCache = true } = {}) {', 'export function sourceAst(source, { factory = false, cache: useCache = true } = {}) {\n  const changedParser = true;');
  const parser = await getCodexRspackRevisions(f);
  assert.deepEqual(changed(update, parser), Object.keys(update.features));
  assert.notEqual(update.catalog, parser.catalog);
  assert.notEqual(update.compose, parser.compose);
});
