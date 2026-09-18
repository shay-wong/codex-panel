#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { releaseMetadata } from "./release-metadata.mjs";

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
    return section.split(/\n(?=- )/).map((entry) => entry.trim()).filter((entry) => entry.startsWith("- "));
  };
  const notes = [["CHANGELOG.zh-CN.md", "未发布", "更新内容"], ["CHANGELOG.md", "Unreleased", "Changes"]]
    .map(([file, heading, title]) => {
      const current = read(file);
      // Unreleased may remain in main after publishing; omit entries already present in the previous tag.
      const oldEntries = new Set(previous ? entries(git("show", `${previous}:${file}`), heading) : []);
      const changes = entries(current, heading).filter((entry) => !oldEntries.has(entry));
      return `## ${title}\n\n${changes.join("\n\n") || (heading === "未发布" ? "- 本次无新增更新日志条目。" : "- No new changelog entries for this release.")}`;
    }).join("\n\n");
  const compare = previous ? `\n\nhttps://github.com/shay-wong/codex-panel/compare/${previous}...${tag}` : "";
  writeFileSync(notesPath, `${notes}${compare}\n`);
  for (const [file, value] of [["package.json", pkg], ["package-lock.json", lock], ["src-tauri/tauri.conf.json", tauri]]) {
    writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  writeFileSync(path.join(root, "src-tauri/Cargo.toml"), stringify(cargo));
  writeFileSync(path.join(root, "src-tauri/Cargo.lock"), stringify(cargoLock));
  return metadata;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, notesPath] = process.argv.slice(2);
  if (!tag || !notesPath) throw new Error("Usage: prepare-fork-release.mjs <vX.Y.Z-fork> <release-notes.md>");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const metadata = prepareForkRelease(root, tag, notesPath);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `RELEASE_DMG=${metadata.assetNames[0]}\nRELEASE_ARCHIVE=${metadata.archive}\n`);
  }
  console.log(`Prepared ${tag} in the build checkout; no commit or tag was created.`);
}
