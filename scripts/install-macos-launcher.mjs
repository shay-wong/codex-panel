#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePanelDataDirectory, resolvePanelSupportRoot } from "../shared/panel-paths.mjs";
import {
  installManagedDirectory,
  installManagedFile,
  pathExists,
  removeManagedInstallation,
} from "./managed-install.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const panelSkillSource = path.join(projectRoot, "skills", "manage-panel");
const handoffPanelSkillSource = path.join(projectRoot, "skills", "handoff-panel");
const panelctlSource = path.join(projectRoot, "cli", "panelctl.mjs");
const legacyProjectRoot = path.join(path.dirname(projectRoot), "codex-taskboard");
const legacyPanelSkillSources = [
  path.join(projectRoot, "skills", "manage-taskboard"),
  path.join(legacyProjectRoot, "skills", "manage-taskboard"),
];
const legacyPanelctlSources = [
  path.join(projectRoot, "cli", "taskctl.mjs"),
  path.join(legacyProjectRoot, "cli", "taskctl.mjs"),
];
const runtimePayloadPaths = [
  "cli",
  "inject",
  "server",
  "shared",
  path.join("dist", "web"),
  path.join("skills", "manage-panel"),
  path.join("skills", "handoff-panel"),
];
const runtimeScriptNames = [
  "codex-injector-runtime.mjs",
  "codex-injector.mjs",
  "codex-rate-limits.mjs",
];
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

function run(command, args, { allowFailure = false, cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0 || allowFailure) return result;
  const detail = result.stderr?.trim()
    || result.stdout?.trim()
    || result.error?.message
    || `exit status ${result.status}`;
  throw new Error(`${path.basename(command)} failed: ${detail}`);
}

