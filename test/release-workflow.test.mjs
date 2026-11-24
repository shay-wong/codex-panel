import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8"));
const buildMacos = workflow.jobs["build-macos"];
const packageMacos = workflow.jobs["package-macos"];
const release = workflow.jobs.release;
const publish = release.steps.find(step => step.name === "Publish release").run;
const publishPrefix = publish.slice(0, publish.indexOf("gh release create "));
const tag = "v0.5.1-fork";
const dmg = "Codex.Panel_0.5.1-fork_universal.dmg";
const archive = "Codex.Panel_0.5.1-fork_universal.app.tar.gz";
const windows = "Codex.Panel_0.5.1-fork_x86_64-setup.exe";

function expressionValue(source, context) {
  return vm.runInNewContext(source.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context);
}

function releaseRuns(macos, windows, canceled = false) {
  return expressionValue(release.if, {
    always: () => true,
    cancelled: () => canceled,
    github: { repository: "shay-wong/codex-panel" },
    needs: { "package-macos": { result: macos }, "build-windows": { result: windows } },
  });
}

function run(script, directory, extras = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      RUNNER_TEMP: directory,
      GITHUB_ENV: path.join(directory, "github-env"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
      GITHUB_REPOSITORY: "shay-wong/codex-panel",
      RELEASE_TAG: tag,
      RELEASE_DMG: dmg,
      RELEASE_ARCHIVE: archive,
      RELEASE_WINDOWS: windows,
      WINDOWS_SIGNED: "false",
      ASSET_LIST_FILE: path.join(directory, "asset-list"),
      ...extras,
    },
  });
}

test("macOS packaging follows the build and publication requires both packaged platforms", () => {
  assert.equal(buildMacos.needs, undefined);
  assert.equal(workflow.jobs["build-windows"].needs, undefined);
  assert.equal(packageMacos.needs, "build-macos");
  assert.deepEqual(release.needs, ["package-macos", "build-windows"]);
  for (const macos of ["success", "failure", "cancelled", "skipped"]) {
    for (const windowsResult of ["success", "failure", "cancelled", "skipped"]) {
      assert.equal(releaseRuns(macos, windowsResult), macos === "success" && windowsResult === "success");
    }
  }
  assert.equal(releaseRuns("success", "success", true), false);
  for (const job of [buildMacos, packageMacos]) {
    for (const attempt of ["1", "2", "3"]) {
      assert.equal(expressionValue(job["runs-on"], { github: { run_attempt: attempt } }), attempt === "1" ? "macos-15" : "macos-15-intel");
    }
  }
});

test("macOS packaging restores the build checkpoint without installing or compiling the app again", () => {
  const buildUpload = buildMacos.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  const packageDownload = packageMacos.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(packageDownload.with.name, buildUpload.with.name);
  assert.equal(buildUpload.with.name, "macos-build-${{ github.sha }}");
  assert.equal(buildUpload.with.path, "${{ runner.temp }}/macos-build");
  assert.equal(packageDownload.with.path, buildUpload.with.path);
  assert.equal(buildUpload.with["compression-level"], 0);
  const buildScripts = buildMacos.steps.map(step => step.run ?? "").join("\n");
  assert.equal(buildScripts.match(/\bnpm run tauri -- build\b/g)?.length, 1);
  assert.equal(buildMacos.env.CODEX_PANEL_UPDATER_PUBLIC_KEY, "${{ vars.CODEX_PANEL_UPDATER_PUBLIC_KEY }}");
  assert.match(buildScripts.slice(0, buildScripts.indexOf("npm run tauri -- build")), /test -n "\$CODEX_PANEL_UPDATER_PUBLIC_KEY"/);
  const packageScripts = packageMacos.steps.map(step => step.run ?? "").join("\n");
  assert.doesNotMatch(packageScripts, /\bnpm ci\b|\bcargo\b|\brustup\b|\btauri\s+build\b|\bapp:prepare\b/);
  assert.match(packageScripts, /npm install --prefix "\$RUNNER_TEMP\/release-tools"/);
  assert.match(packageScripts, /create-macos-updater\.mjs.*"\$RUNNER_TEMP\/release-tools\/node_modules\/\.bin\/tauri"/);
  const packageUpload = packageMacos.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(packageUpload.with.name, "macos-release-${{ github.sha }}");
  assert.equal(packageUpload.with["compression-level"], 0);
});

