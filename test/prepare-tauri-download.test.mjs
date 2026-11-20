import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const hashed = [];
  const api = vm.runInNewContext(`${functions}; ({download, verifiedNodeArchive, prepareRuntimePackage})`, {
    fetch, AbortSignal: { timeout }, Buffer, createHash, mkdir, process, readFile, writeFile, rename, rm, path,
    console: { log: value => logs.push(value), error: value => logs.push(value) },
    runtimeCacheDirectory: directory, nodeVersion: "fixture",
    projectRoot: directory, extractionDirectory: path.join(directory, "extracted"),
    run: (command, args) => execFileSync(command, args),
    exists: async filename => { try { await readFile(filename); return true; } catch { return false; } },
    sha256: async filename => {
      hashed.push(filename);
      return createHash("sha256").update(await readFile(filename)).digest("hex");
    },
  });
  return { ...api, directory, logs, hashed };
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
  await writeFile(path.join(f.directory, "runtime.zip"), "damaged cached archive");
  await assert.rejects(f.verifiedNodeArchive("runtime.zip", "0".repeat(64)), /Checksum verification failed/);
});

test("a valid cached runtime archive is hashed once without downloading", async t => {
  const f = await fixture(t, async () => assert.fail("valid cached archives must not be downloaded again"));
  const archivePath = path.join(f.directory, "runtime.zip"), contents = "verified cached runtime";
  await writeFile(archivePath, contents);
  await f.verifiedNodeArchive("runtime.zip", createHash("sha256").update(contents).digest("hex"));
  assert.deepEqual(f.hashed, [archivePath]);
});

test("runtime extraction keeps only the executable and license", async t => {
  const extractionFunctions = source.slice(source.indexOf("async function extractNodeRuntime("), source.indexOf("async function copyApplicationResources("));
  for (const platform of ["darwin", "linux", "win"]) await t.test(platform, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panel-runtime-extraction-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runtimeName = `node-vfixture-${platform}-${platform === "darwin" ? "arm64" : "x64"}`;
    const contentsDirectory = path.join(root, "contents"), runtimeDirectory = path.join(contentsDirectory, runtimeName);
    const executableName = platform === "win" ? "node.exe" : "bin/node";
    await mkdir(path.join(runtimeDirectory, "bin"), { recursive: true });
    await mkdir(path.join(runtimeDirectory, "include"));
    await writeFile(path.join(runtimeDirectory, executableName), "fixture executable");
    await writeFile(path.join(runtimeDirectory, "LICENSE"), "fixture license");
    await writeFile(path.join(runtimeDirectory, "include", "unused.h"), "not needed in the packaged runtime");
    const archivePath = path.join(root, "runtime.tar.gz");
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "/usr/bin/tar";
    execFileSync(tar, ["-czf", archivePath, "-C", contentsDirectory, runtimeName]);
    const extractionDirectory = path.join(root, "extracted"), binariesDirectory = path.join(root, "binaries"), resourcesDirectory = path.join(root, "resources");
    const api = vm.runInNewContext(`${extractionFunctions}; ({extractNodeRuntime, prepareLinuxNodeRuntime, prepareWindowsNodeRuntime})`, {
      path, mkdir, rm, chmod, copyFile, link, process: { env: { SystemRoot: "fixture-windows" } },
      nodeVersion: "fixture", nodeArchiveSha256: { arm64: "fixture" },
      windowsTarget: "x86_64-pc-windows-msvc", linuxTarget: "x86_64-unknown-linux-gnu",
      windowsNodeArchiveName: `${runtimeName}.zip`, windowsNodeArchiveSha256: "fixture",
      linuxNodeArchiveName: `${runtimeName}.tar.gz`, linuxNodeArchiveSha256: "fixture",
      extractionDirectory, binariesDirectory, resourcesDirectory,
      verifiedNodeArchive: async () => ({ archivePath }),
      run: (command, args) => {
        assert.match(command, /(?:^|[\\/])tar(?:\.exe)?$/);
        return execFileSync(tar, args, { encoding: "utf8" });
      },
    });
    let destination;
    if (platform === "darwin") destination = await api.extractNodeRuntime("arm64");
    else {
      await (platform === "win" ? api.prepareWindowsNodeRuntime() : api.prepareLinuxNodeRuntime());
      destination = path.join(extractionDirectory, platform === "win" ? "win-x64" : "linux-x64", runtimeName);
    }
    assert.equal(await readFile(path.join(destination, executableName), "utf8"), "fixture executable");
    assert.equal(await readFile(path.join(destination, "LICENSE"), "utf8"), "fixture license");
    await assert.rejects(stat(path.join(destination, "include", "unused.h")), { code: "ENOENT" });
  });
});

