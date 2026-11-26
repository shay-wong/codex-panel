#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { verifyRuntimeIntegrity } from "./runtime-integrity.mjs";

const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!appPath) throw new Error("Usage: preflight-macos-app.mjs <App.app>");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `${command} failed`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function plistValue(key) {
  return run("/usr/libexec/PlistBuddy", [
    "-c", `Print :${key}`, path.join(appPath, "Contents", "Info.plist"),
  ]).stdout;
}

if (plistValue("CFBundleIdentifier") !== "com.shay.codex-panel") {
  throw new Error("Unexpected Codex Panel bundle identifier");
}
if (plistValue("CFBundleDisplayName") !== "Codex Panel") {
  throw new Error("Unexpected Codex Panel display name");
}

const executableName = plistValue("CFBundleExecutable");
const launcherPath = path.join(appPath, "Contents", "MacOS", executableName);
const runtimePath = path.join(appPath, "Contents", "MacOS", "codex-panel-runtime");
await verifyRuntimeIntegrity(path.join(appPath, "Contents/Resources"), runtimePath);
for (const targetPath of [launcherPath, runtimePath]) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", targetPath]);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
if (!run(runtimePath, ["--help"]).stdout.includes("codex-panel-runtime")) {
  throw new Error("Packaged Rust runtime did not answer --help");
}

for (const requiredPath of [
  "Contents/Resources/app/dist/web/index.html",
  "Contents/Resources/app/inject/codex-panel.user.js",
  "Contents/Resources/app/skills/manage-panel/SKILL.md",
  "Contents/Resources/app/skills/handoff-panel/SKILL.md",
  "Contents/Resources/bin/panelctl",
  "Contents/Resources/codex-panel-launcher.json",
]) {
  run("/bin/test", ["-f", path.join(appPath, requiredPath)]);
}

const marker = JSON.parse(await readFile(path.join(appPath, "Contents/Resources/codex-panel-launcher.json"), "utf8"));
if (marker.runtime !== "rust") throw new Error("Expected the Rust runtime package");
// 包中不再携带旧服务与依赖，避免以后修改资源列表时把 Node 体积带回来。
for (const relative of ["Contents/MacOS/node", ...["node_modules", "server", "shared", "scripts", "cli"].map(name => `Contents/Resources/app/${name}`)]) {
  try { await access(path.join(appPath, relative)); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  throw new Error(`Unexpected legacy runtime payload: ${relative}`);
}
console.log("Verified Codex Panel Tauri app bundle and native Rust runtime");
