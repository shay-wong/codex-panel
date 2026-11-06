import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureCodexTransport } from '../scripts/prepare-codex-transport.mjs';
import { downloadCodexFile } from '../scripts/codex-update-transport.mjs';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const macOS = process.platform === 'darwin';
const payload = Buffer.from('native URLSession transfer\n'.repeat(8192));
let root, helper, server, baseURL;

before(async () => {
  if (!macOS) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-transport-test-'));
  helper = path.join(root, 'CodexTransportTest');
  await execute('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-D', 'CODEX_TRANSPORT_TESTING', path.join(projectRoot, 'scripts/codex-update-transport.swift'), '-o', helper]);
  server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: baseURL.replace('127.0.0.1', 'localhost') + '/full' }).end();
      return;
    }
    if (request.url === '/metadata') {
      response.writeHead(200);
      response.end('<rss/>');
      return;
    }
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    if (request.url === '/bad-range') {
      response.writeHead(206, { 'Content-Range': `bytes ${offset + 1}-${payload.length - 1}/${payload.length}`, 'Content-Length': payload.length - offset });
      response.end(payload.subarray(offset));
      return;
    }
    const ranged = offset > 0 && request.url !== '/full';
    const start = ranged ? offset : 0;
    response.writeHead(ranged ? 206 : 200, {
      'Content-Length': payload.length - start,
      ...(ranged ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
    });
    if (request.url !== '/slow') {
      response.end(payload.subarray(start));
      return;
    }
    let sent = start;
    const timer = setInterval(() => {
      const next = Math.min(payload.length, sent + 8192);
      response.write(payload.subarray(sent, next));
      sent = next;
      if (sent === payload.length) { clearInterval(timer); response.end(); }
    }, 35);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('URLSession downloads 200 responses and unknown-length metadata', { skip: !macOS }, async () => {
  const destination = path.join(root, 'full');
  const progress = [];
  await downloadCodexFile({ url: `${baseURL}/full`, destination, expectedLength: payload.length, onProgress: value => progress.push(value) }, { helperPath: helper });
  assert.deepEqual(await readFile(destination), payload);
  assert.equal(progress.at(-1), payload.length);
  const metadata = path.join(root, 'metadata');
  await downloadCodexFile({ url: `${baseURL}/metadata`, destination: metadata, expectedLength: 0 }, { helperPath: helper });
  assert.equal(await readFile(metadata, 'utf8'), '<rss/>');
});

test('URLSession resumes 206 and overwrites when a range request receives 200', { skip: !macOS }, async () => {
  for (const route of ['/range', '/full']) {
    const destination = path.join(root, route.slice(1) + '-resumed');
    await writeFile(destination, payload.subarray(0, 12000));
    await downloadCodexFile({ url: baseURL + route, destination, expectedLength: payload.length, offset: 12000 }, { helperPath: helper });
    assert.deepEqual(await readFile(destination), payload);
  }
});

test('SIGTERM retains partial bytes and the next transfer resumes them', { skip: !macOS }, async () => {
  const destination = path.join(root, 'paused');
  const controller = new AbortController();
  await assert.rejects(downloadCodexFile({ url: `${baseURL}/slow`, destination, expectedLength: payload.length,
    signal: controller.signal, onProgress: value => { if (value >= 16384) controller.abort(new Error('paused')); },
  }, { helperPath: helper }), /paused/);
  const partial = (await stat(destination)).size;
  assert.ok(partial >= 16384 && partial < payload.length);
  await downloadCodexFile({ url: `${baseURL}/range`, destination, expectedLength: payload.length, offset: partial }, { helperPath: helper });
  assert.deepEqual(await readFile(destination), payload);
});

test('URLSession rejects invalid range responses and redirects outside allowed hosts', { skip: !macOS }, async () => {
  const destination = path.join(root, 'rejected');
  await writeFile(destination, payload.subarray(0, 12000));
  await assert.rejects(downloadCodexFile({ url: `${baseURL}/bad-range`, destination, expectedLength: payload.length, offset: 12000 }, { helperPath: helper }), /Content-Range/);
  assert.deepEqual(await readFile(destination), payload.subarray(0, 12000));
  await assert.rejects(downloadCodexFile({ url: `${baseURL}/redirect`, destination, expectedLength: payload.length }, { helperPath: helper }), /outside the official HTTPS/);
});

test('production universal helper rejects loopback URLs', { skip: !macOS }, async () => {
  const { binaryPath } = await ensureCodexTransport({ projectRoot, cacheDirectory: path.join(root, 'production') });
  const { stdout } = await execute('/usr/bin/lipo', ['-archs', binaryPath]);
  assert.match(stdout, /x86_64/);
  assert.match(stdout, /arm64/);
  await execute('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', binaryPath]);
  await assert.rejects(downloadCodexFile({ url: `${baseURL}/full`, destination: path.join(root, 'must-not-exist'), expectedLength: payload.length }, { helperPath: binaryPath }), /OFFICIAL_HTTPS_URL/);
});