export function resolveInstallLayout(options = {}) {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const nodeBinDirectory = options.nodeBinDirectory ?? path.dirname(process.execPath);
  const installRoot = options.installRoot ?? resolvePanelSupportRoot({
    environment,
    homeDirectory,
    platform,
  });
  const configuredCodexHome = environment.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(homeDirectory, ".codex");

  return {
    applicationsDirectory: options.applicationsDirectory
      ?? path.join(homeDirectory, "Applications"),
    dataDirectory: options.dataDirectory ?? resolvePanelDataDirectory({
      environment,
      homeDirectory,
      platform,
    }),
    installRoot,
    legacyCodexSkillsDirectory: path.join(codexHome, "skills"),
    legacyNodeBinDirectory: nodeBinDirectory,
    logPath: options.logPath
      ?? path.join(homeDirectory, "Library", "Logs", "Codex Panel.log"),
    runtimeDirectory: path.join(installRoot, "runtime"),
    skillsDirectory: options.skillsDirectory ?? path.join(homeDirectory, ".agents", "skills"),
    userBinDirectory: options.userBinDirectory ?? path.join(homeDirectory, ".local", "bin"),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function panelctlLauncher(runtimeDirectory) {
  const cliPath = path.join(runtimeDirectory, "cli", "panelctl.mjs");
  return `#!/bin/sh
# codex-panel-managed:panelctl:1
exec /usr/bin/env node ${shellQuote(cliPath)} "$@"
`;
}

async function buildWeb(sourceRoot) {
  const npmPath = path.join(path.dirname(process.execPath), "npm");
  if (!(await pathExists(npmPath))) throw new Error(`npm executable not found at ${npmPath}`);
  run(npmPath, ["run", "build:web"], { cwd: sourceRoot });
}

async function stageRuntimePayload(sourceRoot, stagedRuntime) {
  for (const relativePath of runtimePayloadPaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!(await pathExists(sourcePath))) {
      throw new Error(`Required runtime path is missing: ${sourcePath}`);
    }
    await cp(sourcePath, path.join(stagedRuntime, relativePath), {
      preserveTimestamps: true,
      recursive: true,
    });
  }

  const scriptsDirectory = path.join(stagedRuntime, "scripts");
  await mkdir(scriptsDirectory, { recursive: true });
  for (const filename of runtimeScriptNames) {
    await copyFile(path.join(sourceRoot, "scripts", filename), path.join(scriptsDirectory, filename));
  }
}

export async function installRuntime(
  runtimeDirectory,
  { skipBuild = false, sourceRoot = projectRoot } = {},
) {
  if (!skipBuild) await buildWeb(sourceRoot);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-runtime-"));
  const stagedRuntime = path.join(temporaryDirectory, "runtime");
  try {
    await mkdir(stagedRuntime);
    await stageRuntimePayload(sourceRoot, stagedRuntime);
    return await installManagedDirectory(
      stagedRuntime,
      runtimeDirectory,
      "Codex Panel runtime",
      { artifact: "runtime" },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isDatabaseSidecar(filename) {
  return filename === "panel.sqlite"
    || filename === "panel.sqlite-shm"
    || filename === "panel.sqlite-wal";
}

export async function initializeDataDirectory(sourceDirectory, targetDirectory) {
  if (path.resolve(sourceDirectory) === path.resolve(targetDirectory)) {
    await mkdir(targetDirectory, { recursive: true });
    return false;
  }
  if (await pathExists(targetDirectory)) return false;

  await mkdir(path.dirname(targetDirectory), { recursive: true });
  const stagedDirectory = await mkdtemp(
    path.join(path.dirname(targetDirectory), ".codex-panel-data-"),
  );
  let migrated = false;
  try {
    if (await pathExists(sourceDirectory)) {
      for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
        if (entry.name === ".gitkeep" || isDatabaseSidecar(entry.name)) continue;
        await cp(
          path.join(sourceDirectory, entry.name),
          path.join(stagedDirectory, entry.name),
          { preserveTimestamps: true, recursive: entry.isDirectory() },
        );
        migrated = true;
      }

      const sourceDatabasePath = path.join(sourceDirectory, "panel.sqlite");
      if (await pathExists(sourceDatabasePath)) {
        const { backup, DatabaseSync } = await import("node:sqlite");
        const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
        try {
          const targetDatabasePath = path.join(stagedDirectory, "panel.sqlite");
          await backup(sourceDatabase, targetDatabasePath);
          await chmod(targetDatabasePath, 0o600);
        } finally {
          sourceDatabase.close();
        }
        migrated = true;
      }
    }

    await rename(stagedDirectory, targetDirectory);
    if (migrated) {
      console.log(`Panel data copied from ${sourceDirectory} to ${targetDirectory}`);
    } else {
      console.log(`Panel data directory created at ${targetDirectory}`);
    }
    return migrated;
  } finally {
    await rm(stagedDirectory, { recursive: true, force: true });
  }
}

export async function installPanelTools(layout) {
  const runtimePanelSkill = path.join(layout.runtimeDirectory, "skills", "manage-panel");
  const runtimeHandoffSkill = path.join(layout.runtimeDirectory, "skills", "handoff-panel");
  const panelSkillReplaceSources = [
    panelSkillSource,
    runtimePanelSkill,
    path.join(legacyProjectRoot, "skills", "manage-panel"),
  ];
  const handoffSkillReplaceSources = [
    handoffPanelSkillSource,
    runtimeHandoffSkill,
    path.join(legacyProjectRoot, "skills", "handoff-panel"),
  ];
  const panelctlReplaceSources = [
    panelctlSource,
    path.join(layout.runtimeDirectory, "cli", "panelctl.mjs"),
    path.join(legacyProjectRoot, "cli", "panelctl.mjs"),
  ];

  await installManagedDirectory(
    runtimePanelSkill,
    path.join(layout.skillsDirectory, "manage-panel"),
    "manage-panel Skill",
    { artifact: "manage-panel", replaceSources: panelSkillReplaceSources },
  );
  await installManagedDirectory(
    runtimeHandoffSkill,
    path.join(layout.skillsDirectory, "handoff-panel"),
    "handoff-panel Skill",
    { artifact: "handoff-panel", replaceSources: handoffSkillReplaceSources },
  );
  await installManagedFile(
    panelctlLauncher(layout.runtimeDirectory),
    path.join(layout.userBinDirectory, "panelctl"),
    "panelctl",
    { artifact: "panelctl", replaceSources: panelctlReplaceSources },
  );

  await removeManagedInstallation(
    path.join(layout.legacyCodexSkillsDirectory, "manage-panel"),
    "legacy manage-panel Skill",
    { artifact: "manage-panel", replaceSources: panelSkillReplaceSources },
  );
  await removeManagedInstallation(
    path.join(layout.legacyCodexSkillsDirectory, "handoff-panel"),
    "legacy handoff-panel Skill",
    { artifact: "handoff-panel", replaceSources: handoffSkillReplaceSources },
  );
  await removeManagedInstallation(
    path.join(layout.legacyCodexSkillsDirectory, "manage-taskboard"),
    "legacy manage-taskboard Skill",
    { artifact: "manage-taskboard", replaceSources: legacyPanelSkillSources },
  );
  await removeManagedInstallation(
    path.join(layout.legacyNodeBinDirectory, "panelctl"),
    "legacy panelctl command",
    { artifact: "panelctl", replaceSources: panelctlReplaceSources },
  );
  await removeManagedInstallation(
    path.join(layout.legacyNodeBinDirectory, "taskctl"),
    "legacy taskctl command",
    { artifact: "taskctl", replaceSources: legacyPanelctlSources },
  );
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
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("No Codex application icon was found");
}

export function launcherSource({
  dataDirectory,
  logPath,
  nodeBinPath,
  nodePath,
  runtimeDirectory,
  userBinDirectory,
}) {
  const pathValue = [
    userBinDirectory,
    nodeBinPath,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `property runtimePath : ${appleScriptString(runtimeDirectory)}
property dataPath : ${appleScriptString(dataDirectory)}
property injectorPath : ${appleScriptString(path.join(runtimeDirectory, "scripts", "codex-injector.mjs"))}
property nodePath : ${appleScriptString(nodePath)}
property nodePathValue : ${appleScriptString(pathValue)}
property logPath : ${appleScriptString(logPath)}
property codexAppPath : ${appleScriptString(officialCodexAppPath)}

on run
  set shellSetup to "export PATH=" & quoted form of nodePathValue & "; export CODEX_PANEL_HOST=127.0.0.1; export CODEX_PANEL_DATA_DIR=" & quoted form of dataPath & "; cd " & quoted form of runtimePath & "; "

  try
    set cdpReady to do shell script "/usr/bin/curl -fsS --max-time 1 http://127.0.0.1:9229/json/version >/dev/null 2>&1; echo $?"
    if cdpReady is "0" then
      do shell script shellSetup & "nohup " & quoted form of nodePath & " " & quoted form of injectorPath & " --daemon --open >> " & quoted form of logPath & " 2>&1 </dev/null &"
      delay 1
      do shell script "/usr/bin/open -a " & quoted form of codexAppPath
      return
    end if

    set codexRunning to do shell script "/usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; echo $?"
    if codexRunning is "0" then
      display dialog "Codex 正在运行，但没有启用 CDP。请完全退出 Codex，再点击 Codex。" buttons {"好"} default button "好" with icon caution
      return
    end if

    do shell script shellSetup & "nohup " & quoted form of nodePath & " " & quoted form of injectorPath & " --launch --watch --open >> " & quoted form of logPath & " 2>&1 </dev/null &"
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
  if (!(await pathExists(mistakenLauncherPath))) return;
  await assertManagedLauncher(mistakenLauncherPath);
  run(launchServicesRegister, ["-u", mistakenLauncherPath], { allowFailure: true });
  await rm(mistakenLauncherPath, { recursive: true });
}

export async function installLauncher(layout) {
  if (process.platform !== "darwin") {
    console.log("Skipping Codex launcher installation outside macOS.");
    return;
  }

  const applicationsDirectory = layout.applicationsDirectory;
  const launcherPath = path.join(applicationsDirectory, launcherName);
  const iconSourcePath = await resolveLauncherIcon(launcherPath);

  if (await pathExists(launcherPath)) {
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
      dataDirectory: layout.dataDirectory,
      logPath: layout.logPath,
      nodeBinPath: path.dirname(process.execPath),
      nodePath: process.execPath,
      runtimeDirectory: layout.runtimeDirectory,
      userBinDirectory: layout.userBinDirectory,
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
        dataDirectory: layout.dataDirectory,
        nodePath: process.execPath,
        runtimeDirectory: layout.runtimeDirectory,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", temporaryLauncherPath]);

    if (await pathExists(launcherPath)) await rm(launcherPath, { recursive: true });
    await rename(temporaryLauncherPath, launcherPath);
    run(launchServicesRegister, ["-f", launcherPath]);
    await removeMistakenLauncher(applicationsDirectory);
    console.log(`Codex launcher installed at ${launcherPath}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function installCodexIntegration(options = {}) {
  const layout = options.layout ?? resolveInstallLayout();
  await installRuntime(layout.runtimeDirectory, { skipBuild: options.skipBuild });
  await initializeDataDirectory(path.join(projectRoot, ".data"), layout.dataDirectory);
  await installPanelTools(layout);
  if (!options.skipLauncher) await installLauncher(layout);
  return layout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  installCodexIntegration().catch((error) => {
    console.error(`Codex integration installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
