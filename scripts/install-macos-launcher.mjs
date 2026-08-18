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
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePanelDataDirectory, resolvePanelSupportRoot } from "../shared/panel-paths.mjs";
import {
  readInjectorRuntime,
  readProcessCommand,
  stopManagedInjector,
} from "./codex-injector-control.mjs";
import { managedInjectorCommandMatches } from "./codex-injector-runtime.mjs";
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
const launcherName = "Codex Panel.app";
const legacyLauncherName = "Codex.app";
const launcherMarkerName = "codex-panel-launcher.json";
const legacyLauncherBundleIdentifier = "com.shay.codex-taskboard-launcher";
const plistBuddyPath = "/usr/libexec/PlistBuddy";
const launchServicesRegister = [
  "/System/Library/Frameworks/CoreServices.framework",
  "Frameworks/LaunchServices.framework/Support/lsregister",
].join("/");
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
  "codex-cdp-pipe.mjs",
  "codex-injector-control.mjs",
  "codex-injector-runtime.mjs",
  "codex-injector.mjs",
  "codex-rate-limits.mjs",
  "panel-supervisor.mjs",
];

function run(command, args, { allowFailure = false, cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0 || allowFailure) return result;
  const detail = result.stderr?.trim()
    || result.stdout?.trim()
    || result.error?.message
    || `exit status ${result.status}`;
  throw new Error(`${path.basename(command)} failed: ${detail}`);
}