test("runtime integrity manifests remain enabled only for Windows and Linux", async t => {
  const integrityFunctions = source.slice(source.indexOf("async function sha256("), source.indexOf("async function download("));
  for (const target of ["universal-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) await t.test(target, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panel-runtime-integrity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const resourcesDirectory = path.join(root, "resources"), binariesDirectory = path.join(root, "binaries");
    await mkdir(resourcesDirectory); await mkdir(binariesDirectory);
    await writeFile(path.join(resourcesDirectory, "payload.txt"), "runtime payload");
    const nodeBinary = target.includes("windows") ? "node-x86_64-pc-windows-msvc.exe" : target.includes("linux") ? "codex-panel-node-x86_64-unknown-linux-gnu" : "node-universal-apple-darwin";
    await writeFile(path.join(binariesDirectory, nodeBinary), "node fixture");
    const api = vm.runInNewContext(`${integrityFunctions}; ({writeRuntimeIntegrityManifest})`, {
      createHash, readFile, writeFile, readdir, lstat, rm, path, target, resourcesDirectory, binariesDirectory,
      windowsTarget: "x86_64-pc-windows-msvc", linuxTarget: "x86_64-unknown-linux-gnu",
    });
    await api.writeRuntimeIntegrityManifest();
    const manifestPath = path.join(resourcesDirectory, "runtime-integrity.json");
    if (target.endsWith("apple-darwin")) {
      await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
      return;
    }
    assert.deepEqual(JSON.parse(await readFile(manifestPath)), { version: 1, files: [
      { path: target.includes("windows") ? "node.exe" : "codex-panel-node", sha256: createHash("sha256").update("node fixture").digest("hex") },
      { path: "payload.txt", sha256: createHash("sha256").update("runtime payload").digest("hex") },
    ] });
  });
});

test("missing native bindings use the locked archive and verify integrity before extraction", async t => {
  let archive;
  let downloads = 0;
  const f = await fixture(t, async url => {
    assert.equal(url, "https://fixture.invalid/binding.tgz");
    downloads++;
    return { ok: true, arrayBuffer: async () => archive };
  });
  const name = "@oxc-parser/binding-darwin-x64";
  const packageDirectory = path.join(f.directory, "fixture", "package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ name, version: "0.153.0" }));
  const archivePath = path.join(f.directory, "fixture.tgz");
  execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(packageDirectory), "package"]);
  archive = await readFile(archivePath);
  const lockPath = path.join(f.directory, "package-lock.json");
  const entry = { version: "0.153.0", resolved: "https://fixture.invalid/binding.tgz", integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` };
  const writeLock = () => writeFile(lockPath, JSON.stringify({ packages: { [`node_modules/${name}`]: entry } }));
  await writeLock();
  const extracted = await f.prepareRuntimePackage(name, "0.153.0");
  assert.equal(JSON.parse(await readFile(path.join(extracted, "package.json"), "utf8")).name, name);
  await f.prepareRuntimePackage(name, "0.153.0");
  assert.equal(downloads, 1);
  await assert.rejects(f.prepareRuntimePackage(name, "0.152.0"), /Missing locked runtime dependency/);
  entry.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  await writeLock();
  await assert.rejects(f.prepareRuntimePackage(name, "0.153.0"), /Integrity verification failed/);
});
