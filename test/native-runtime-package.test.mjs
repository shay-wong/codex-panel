import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { installRuntime, panelctlLauncher } from "../scripts/install-macos-launcher.mjs";
import { verifyRuntimeIntegrity } from "../scripts/runtime-integrity.mjs";

test("installer stages the built native payload and its CLI preserves paths with spaces", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-native-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Codex Panel.app");
  const resources = path.join(app, "Contents/Resources/app");
  await mkdir(path.join(resources, "skills/manage-panel"), { recursive: true });
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(path.join(resources, "skills/manage-panel/SKILL.md"), "fixture");
  await writeFile(path.join(app, "Contents/MacOS/codex-panel-runtime"),
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_PANEL_RUNTIME_FILE" "$@"\n');
  const runtime = path.join(root, "installed runtime");
  await installRuntime(runtime, { sourceApp: app });
  assert.deepEqual((await readdir(runtime)).sort(), [".codex-panel-managed.json", "codex-panel-runtime", "skills"]);
  if (process.platform === "win32") return;
  const wrapper = path.join(root, "panelctl");
  const data = path.join(root, "isolated data");
  await writeFile(wrapper, panelctlLauncher(runtime, data));
  await chmod(wrapper, 0o755);
  const result = spawnSync(wrapper, ["issue", "get", "task with spaces"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [path.join(data, "launcher-runtime.json"), "ctl", "issue", "get", "task with spaces"]);
});

test("packaged Unix CLI wrappers parse and Linux uses the launcher data directory", async () => {
  const source = await readFile(new URL("../scripts/prepare-rust-app.mjs", import.meta.url), "utf8");
  const literal = source.match(/const wrapper = (`[\s\S]*?`);/)[1];
  for (const mac of [true, false]) {
    const wrapper = vm.runInNewContext(literal, { mac });
    assert.match(wrapper, /codex-panel-runtime" ctl "\$@"/);
    if (!mac) assert.match(wrapper, /\/Codex Panel\/data\/launcher-runtime\.json/);
    if (process.platform !== "win32") {
      const result = spawnSync("/bin/sh", ["-n"], { input: wrapper, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test("native preparation packages only assets and hashes the built sidecar", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-native-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "fixture-bin", "dist/web", "inject", "skills"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, "package.json"), '{"version":"0.0.0-test"}');
  await writeFile(path.join(root, "dist/web/index.html"), "fixture");
  await writeFile(path.join(root, "inject/codex-panel.user.js"), "fixture");
  await writeFile(path.join(root, "scripts/prepare-rust-app.mjs"),
    await readFile(new URL("../scripts/prepare-rust-app.mjs", import.meta.url)));
  await writeFile(path.join(root, "fixture-tool"), "fixture tool");
  await writeFile(path.join(root, "fixture-license"), "fixture license");
  await writeFile(path.join(root, "scripts/prepare-codex-delta.mjs"),
    `export async function ensureCodexDeltaTool({projectRoot}) { return {binaryPath:projectRoot+'/fixture-tool',licensePath:projectRoot+'/fixture-license'}; }`);
  await writeFile(path.join(root, "scripts/prepare-codex-transport.mjs"),
    `export async function ensureCodexTransport({projectRoot,target}) { if (!target) throw new Error('missing transport target'); return {binaryPath:projectRoot+'/fixture-tool'}; }`);
  const cargo = path.join(root, "fixture-bin/cargo");
  await writeFile(cargo, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const target=args[args.indexOf('--target')+1],directory=path.join(process.cwd(),'runtime/target',target,'release');
fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'codex-panel-runtime'),'native fixture');
`);
  await chmod(cargo, 0o755);
  const result = spawnSync(process.execPath, ["scripts/prepare-rust-app.mjs"], {
    cwd: root, encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "", GITHUB_ACTIONS: "",
      CARGO_TARGET_DIR: "", PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const resources = path.join(root, "src-tauri/resources");
  assert.deepEqual((await readdir(path.join(resources, "app"))).sort(),
    process.platform === "darwin" ? ["dist", "inject", "skills", "tools"] : ["dist", "inject", "skills"]);
  const manifest = JSON.parse(await readFile(path.join(resources, "runtime-integrity.json"), "utf8"));
  assert.ok(manifest.files.some(entry => entry.path === "codex-panel-runtime"
    && entry.sha256 === createHash("sha256").update("native fixture").digest("hex")));
  const marker = JSON.parse(await readFile(path.join(resources, "codex-panel-launcher.json"), "utf8"));
  assert.equal(marker.runtime, "rust");
});

test("package verification detects post-prepare changes to the sidecar or resources", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-native-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "Resources"), runtime = path.join(root, "MacOS/codex-panel-runtime");
  await mkdir(resources);
  await mkdir(path.dirname(runtime));
  await writeFile(runtime, "signed native binary");
  await writeFile(path.join(resources, "asset.js"), "resource");
  const hash = value => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(resources, "runtime-integrity.json"), JSON.stringify({ version: 1, files: [
    { path: "codex-panel-runtime", sha256: hash("signed native binary") },
    { path: "asset.js", sha256: hash("resource") },
  ] }));
  await verifyRuntimeIntegrity(resources, runtime);
  await writeFile(runtime, "re-signed native binary");
  await assert.rejects(verifyRuntimeIntegrity(resources, runtime), /mismatch: codex-panel-runtime/);
  await writeFile(runtime, "signed native binary");
  await writeFile(path.join(resources, "asset.js"), "changed resource");
  await assert.rejects(verifyRuntimeIntegrity(resources, runtime), /mismatch: asset.js/);
});
