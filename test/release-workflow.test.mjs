import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8"));
const release = workflow.jobs.release;
const prepareAssets = release.steps.find(step => step.name === "Prepare available release assets").run;
const publish = release.steps.find(step => step.name === "Publish release").run;
const publishPrefix = publish.slice(0, publish.indexOf("gh release create "));
const tag = "v0.5.1-fork";
const dmg = "Codex.Panel_0.5.1-fork_universal.dmg";
const archive = "Codex.Panel_0.5.1-fork_universal.app.tar.gz";
const windows = "Codex.Panel_0.5.1-fork_x86_64-setup.exe";

function releaseRuns(macos, windows, canceled = false) {
  const expression = release.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return vm.runInNewContext(expression, {
    always: () => true,
    cancelled: () => canceled,
    github: { repository: "shay-wong/codex-panel" },
    needs: { "build-macos": { result: macos }, "build-windows": { result: windows } },
  });
}

function run(script, directory, macos, windowsResult, extras = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: directory,
      GITHUB_ENV: path.join(directory, "github-env"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
      GITHUB_REPOSITORY: "shay-wong/codex-panel",
      RELEASE_TAG: tag,
      RELEASE_DMG: dmg,
      RELEASE_ARCHIVE: archive,
      RELEASE_WINDOWS: windows,
      MACOS_RESULT: macos,
      WINDOWS_RESULT: windowsResult,
      WINDOWS_SIGNED: "false",
      ASSET_LIST_FILE: path.join(directory, "asset-list"),
      ...extras,
    },
  });
}

test("platform builds run independently and publication waits for both outcomes", () => {
  assert.equal(workflow.jobs["build-macos"].needs, undefined);
  assert.equal(workflow.jobs["build-windows"].needs, undefined);
  assert.deepEqual(release.needs, ["build-macos", "build-windows"]);
  for (const results of [["success", "success"], ["success", "failure"], ["failure", "success"], ["failure", "failure"]]) {
    assert.equal(releaseRuns(...results), true);
  }
  assert.equal(releaseRuns("success", "failure", true), false);
});

test("Windows failure leaves macOS assets available, while two failed builds stop before publication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-outcomes-"));
  try {
    const mac = path.join(directory, "platform-assets", "macos");
    await mkdir(mac, { recursive: true });
    for (const name of ["latest.json", dmg, archive, `${archive}.sig`]) await writeFile(path.join(mac, name), "fixture");
    const result = run(prepareAssets, directory, "success", "failure");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(directory, "release-assets", dmg), "utf8"), "fixture");
    const failed = run(prepareAssets, directory, "failure", "failure");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Neither platform produced release assets/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication rejects a tag outside main even when a platform built successfully", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-base-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "main");
    const main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "unmerged");
    await mkdir(path.join(directory, "scripts"));
    await writeFile(path.join(directory, "scripts", "prepare-fork-release.mjs"), "console.log('prepared fixture');\n");
    const source = release.steps.find(step => step.name === "Prepare release notes").run;
    const rejected = run(source, directory, "failure", "success", { GITHUB_SHA: git("rev-parse", "HEAD") });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stdout, /prepared fixture/);
    const accepted = run(source, directory, "success", "failure", { GITHUB_SHA: main });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /prepared fixture/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication selects only completed platforms and describes unsigned Windows accurately", async () => {
  assert.ok(publishPrefix.length > 0);
  for (const [macos, win, expected] of [
    ["success", "failure", ["latest.json", dmg, archive, `${archive}.sig`]],
    ["failure", "success", ["latest.json", windows, `${windows}.sig`]],
    ["success", "success", ["latest.json", dmg, archive, `${archive}.sig`, windows, `${windows}.sig`]],
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panel-release-selection-"));
    try {
      await writeFile(path.join(directory, "release-notes.md"), "Fixture notes\n");
      const result = run(`${publishPrefix}\nprintf '%s\\n' "\${assets[@]}" > "$ASSET_LIST_FILE"`, directory, macos, win);
      assert.equal(result.status, 0, result.stderr);
      const selected = (await readFile(path.join(directory, "asset-list"), "utf8")).trim().split("\n").map(file => path.basename(file));
      assert.deepEqual(selected, expected);
      const notes = await readFile(path.join(directory, "release-notes.md"), "utf8");
      if (win === "success") assert.match(notes, /not Authenticode-signed/);
      if (macos === "failure") assert.match(notes, /No macOS package or updater/);
      if (win === "failure") assert.match(notes, /No Windows package or updater/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
