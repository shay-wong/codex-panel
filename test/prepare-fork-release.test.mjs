import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import yaml from "js-yaml";
import { archivePublishedChangelogs, prepareForkRelease } from "../scripts/prepare-fork-release.mjs";

test("a new tag prepares build versions and only new bilingual notes without a version commit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "panel-tag-release-"));
  try {
    const files = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];
    for (const file of files) cpSync(new URL(`../${file}`, import.meta.url), path.join(root, file), { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    const read = (file) => readFileSync(path.join(root, file), "utf8");
    const json = (file) => JSON.parse(read(file));
    const changelogs = [["CHANGELOG.md", "Unreleased"], ["CHANGELOG.zh-CN.md", "未发布"]];
    for (const [file, heading] of changelogs) writeFileSync(path.join(root, file), `# Changes\n\n## ${heading}\n\n- Already released\n`);
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
    git("tag", "v8.0.0-fork");
    for (const [file] of changelogs) writeFileSync(path.join(root, file), `${read(file)}\n- New change\n  with detail\n`);
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "change");
    git("tag", "v8.0.1-fork");
    const head = git("rev-parse", "HEAD");
    const before = files.map(read);
    const notesPath = path.join(root, "notes.md");
    assert.throws(() => prepareForkRelease(root, "v8.0.1", notesPath), /Release tag/);
    assert.deepEqual(files.map(read), before);
    const metadata = prepareForkRelease(root, "v8.0.1-fork", notesPath);
    const cargo = parse(read("src-tauri/Cargo.toml"));
    const lock = parse(read("src-tauri/Cargo.lock"));
    for (const version of [json("package.json").version, json("package-lock.json").version, json("package-lock.json").packages[""].version,
      json("src-tauri/tauri.conf.json").version, cargo.package.version, lock.package.find((entry) => entry.name === cargo.package.name).version]) {
      assert.equal(version, "8.0.1-fork");
    }
    assert.deepEqual(cargo.dependencies, parse(before[2]).dependencies);
    assert.deepEqual(lock.package.filter((entry) => entry.name !== cargo.package.name), parse(before[3]).package.filter((entry) => entry.name !== cargo.package.name));
    for (const [file, original] of [[files[2], before[2]], [files[3], before[3]]]) {
      assert.equal(read(file).replace('version = "8.0.1-fork"', `version = "${parse(before[2]).package.version}"`), original, "preserve Cargo comments and formatting");
    }
    assert.equal(metadata.archive, "Codex.Panel_8.0.1-fork_universal.app.tar.gz");
    const notes = read("notes.md");
    assert.equal(notes.match(/New change\n  with detail/g)?.length, 2);
    assert.ok(!notes.includes("Already released"));
    assert.ok(notes.includes("v8.0.0-fork...v8.0.1-fork"));
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release workflow archives bilingual changelogs, preserves newer entries, and is repeatable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "panel-version-sync-"));
  try {
    const repo = path.join(root, "workspace");
    const remote = path.join(root, "remote.git");
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "scripts/prepare-fork-release.mjs", "scripts/release-metadata.mjs", "CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
      cpSync(new URL(`../${file}`, import.meta.url), path.join(repo, file), { recursive: true });
    }
    // 只复制脚本实际使用的解析器，不读取用户配置或启动真实服务。
    cpSync(new URL("../node_modules/smol-toml", import.meta.url), path.join(repo, "node_modules/smol-toml"), { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    const changelogs = [["CHANGELOG.md", "Unreleased"], ["CHANGELOG.zh-CN.md", "未发布"]];
    const read = file => readFileSync(path.join(repo, file), "utf8");
    for (const [file, heading] of changelogs) writeFileSync(path.join(repo, file), `# Changes\n\n## ${heading}\n\n- Earlier release\n`);
    git("add", ".");
    git("commit", "-qm", "baseline");
    git("tag", "v8.0.0-fork");
    for (const [file] of changelogs) writeFileSync(path.join(repo, file), `${read(file)}\n- Current release\n  with detail\n`);
    git("add", ".");
    git("commit", "-qm", "current release");
    git("tag", "v8.0.1-fork");
    for (const [file, heading] of changelogs) writeFileSync(path.join(repo, file), read(file).replace(`## ${heading}\n`, `## ${heading}\n\n- Future release\n`));
    git("add", ".");
    git("commit", "-qm", "main advances during packaging");
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    writeFileSync(path.join(repo, "unrelated.txt"), "do not commit");
    const workflow = yaml.load(readFileSync(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8"));
    assert.equal(workflow.jobs["sync-version"].needs, "release");
    const script = workflow.jobs["sync-version"].steps.find(step => step.name === "Commit published version to main").run;
    const githubEnv = path.join(root, "github-env");
    const run = tag => execFileSync("bash", ["-c", script], {
      cwd: repo,
      // 子进程会写 Actions 环境文件，必须隔离，避免模拟版本污染真实发布产物名。
      env: { ...process.env, RELEASE_TAG: tag, RUNNER_TEMP: root, GITHUB_ENV: githubEnv, GITHUB_STEP_SUMMARY: path.join(root, "summary.md") },
      stdio: "pipe",
    });
    run("v8.0.1-fork");
    assert.equal(readFileSync(githubEnv, "utf8"), "RELEASE_DMG=Codex.Panel_8.0.1-fork_universal.dmg\nRELEASE_ARCHIVE=Codex.Panel_8.0.1-fork_universal.app.tar.gz\n");
    const head = git("rev-parse", "HEAD");
    assert.equal(git("rev-parse", "origin/main"), head);
    assert.deepEqual(git("diff-tree", "--no-commit-id", "--name-only", "-r", head).split("\n").sort(), ["CHANGELOG.md", "CHANGELOG.zh-CN.md", "package-lock.json", "package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
    assert.match(git("log", "-1", "--format=%s"), /\[skip ci\]/);
    assert.equal(JSON.parse(readFileSync(path.join(repo, "package.json"))).version, "8.0.1-fork");
    for (const [file, heading] of changelogs) {
      assert.equal(read(file), `# Changes\n\n## ${heading}\n\n- Future release\n\n## 8.0.1-fork\n\n- Current release\n  with detail\n\n## 8.0.0-fork\n\n- Earlier release\n\n`);
    }
    run("v8.0.1-fork");
    run("v8.0.0-fork");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.match(git("status", "--short"), /\?\? unrelated.txt/);
    // 上一版已经归档的内容也要参与去重，不能在新版说明中重新出现。
    git("tag", "v8.0.2-fork");
    for (const [file, heading] of changelogs) writeFileSync(path.join(repo, file), read(file).replace(`## ${heading}\n`, `## ${heading}\n\n- Next release\n\n- Earlier release\n`));
    const notesPath = path.join(root, "next-notes.md");
    prepareForkRelease(repo, "v8.0.3-fork", notesPath);
    const notes = readFileSync(notesPath, "utf8");
    assert.equal(notes.match(/Next release/g)?.length, 2);
    assert.ok(!notes.includes("Future release"));
    assert.ok(!notes.includes("Current release"));
    assert.ok(!notes.includes("Earlier release"));
    for (const [file] of changelogs) writeFileSync(path.join(repo, file), read(file).replace("\n- Next release\n\n- Earlier release\n", ""));
    archivePublishedChangelogs(repo, "v8.0.2-fork");
    for (const [file, heading] of changelogs) {
      assert.ok(read(file).includes(`## ${heading}\n\n## 8.0.2-fork\n\n- Future release`));
      assert.equal(read(file).match(/## 8.0.1-fork/g)?.length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
