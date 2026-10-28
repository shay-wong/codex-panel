import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("async function download("), source.indexOf("async function extractNodeRuntime("));

async function fixture(t, fetch, timeout = AbortSignal.timeout) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = [];
  const api = vm.runInNewContext(`${functions}; ({download, verifiedNodeArchive})`, {
    fetch, AbortSignal: { timeout }, Buffer, writeFile, rename, rm, path,
    console: { log: value => logs.push(value), error: value => logs.push(value) },
    runtimeCacheDirectory: directory, nodeVersion: "fixture",
    exists: async filename => { try { await readFile(filename); return true; } catch { return false; } },
    sha256: async filename => createHash("sha256").update(await readFile(filename)).digest("hex"),
  });
  return { ...api, directory, logs };
}

test("runtime download retries a disconnected body and atomically installs only the successful bytes", async t => {
  let attempts = 0;
  const f = await fixture(t, async (_url, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    return { ok: true, arrayBuffer: async () => {
      if (++attempts === 1) throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
      return Buffer.from("complete archive");
    } };
  });
  const destination = path.join(f.directory, "runtime.zip");
  await writeFile(`${destination}.download`, "stale partial");
  await f.download("https://fixture.invalid/runtime.zip", destination);
  assert.equal(attempts, 2);
  assert.equal(await readFile(destination, "utf8"), "complete archive");
  await assert.rejects(readFile(`${destination}.download`), { code: "ENOENT" });
  assert.ok(f.logs.some(line => line.includes("UND_ERR_SOCKET")));
  assert.ok(f.logs.some(line => line.includes("Downloaded") && line.includes("16 bytes")));
});

test("a stalled response body is aborted with a bounded number of attempts and no leftover file", async t => {
  let attempts = 0;
  const f = await fixture(t, async (_url, { signal }) => {
    attempts++;
    return { ok: true, arrayBuffer: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) };
  }, milliseconds => {
    assert.equal(milliseconds, 120_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("download timed out")), 1);
    return controller.signal;
  });
  const destination = path.join(f.directory, "runtime.zip");
  await writeFile(`${destination}.download`, "stale partial");
  await assert.rejects(f.download("https://fixture.invalid/runtime.zip", destination), /after 3 attempts.*timed out/);
  assert.equal(attempts, 3);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
  await assert.rejects(readFile(`${destination}.download`), { code: "ENOENT" });
});

test("downloaded runtime archives still require the expected checksum", async t => {
  const f = await fixture(t, async () => ({ ok: true, arrayBuffer: async () => Buffer.from("wrong archive") }));
  await assert.rejects(f.verifiedNodeArchive("runtime.zip", "0".repeat(64)), /Checksum verification failed/);
});
