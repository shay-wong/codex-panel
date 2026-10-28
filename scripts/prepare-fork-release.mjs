#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { releaseMetadata } from "./release-metadata.mjs";

function changelogEntries(content) {
  return content.split(/\n(?=- )/).map(entry => entry.split(/^## /m)[0].trim()).filter(entry => entry.startsWith("- "));
}

export function prepareForkRelease(root, tag, notesPath) {
  const version = tag?.startsWith("v") ? tag.slice(1) : "";
  const metadata = releaseMetadata(version, tag, ["arm64", "x86_64"]);
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const json = (file) => JSON.parse(read(file));
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  const tauri = json("src-tauri/tauri.conf.json");
  const cargo = parse(read("src-tauri/Cargo.toml"));
  const cargoLock = parse(read("src-tauri/Cargo.lock"));
  const launcher = cargoLock.package.find((entry) => entry.name === cargo.package.name);
  assert.ok(launcher, "Launcher package missing from Cargo.lock");
  pkg.version = lock.version = lock.packages[""].version = tauri.version = cargo.package.version = launcher.version = version;

  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const previous = git("tag", "--merged", "HEAD", "--sort=-version:refname")
    .split("\n").find((value) => value !== tag && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-fork$/.test(value));
  const entries = (content, heading) => {
    const section = content.split(`## ${heading}\n`)[1]?.split(/^## /m)[0] || "";
    return changelogEntries(section);
  };
  const notes = [["CHANGELOG.zh-CN.md", "未发布", "更新内容"], ["CHANGELOG.md", "Unreleased", "Changes"]]
    .map(([file, heading, title]) => {
      const current = read(file);
      // 历史条目可能仍在未发布段，也可能已归档；两种情况都不能重复发到新版说明。
      const oldEntries = new Set(previous ? changelogEntries(git("show", `${previous}:${file}`)) : []);
      const changes = entries(current, heading).filter((entry) => !oldEntries.has(entry));
      return `## ${title}\n\n${changes.join("\n\n") || (heading === "未发布" ? "- 本次无新增更新日志条目。" : "- No new changelog entries for this release.")}`;
    }).join("\n\n");
  const compare = previous ? `\n\nhttps://github.com/shay-wong/codex-panel/compare/${previous}...${tag}` : "";
  writeFileSync(notesPath, `${notes}${compare}\n`);
  for (const [file, value] of [["package.json", pkg], ["package-lock.json", lock], ["src-tauri/tauri.conf.json", tauri]]) {
    writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  // 保留 Cargo 文件注释与排版，仅替换已解析确认的应用版本。
  for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    let updated = 0;
    const content = read(file).split(/(?=^\[)/m).map(block => {
      if (!/^\[\[?package\]\]?\s*$/m.test(block.split("\n")[0])) return block;
      const entry = parse(block).package;
      if ((Array.isArray(entry) ? entry[0] : entry)?.name !== cargo.package.name) return block;
      updated++;
      return block.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
    }).join("");
    assert.equal(updated, 1, `Expected one application package in ${file}`);
    writeFileSync(path.join(root, file), content);
  }
  return metadata;
}

// 发布标签固定本次范围，不能把发布期间 main 新增的条目提前归档。
export function archivePublishedChangelogs(root, tag) {
  releaseMetadata(tag.replace(/^v/, ""), tag, ["arm64", "x86_64"]);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const tags = git("tag", "--merged", tag, "--sort=version:refname").split("\n")
    .filter(value => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-fork$/.test(value));
  for (const [file, heading] of [["CHANGELOG.md", "Unreleased"], ["CHANGELOG.zh-CN.md", "未发布"]]) {
    const filename = path.join(root, file);
    const content = readFileSync(filename, "utf8");
    const marker = `## ${heading}\n`;
    const start = content.indexOf(marker);
    assert.ok(start >= 0, `Missing ${heading} in ${file}`);
    const bodyStart = start + marker.length;
    const next = content.slice(bodyStart).search(/^## /m);
    const end = next < 0 ? content.length : bodyStart + next;
    const pending = changelogEntries(content.slice(bodyStart, end));
    const remaining = new Set(pending);
    const sections = [];
    for (const releasedTag of tags) {
      const files = git("ls-tree", "--name-only", releasedTag, "--", file);
      if (!files) continue;
      const snapshot = git("show", `${releasedTag}:${file}`);
      const section = snapshot.split(marker)[1]?.split(/^## /m)[0] ?? "";
      const released = changelogEntries(section).filter(entry => remaining.has(entry));
      if (!released.length) continue;
      const version = releasedTag.slice(1);
      assert.ok(!content.split("\n").some(line => line === `## ${version}` || line.startsWith(`## ${version} —`)), `Version ${version} already exists while entries remain unreleased in ${file}`);
      sections.unshift(`## ${version}\n\n${released.join("\n\n")}\n\n`);
      released.forEach(entry => remaining.delete(entry));
    }
    const rest = pending.filter(entry => remaining.has(entry));
    writeFileSync(filename, content.slice(0, bodyStart) + "\n" + (rest.length ? rest.join("\n\n") + "\n\n" : "") + sections.join("") + content.slice(end));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, notesPath, mode] = process.argv.slice(2);
  if (!tag || !notesPath) throw new Error("Usage: prepare-fork-release.mjs <vX.Y.Z-fork> <release-notes.md>");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const metadata = prepareForkRelease(root, tag, notesPath);
  if (mode === "--archive-changelog") archivePublishedChangelogs(root, tag);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `RELEASE_DMG=${metadata.assetNames[0]}\nRELEASE_ARCHIVE=${metadata.archive}\n`);
  }
  console.log(`Prepared ${tag} in the build checkout; no commit or tag was created.`);
}
