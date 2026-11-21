import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("local packages advance one shared build number per Tauri build", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-panel-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  const data = path.join(root, "data");
  const cli = path.join(cwd, "node_modules/@tauri-apps/cli");
  await mkdir(cli, { recursive: true });
  await mkdir(path.join(cwd, "scripts"));
  await mkdir(data);
  execFileSync("git", ["init", "--quiet"], { cwd });
  const products = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {
    ...products.scripts, "app:prepare": "node -e \"void 0\" --",
  } }));
  await cp(new URL("../scripts/run-tauri.mjs", import.meta.url), path.join(cwd, "scripts/run-tauri.mjs"));
  await writeFile(path.join(cli, "tauri.js"), `
    const fs = require("node:fs");
    fs.appendFileSync(process.env.RESULTS, JSON.stringify({
      build: process.env.CODEX_PANEL_BUILD_NUMBER, args: process.argv.slice(2)
    }) + "\\n");
  `);
  const output = path.join(data, "results.jsonl");
  const npm = process.env.npm_execpath;
  const run = (args, extra = {}) => {
    const env = { ...process.env, GITHUB_ACTIONS: "", CODEX_PANEL_BUILD_NUMBER: "999",
      RESULTS: output, npm_config_cache: path.join(data, "npm-cache"), ...extra };
    return execFileSync(npm ? process.execPath : "npm", npm ? [npm, "run", ...args] : ["run", ...args],
      { cwd, env, encoding: "utf8", shell: !npm && process.platform === "win32" });
  };
  run(["app:prepare"]);
  run(["tauri", "--", "info"]);
  const direct = ["tauri", "--", "build"];
  assert.match(run(process.platform === "win32" ? direct : ["app:build"]), /Codex Panel local Build 1/);
  assert.match(run(process.platform === "win32" ? direct : ["app:build:local"]), /Codex Panel local Build 2/);
  assert.match(run(["tauri", "--", "-v", "build", "--", "--locked"]), /Codex Panel local Build 3/);
  run(["tauri", "--", "build"], { GITHUB_ACTIONS: "true" });
  const calls = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.build), [undefined, "1", "2", "3", undefined]);
  const cargoArgs = calls[3].args;
  assert.deepEqual(cargoArgs.slice(0, 2), ["-v", "build"]);
  assert.deepEqual(cargoArgs.slice(-2), ["--", "--locked"]);
  if (process.platform === "darwin") {
    for (const { args, build } of calls.slice(1, 3)) {
      assert.deepEqual(JSON.parse(args.at(-1)), { bundle: { macOS: { bundleVersion: build } } });
    }
    assert.equal(cargoArgs[2], "--config");
    assert.deepEqual(JSON.parse(cargoArgs[3]), { bundle: { macOS: { bundleVersion: "3" } } });
  }
  assert.deepEqual(calls.at(-1).args, ["build"]);
});

test("installer prints its build before preparation and streams the same numbered compilation", { skip: process.platform !== "darwin" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-panel-install-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  const cli = path.join(cwd, "node_modules/@tauri-apps/cli");
  await mkdir(cli, { recursive: true });
  await mkdir(data);
  for (const dir of ["scripts", "shared"]) await cp(new URL(`../${dir}/`, import.meta.url), path.join(cwd, dir), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "app:prepare": "node prepare.cjs" } }));
  await writeFile(path.join(cwd, "prepare.cjs"), `
    const fs = require('node:fs');
    const { setTimeout } = require('node:timers/promises');
    (async () => {
      console.log('prepare waiting ' + process.env.CODEX_PANEL_BUILD_NUMBER);
      for (let i = 0; i < 200; i++) {
        if (fs.existsSync(process.env.RELEASE_PREPARE)) return;
        await setTimeout(25);
      }
      process.exitCode = 1;
    })();
  `);
  await writeFile(path.join(cli, "tauri.js"), `
    const fs = require("node:fs"), path = require("node:path");
    const args = process.argv.slice(2);
    const number = JSON.parse(args.at(-1)).bundle.macOS.bundleVersion;
    console.log('compiled ' + process.env.CODEX_PANEL_BUILD_NUMBER + ' bundle ' + number);
    console.error('compile stderr ' + number);
    const target = args[args.indexOf('--target') + 1];
    if (target) {
      const resources = path.join('src-tauri/target', target, 'release/bundle/macos/Codex Panel.app/Contents/Resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, 'codex-panel-launcher.json'), '{"generator":"codex-panel"}');
    }
  `);
  const gate = path.join(data, "release-prepare");
  const env = { ...process.env, GITHUB_ACTIONS: "", CODEX_PANEL_BUILD_NUMBER: "999", RELEASE_PREPARE: gate, npm_config_cache: path.join(data, "npm-cache") };
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'import { buildTauriApp } from "./scripts/install-macos-launcher.mjs"; await buildTauriApp();',
  ], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const lines = [];
  for await (const line of createInterface({ input: child.stdout })) {
    lines.push(line);
    if (line === "prepare waiting 1") {
      assert.equal(lines[0], "Codex Panel local Build 1");
      assert.equal(child.exitCode, null);
      await writeFile(gate, "");
    }
  }
  assert.equal((await closed)[0], 0, stderr);
  assert.ok(lines.includes("prepare waiting 1"));
  assert.ok(lines.includes("compiled 1 bundle 1"));
  assert.match(stderr, /compile stderr 1/);
  const next = execFileSync(process.execPath, ["scripts/run-tauri.mjs", "build"], { cwd, env, encoding: "utf8" });
  assert.match(next, /Codex Panel local Build 2/);
});