function bundleIdentifier(appPath) {
  const result = run(plistBuddyPath, [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(appPath, "Contents", "Info.plist"),
  ], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function bundleExecutable(appPath) {
  const result = run(plistBuddyPath, [
    "-c",
    "Print :CFBundleExecutable",
    path.join(appPath, "Contents", "Info.plist"),
  ], { allowFailure: true });
  if (result.status !== 0) return null;
  const executable = result.stdout.trim();
  return executable && path.basename(executable) === executable ? executable : null;
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

async function assertManagedLauncher(appPath) {
  if ((await managedMarker(appPath))?.generator === "codex-panel") return;
  throw new Error(`Refusing to replace an unmanaged application at ${appPath}`);
}

export function resolveInstallLayout(options = {}) {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const nodeBinDirectory = options.nodeBinDirectory ?? path.dirname(process.execPath);
  const fixedProductRoot = platform === "darwin"
    ? path.join(homeDirectory, "Library", "Application Support", "Codex Panel")
    : resolvePanelSupportRoot({ environment, homeDirectory, platform });
  const installRoot = options.installRoot ?? fixedProductRoot;
  const configuredCodexHome = environment.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(homeDirectory, ".codex");
  return {
    applicationsDirectory: options.applicationsDirectory
      ?? path.join(homeDirectory, "Applications"),
    dataDirectory: options.dataDirectory ?? (platform === "darwin"
      ? path.join(fixedProductRoot, "data")
      : resolvePanelDataDirectory({ environment, homeDirectory, platform })),
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

export function panelctlLauncher(
  runtimeDirectory,
  dataDirectory = resolvePanelDataDirectory(),
) {
  const cliPath = path.join(runtimeDirectory, "cli", "panelctl.mjs");
  return `#!/bin/sh
# codex-panel-managed:panelctl:1
export CODEX_PANEL_DATA_DIR=${shellQuote(dataDirectory)}
export CODEX_PANEL_RUNTIME_FILE=${shellQuote(path.join(dataDirectory, "launcher-runtime.json"))}
exec /usr/bin/env node ${shellQuote(cliPath)} "$@"
`;
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

export async function installRuntime(runtimeDirectory, { sourceRoot = projectRoot } = {}) {
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
    console.log(migrated
      ? `Panel data copied from ${sourceDirectory} to ${targetDirectory}`
      : `Panel data directory created at ${targetDirectory}`);
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
    panelctlLauncher(layout.runtimeDirectory, layout.dataDirectory),
    path.join(layout.userBinDirectory, "panelctl"),
    "panelctl",
    { artifact: "panelctl", replaceSources: panelctlReplaceSources },
  );
  for (const [target, label, artifact, replaceSources] of [
    [path.join(layout.legacyCodexSkillsDirectory, "manage-panel"), "legacy manage-panel Skill", "manage-panel", panelSkillReplaceSources],
    [path.join(layout.legacyCodexSkillsDirectory, "handoff-panel"), "legacy handoff-panel Skill", "handoff-panel", handoffSkillReplaceSources],
    [path.join(layout.legacyCodexSkillsDirectory, "manage-taskboard"), "legacy manage-taskboard Skill", "manage-taskboard", [
      path.join(projectRoot, "skills", "manage-taskboard"),
      path.join(legacyProjectRoot, "skills", "manage-taskboard"),
    ]],
    [path.join(layout.legacyNodeBinDirectory, "panelctl"), "legacy panelctl command", "panelctl", panelctlReplaceSources],
    [path.join(layout.legacyNodeBinDirectory, "taskctl"), "legacy taskctl command", "taskctl", [
      path.join(projectRoot, "cli", "taskctl.mjs"),
      path.join(legacyProjectRoot, "cli", "taskctl.mjs"),
    ]],
  ]) {
    await removeManagedInstallation(target, label, { artifact, replaceSources });
  }
}

function currentSigningIdentity(appPath) {
  const details = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    allowFailure: true,
  });
  return `${details.stdout}\n${details.stderr}`.match(/^Authority=(.+)$/m)?.[1] ?? null;
}

function resolveSigningIdentity(existingAppPath) {
  const explicit = process.env.CODEX_PANEL_CODESIGN_IDENTITY?.trim();
  if (explicit) return explicit;
  const identitiesResult = run(
    "/usr/bin/security",
    ["find-identity", "-p", "codesigning", "-v"],
    { allowFailure: true },
  );
  const identities = [...identitiesResult.stdout.matchAll(
    /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm,
  )].map((match) => ({ hash: match[1], name: match[2] }));
  const existingAuthority = existingAppPath ? currentSigningIdentity(existingAppPath) : null;
  const existing = identities.find(({ name }) => name === existingAuthority);
  if (existing) return existing.hash;
  const email = run("/usr/bin/git", ["config", "--global", "user.email"], {
    allowFailure: true,
  }).stdout.trim().toLowerCase();
  const matching = identities.filter(({ name }) => (
    name.startsWith("Apple Development:") && email && name.toLowerCase().includes(email)
  ));
  return matching.length === 1 ? matching[0].hash : "-";
}

function hostTarget() {
  if (process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

async function buildTauriApp() {
  const target = hostTarget();
  const npmPath = path.join(path.dirname(process.execPath), "npm");
  const tauriPath = path.join(projectRoot, "node_modules", ".bin", "tauri");
  run(npmPath, ["run", "app:prepare", "--", "--target", target], { cwd: projectRoot });
  run(tauriPath, [
    "build",
    "--target", target,
    "--bundles", "app",
    "--no-sign",
    "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  ], { cwd: projectRoot });
  const appPath = path.join(
    projectRoot,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
    "macos",
    launcherName,
  );
  if (!(await pathExists(appPath))) throw new Error(`Tauri app was not built at ${appPath}`);
  await assertManagedLauncher(appPath);
  return appPath;
}

async function stopInstalledLauncher(appPath) {
  const executableName = bundleExecutable(appPath);
  if (!executableName) return;
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const runningPids = () => run("/bin/ps", ["-axo", "pid=,command="], {
    allowFailure: true,
  }).stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const command = match[2];
    return command === executablePath || command.startsWith(`${executablePath} `)
      ? [Number(match[1])]
      : [];
  });
  let pids = runningPids();
  for (const pid of pids) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 36_000;
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    pids = runningPids();
  }
  for (const pid of pids) {
    if (runningPids().includes(pid)) process.kill(pid, "SIGKILL");
  }
}

async function stopOwnedInjector(dataDirectory, ownership) {
  const runtimeFile = path.join(dataDirectory, "launcher-runtime.json");
  let descriptor;
  try {
    descriptor = await readInjectorRuntime(runtimeFile);
    if (!managedInjectorCommandMatches(readProcessCommand(descriptor.pid), {
      ...ownership,
      startupToken: descriptor.startupToken,
    })) return null;
  } catch {
    return null;
  }
  return stopManagedInjector({ runtimeFile, ownership });
}

async function stopLegacyInjector(appPath, dataDirectory, marker) {
  if (typeof marker?.nodePath !== "string" || marker.launcher === "tauri") return;
  const result = await stopOwnedInjector(dataDirectory, {
    nodePath: marker.nodePath,
    injectorPath: path.join(
      appPath,
      "Contents",
      "Resources",
      "runtime",
      "scripts",
      "codex-injector.mjs",
    ),
  });
  if (result?.stopped) console.log(`Stopped legacy Codex Panel injector ${result.pid}`);

  const serverCommand = `${marker.nodePath} ${path.join(
    appPath,
    "Contents",
    "Resources",
    "runtime",
    "server",
    "index.mjs",
  )}`;
  const runningPids = () => run("/bin/ps", ["-axo", "pid=,command="], {
    allowFailure: true,
  }).stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match?.[2] === serverCommand ? [Number(match[1])] : [];
  });
  let pids = runningPids();
  for (const pid of pids) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pids = runningPids();
  }
  for (const pid of pids) process.kill(pid, "SIGKILL");
}

async function stopTauriInjector(appPath, dataDirectory, marker) {
  if (marker?.launcher !== "tauri") return;
  const result = await stopOwnedInjector(dataDirectory, {
    nodePath: path.join(appPath, "Contents", "MacOS", "node"),
    injectorPath: path.join(
      appPath,
      "Contents",
      "Resources",
      "app",
      "scripts",
      "codex-injector.mjs",
    ),
  });
  if (result?.stopped) console.log(`Stopped Codex Panel Tauri injector ${result.pid}`);
}

async function removeLegacyLauncher(applicationsDirectory) {
  const legacyPath = path.join(applicationsDirectory, legacyLauncherName);
  if (!(await pathExists(legacyPath))) return;
  const marker = await managedMarker(legacyPath);
  if (
    marker?.generator !== "codex-panel"
    && bundleIdentifier(legacyPath) !== legacyLauncherBundleIdentifier
  ) return;
  run(launchServicesRegister, ["-u", legacyPath], { allowFailure: true });
  await rm(legacyPath, { recursive: true });
}

export async function installLauncher(layout, { sourceApp } = {}) {
  const launcherPath = path.join(layout.applicationsDirectory, launcherName);
  const launcherExists = await pathExists(launcherPath);
  const installedMarker = launcherExists ? await managedMarker(launcherPath) : null;
  if (launcherExists) await assertManagedLauncher(launcherPath);
  const builtApp = sourceApp ?? await buildTauriApp();
  await assertManagedLauncher(builtApp);
  const signingIdentity = resolveSigningIdentity(launcherExists ? launcherPath : null);
  await mkdir(layout.applicationsDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(layout.applicationsDirectory, ".codex-panel-tauri-"),
  );
  const stagedApp = path.join(temporaryDirectory, launcherName);
  const previousApp = path.join(temporaryDirectory, "previous.app");
  try {
    await cp(builtApp, stagedApp, { preserveTimestamps: true, recursive: true });
    const executableName = bundleExecutable(stagedApp);
    if (!executableName) throw new Error("Tauri app has no valid CFBundleExecutable");
    for (const target of [
      path.join(stagedApp, "Contents", "MacOS", executableName),
      stagedApp,
    ]) {
      run("/usr/bin/codesign", [
        "--force",
        "--options", "runtime",
        "--entitlements", path.join(projectRoot, "src-tauri", "Entitlements.plist"),
        "--sign", signingIdentity,
        target,
      ]);
    }
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
    if (launcherExists) {
      await stopTauriInjector(launcherPath, layout.dataDirectory, installedMarker);
      await stopLegacyInjector(launcherPath, layout.dataDirectory, installedMarker);
      await stopInstalledLauncher(launcherPath);
      run(launchServicesRegister, ["-u", launcherPath], { allowFailure: true });
      await rename(launcherPath, previousApp);
    }
    try {
      await rename(stagedApp, launcherPath);
    } catch (error) {
      if (await pathExists(previousApp)) await rename(previousApp, launcherPath);
      throw error;
    }
    await rm(previousApp, { recursive: true, force: true });
    run(launchServicesRegister, ["-f", launcherPath]);
    await removeLegacyLauncher(layout.applicationsDirectory);
    console.log(`Codex Panel Tauri app installed at ${launcherPath}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function installCodexIntegration(options = {}) {
  if (process.platform !== "darwin") {
    console.log("Skipping Codex Panel app installation outside macOS.");
    return null;
  }
  const layout = options.layout ?? resolveInstallLayout();
  const launcherPath = path.join(layout.applicationsDirectory, launcherName);
  const legacyDataSources = [
    path.join(launcherPath, "Contents", "Resources", "runtime", ".data"),
    path.join(launcherPath, "Contents", "Resources", "app", ".data"),
    path.join(projectRoot, ".data"),
  ];
  const sourceApp = options.sourceApp ?? await buildTauriApp();
  const dataSource = legacyDataSources.find((candidate) => spawnSync(
    "/usr/bin/test",
    ["-d", candidate],
  ).status === 0) ?? path.join(projectRoot, ".data");
  await initializeDataDirectory(dataSource, layout.dataDirectory);
  await installRuntime(layout.runtimeDirectory);
  await installPanelTools(layout);
  await installLauncher(layout, { sourceApp });
  return layout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  installCodexIntegration().catch((error) => {
    console.error(`Codex integration installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
