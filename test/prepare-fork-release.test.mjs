import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { prepareForkRelease } from "../scripts/prepare-fork-release.mjs";

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
