#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!appPath) throw new Error("Usage: preflight-macos-app.mjs <App.app>");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasePolicy = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "release.json"),
  "utf8",
));

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

function signingDetails(targetPath) {
  return run("/usr/bin/codesign", ["-dv", "--verbose=4", targetPath]).stderr;
}

function entitlements(targetPath) {
  const { stdout } = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", targetPath]);
  const { stdout: json } = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: stdout,
  });
  return JSON.parse(json);
}

if (plistValue("CFBundleIdentifier") !== "com.shay.codex-panel") {
  throw new Error("Unexpected Codex Panel bundle identifier");
}
if (plistValue("CFBundleDisplayName") !== "Codex Panel") {
  throw new Error("Unexpected Codex Panel display name");
}

const executableName = plistValue("CFBundleExecutable");
const launcherPath = path.join(appPath, "Contents", "MacOS", executableName);
const nodePath = path.join(appPath, "Contents", "MacOS", "node");
for (const targetPath of [launcherPath, nodePath, appPath]) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", targetPath]);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
if (!signingDetails(nodePath).includes(`TeamIdentifier=${releasePolicy.nodeTeamId}`)) {
  throw new Error(`Node does not use Team ${releasePolicy.nodeTeamId}`);
}
const nodeEntitlements = entitlements(nodePath);
for (const entitlement of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]) {
  if (nodeEntitlements[entitlement] !== true) throw new Error(`Node is missing ${entitlement}`);
}
run(nodePath, [
  "-e",
  "let n=0; const add=(v)=>v+1; for(let i=0;i<5000000;i+=1)n=add(n); if(n!==5000000)process.exit(1)",
]);

for (const requiredPath of [
  "Contents/Resources/app/scripts/codex-injector.mjs",
  "Contents/Resources/app/inject/codex-panel.user.js",
  "Contents/Resources/app/cli/panelctl.mjs",
  "Contents/Resources/app/skills/manage-panel/SKILL.md",
  "Contents/Resources/app/skills/handoff-panel/SKILL.md",
  "Contents/Resources/bin/panelctl",
  "Contents/Resources/codex-panel-launcher.json",
]) {
  run("/bin/test", ["-f", path.join(appPath, requiredPath)]);
}

console.log("Verified Codex Panel Tauri app bundle and bundled Node runtime");