test("the tar checkpoint preserves App executables, symlinks and notes across packaging retries", {
  skip: process.platform === "win32" ? "macOS App permissions require a POSIX filesystem" : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-checkpoint-"));
  try {
    const workspace = path.join(directory, "workspace");
    const buildTemp = path.join(directory, "build");
    const packageTemp = path.join(directory, "packaging");
    const app = path.join(workspace, "src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Panel.app");
    await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(buildTemp);
    const executable = path.join(app, "Contents/MacOS/panel");
    await writeFile(executable, "fixture executable\n");
    await chmod(executable, 0o755);
    await symlink("panel", path.join(app, "Contents/MacOS/panel-link"));
    await writeFile(path.join(buildTemp, "release-notes.md"), "Fixture release notes\n");
    const preserve = buildMacos.steps.find(step => step.name === "Preserve unsigned App for packaging").run;
    const checkpoint = run(preserve, workspace, { RUNNER_TEMP: buildTemp });
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    await cp(path.join(buildTemp, "macos-build"), path.join(packageTemp, "macos-build"), { recursive: true });
    await rm(workspace, { recursive: true });
    const restore = packageMacos.steps.find(step => step.name === "Restore unsigned App and release notes").run;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const restored = run(restore, packageTemp);
      assert.equal(restored.status, 0, restored.stderr);
      const restoredExecutable = path.join(packageTemp, "dmg-content/Codex Panel.app/Contents/MacOS/panel");
      assert.equal(await readFile(restoredExecutable, "utf8"), "fixture executable\n");
      assert.equal((await stat(restoredExecutable)).mode & 0o777, 0o755);
      assert.equal(await readlink(`${restoredExecutable}-link`), "panel");
      assert.equal(await readFile(path.join(packageTemp, "release-assets/release-notes.md"), "utf8"), "Fixture release notes\n");
      await rm(path.join(packageTemp, "dmg-content"), { recursive: true });
      await rm(path.join(packageTemp, "release-assets"), { recursive: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication rejects a tag outside main", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-base-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "main");
    const main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "unmerged");
    const source = release.steps.find(step => step.name === "Verify release source").run;
    const rejected = run(source, directory, { GITHUB_SHA: git("rev-parse", "HEAD") });
    assert.notEqual(rejected.status, 0);
    const accepted = run(source, directory, { GITHUB_SHA: main });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication downloads both platform artifacts directly and selects exactly six assets", async () => {
  const download = release.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(download.with, {
    pattern: "*-release-${{ github.sha }}", "merge-multiple": true, path: "${{ runner.temp }}/release-assets",
  });
  assert.doesNotMatch(release.steps.map(step => step.run ?? "").join("\n"), /\bnpm ci\b/);
  assert.ok(publishPrefix.length > 0);
  const expected = ["latest.json", dmg, archive, `${archive}.sig`, windows, `${windows}.sig`];
  for (const signed of [false, true]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-selection-"));
    try {
      await mkdir(path.join(directory, "release-assets"));
      const notesPath = path.join(directory, "release-assets/release-notes.md");
      await writeFile(notesPath, "Fixture notes\n");
      const result = run(`${publishPrefix}\nprintf '%s\\n' "\${assets[@]}" > "$ASSET_LIST_FILE"`, directory, { WINDOWS_SIGNED: String(signed) });
      assert.equal(result.status, 0, result.stderr);
      const selected = (await readFile(path.join(directory, "asset-list"), "utf8")).trim().split("\n");
      assert.deepEqual(selected, expected.map(file => path.join(directory, "release-assets", file)));
      const notes = await readFile(notesPath, "utf8");
      assert.match(notes, /^Fixture notes\n/);
      assert.match(notes, /macOS 通用版，支持 Apple Silicon 与 Intel/);
      assert.match(notes, signed ? /安装器带 Authenticode 签名/ : /安装器未进行 Authenticode 签名/);
      assert.ok(notes.includes(`/blob/${tag}/CHANGELOG.md`));
      assert.doesNotMatch(notes, /CHANGELOG\.zh-CN\.md|Universal macOS build/);
      assert.doesNotMatch(notes, /No (?:macOS|Windows) package or updater/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
