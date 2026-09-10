#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseMetadata } from "./release-metadata.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [appArgument, outputArgument, tag] = process.argv.slice(2);
if (!appArgument || !outputArgument || !tag) {
  throw new Error("Usage: create-macos-updater.mjs <Codex Panel.app> <output-directory> <vX.Y.Z-fork.N>");
}
const app = path.resolve(appArgument);
const output = path.resolve(outputArgument);
const publicKey = process.env.CODEX_PANEL_UPDATER_PUBLIC_KEY?.trim();
if (!publicKey || !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("CODEX_PANEL_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY are required");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${command} failed`);
  return result.stdout.trim();
}
const plist = (field) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${field}`, path.join(app, "Contents/Info.plist")]);
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (path.basename(app) !== "Codex Panel.app" || plist("CFBundleIdentifier") !== "com.shay.codex-panel"
  || plist("CFBundleShortVersionString") !== version) {
  throw new Error("Updater bundle must be Codex Panel with the current package version");
}
const executable = plist("CFBundleExecutable");
if (path.basename(executable) !== executable) throw new Error("Invalid bundle executable");
const metadata = releaseMetadata(version, tag, run("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS", executable)]).split(/\s+/));
run(process.execPath, [path.join(root, "scripts/preflight-macos-app.mjs"), app]);
await mkdir(output, { recursive: true });
const archive = path.join(output, metadata.archive);
run("/usr/bin/tar", ["-czf", archive, path.basename(app)], { cwd: path.dirname(app) });
run(path.join(root, "node_modules/.bin/tauri"), ["signer", "sign", archive]);
const signature = (await readFile(`${archive}.sig`, "utf8")).trim();
await verifyUpdaterSignature({ publicKey, artifactPath: archive, signature });
await writeFile(path.join(output, "latest.json"), `${JSON.stringify({
  version, notes: `Codex Panel ${version}`, pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(metadata.platforms.map((platform) => [platform, { signature, url: metadata.url }])),
}, null, 2)}\n`);
console.log(`Created verified updater archive and latest.json in ${output}`);
