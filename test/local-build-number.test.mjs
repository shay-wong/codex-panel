import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
