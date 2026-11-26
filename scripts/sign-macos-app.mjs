#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimeIntegrity } from "./runtime-integrity.mjs";

const app = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!app || process.platform !== "darwin") throw new Error("Usage: app:sign -- <Codex Panel.app> (macOS only)");
const identity = process.env.CODEX_PANEL_CODESIGN_IDENTITY?.trim() || process.env.APPLE_SIGNING_IDENTITY?.trim();
if (!identity || (identity === "-" && process.env.GITHUB_ACTIONS !== "true")) {
  throw new Error("Set APPLE_SIGNING_IDENTITY or CODEX_PANEL_CODESIGN_IDENTITY to the existing developer identity");
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `${command} failed`);
  return result.stdout.trim();
}
const plist = path.join(app, "Contents/Info.plist");
if (run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]) !== "com.shay.codex-panel") {
  throw new Error("Expected the Codex Panel App bundle");
}
const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]);
if (path.basename(executable) !== executable) throw new Error("Invalid App executable");
const resources = path.join(app, "Contents/Resources");
const runtime = path.join(app, "Contents/MacOS/codex-panel-runtime");
await verifyRuntimeIntegrity(resources, runtime);
run("/usr/bin/codesign", ["--verify", "--strict", runtime]);
const entitlements = fileURLToPath(new URL("../src-tauri/Entitlements.plist", import.meta.url));
// sidecar 已在 prepare 时签名和记录哈希，最终签名只封装启动器与 App。
for (const target of [path.join(app, "Contents/MacOS", executable), app]) {
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, target]);
}
await verifyRuntimeIntegrity(resources, runtime);
run(process.execPath, [fileURLToPath(new URL("./preflight-macos-app.mjs", import.meta.url)), app]);
console.log(`Signed and verified ${app}`);
