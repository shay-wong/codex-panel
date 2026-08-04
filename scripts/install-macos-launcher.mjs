#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const launcherName = "Codex.app";
const mistakenLauncherName = "Codex Panel.app";
const launcherBundleIdentifier = "com.shay.codex-taskboard-launcher";
const launcherMarkerName = "codex-panel-launcher.json";
const officialCodexAppPath = "/Applications/ChatGPT.app";
const plistBuddyPath = "/usr/libexec/PlistBuddy";
const launchServicesRegister = [
  "/System/Library/Frameworks/CoreServices.framework",
  "Frameworks/LaunchServices.framework/Support/lsregister",
].join("/");

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0 || allowFailure) return result;
  const detail = result.stderr?.trim()
    || result.stdout?.trim()
    || result.error?.message
    || `exit status ${result.status}`;
  throw new Error(`${path.basename(command)} failed: ${detail}`);
}

async function exists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function bundleIdentifier(appPath) {
  const result = run(plistBuddyPath, [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(appPath, "Contents", "Info.plist"),
  ], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function managedMarker(appPath) {
  try {
    return JSON.parse(await readFile(path.join(
      appPath,
      "Contents",
      "Resources",
      launcherMarkerName,
    ), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function assertManagedLauncher(appPath, { allowCurrentCodexLauncher = false } = {}) {
  const marker = await managedMarker(appPath);
  if (marker?.generator === "codex-panel") return;
  if (allowCurrentCodexLauncher && bundleIdentifier(appPath) === launcherBundleIdentifier) return;
  throw new Error(`Refusing to replace an unmanaged application at ${appPath}`);
}

async function resolveLauncherIcon(currentLauncherPath) {
  const candidates = [
    path.join(currentLauncherPath, "Contents", "Resources", "codex.icns"),
    path.join(currentLauncherPath, "Contents", "Resources", "Codex.icns"),
    path.join(officialCodexAppPath, "Contents", "Resources", "app.icns"),
    path.join(officialCodexAppPath, "Contents", "Resources", "electron.icns"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("No Codex application icon was found");
}

function launcherSource({ npmPath, nodeBinPath, logPath }) {
  const pathValue = [
    nodeBinPath,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `property projectPath : ${appleScriptString(projectRoot)}
property npmPath : ${appleScriptString(npmPath)}
property nodePathValue : ${appleScriptString(pathValue)}
property logPath : ${appleScriptString(logPath)}
property codexAppPath : ${appleScriptString(officialCodexAppPath)}

on run
  set shellSetup to "export PATH=" & quoted form of nodePathValue & "; export CODEX_TASKBOARD_HOST=127.0.0.1; cd " & quoted form of projectPath & "; "

  try
    set cdpReady to do shell script "/usr/bin/curl -fsS --max-time 1 http://127.0.0.1:9229/json/version >/dev/null 2>&1; echo $?"
    if cdpReady is "0" then
      do shell script shellSetup & "nohup " & quoted form of npmPath & " run codex:daemon >> " & quoted form of logPath & " 2>&1 </dev/null &"
      delay 1
      do shell script "/usr/bin/open -a " & quoted form of codexAppPath
      return
    end if

    set codexRunning to do shell script "/usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; echo $?"
    if codexRunning is "0" then
      display dialog "Codex 正在运行，但没有启用 CDP。请完全退出 Codex，再点击 Codex。" buttons {"好"} default button "好" with icon caution
      return
    end if

    do shell script shellSetup & "nohup " & quoted form of npmPath & " run codex >> " & quoted form of logPath & " 2>&1 </dev/null &"
  on error errorMessage
    display dialog "Codex Panel 启动失败：" & return & errorMessage buttons {"好"} default button "好" with icon stop
  end try
end run
`;
}

function setPlistValue(plistPath, key, value) {
  const result = run(
    plistBuddyPath,
    ["-c", `Set :${key} ${value}`, plistPath],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    run(plistBuddyPath, ["-c", `Add :${key} string ${value}`, plistPath]);
  }
}

async function removeMistakenLauncher(applicationsDirectory) {
  const mistakenLauncherPath = path.join(applicationsDirectory, mistakenLauncherName);
  if (!(await exists(mistakenLauncherPath))) return;
  await assertManagedLauncher(mistakenLauncherPath);
  run(launchServicesRegister, ["-u", mistakenLauncherPath], { allowFailure: true });
  await rm(mistakenLauncherPath, { recursive: true });
}

async function installLauncher() {
  if (process.platform !== "darwin") {
    console.log("Skipping Codex launcher installation outside macOS.");
    return;
  }

  const applicationsDirectory = path.join(os.homedir(), "Applications");
  const launcherPath = path.join(applicationsDirectory, launcherName);
  const npmPath = path.join(path.dirname(process.execPath), "npm");
  const logPath = path.join(os.homedir(), "Library", "Logs", "Codex Panel.log");
  const iconSourcePath = await resolveLauncherIcon(launcherPath);

  if (!(await exists(npmPath))) {
    throw new Error(`npm executable not found at ${npmPath}`);
  }
  if (await exists(launcherPath)) {
    await assertManagedLauncher(launcherPath, { allowCurrentCodexLauncher: true });
  }

  await mkdir(applicationsDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(applicationsDirectory, ".codex-launcher-"),
  );
  const temporaryLauncherPath = path.join(temporaryDirectory, launcherName);
  const sourcePath = path.join(temporaryDirectory, "Codex.applescript");

  try {
    await writeFile(sourcePath, launcherSource({
      npmPath,
      nodeBinPath: path.dirname(process.execPath),
      logPath,
    }));
    run("/usr/bin/osacompile", ["-o", temporaryLauncherPath, sourcePath]);

    const plistPath = path.join(temporaryLauncherPath, "Contents", "Info.plist");
    setPlistValue(plistPath, "CFBundleIdentifier", launcherBundleIdentifier);
    setPlistValue(plistPath, "CFBundleDisplayName", "Codex");
    setPlistValue(plistPath, "CFBundleName", "Codex");
    setPlistValue(plistPath, "CFBundleIconFile", "Codex");

    const resourcesPath = path.join(temporaryLauncherPath, "Contents", "Resources");
    await copyFile(iconSourcePath, path.join(resourcesPath, "Codex.icns"));
    await writeFile(
      path.join(resourcesPath, launcherMarkerName),
      `${JSON.stringify({
        generator: "codex-panel",
        launcher: "Codex.app",
        projectRoot,
        npmPath,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", temporaryLauncherPath]);

    if (await exists(launcherPath)) await rm(launcherPath, { recursive: true });
    await rename(temporaryLauncherPath, launcherPath);
    run(launchServicesRegister, ["-f", launcherPath]);
    await removeMistakenLauncher(applicationsDirectory);
    console.log(`Codex launcher installed at ${launcherPath}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

installLauncher().catch((error) => {
  console.error(`Codex launcher installation failed: ${error.message}`);
  process.exitCode = 1;
});
