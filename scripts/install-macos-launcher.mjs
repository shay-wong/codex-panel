#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  directoryContentHash,
  installManagedDirectory,
  installManagedFile,
  pathExists,
  removeManagedInstallation,
} from "./managed-install.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const nativeLauncherRoot = path.join(projectRoot, "macos", "CodexPanelLauncher");
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
  "codex-cdp-pipe.mjs",
  "codex-injector-runtime.mjs",
  "codex-injector.mjs",
  "codex-rate-limits.mjs",
  "panel-supervisor.mjs",
];
const launcherName = "Codex Panel.app";
const legacyLauncherName = "Codex.app";
const launcherExecutableName = "CodexPanelLauncher";
const launcherIconBuilderName = "CodexPanelIconBuilder";
const launcherBundleIdentifier = "com.shay.codex-panel";
const legacyLauncherBundleIdentifier = "com.shay.codex-taskboard-launcher";
const launcherDefinitionVersion = 9;
const launcherMarkerName = "codex-panel-launcher.json";
const launcherConfigurationName = "launcher-config.json";
const officialCodexAppPath = "/Applications/ChatGPT.app";
const officialCodexExecutablePath = path.join(
  officialCodexAppPath,
  "Contents",
  "Resources",
  "codex",
);
const plistBuddyPath = "/usr/libexec/PlistBuddy";
const launchServicesRegister = [
  "/System/Library/Frameworks/CoreServices.framework",
  "Frameworks/LaunchServices.framework/Support/lsregister",
].join("/");

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

function parseCodeSigningIdentities(output) {
  const identities = new Map();
  for (const match of output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)) {
    identities.set(match[1], { hash: match[1], name: match[2] });
  }
  return [...identities.values()];
}

export function selectLauncherSigningIdentity({
  environment = {},
  existingIdentity,
  gitEmail,
  identities = [],
} = {}) {
  const explicitIdentity = environment.CODEX_PANEL_CODESIGN_IDENTITY?.trim();
  if (explicitIdentity) return explicitIdentity;

  if (
    existingIdentity
    && existingIdentity !== "-"
    && identities.some(({ hash, name }) => (
      hash === existingIdentity || name === existingIdentity
    ))
  ) return existingIdentity;

  const normalizedEmail = gitEmail?.trim().toLowerCase();
  if (!normalizedEmail) return "-";
  const matchingIdentities = identities.filter(({ name }) => (
    name.startsWith("Apple Development:")
    && name.toLowerCase().includes(normalizedEmail)
  ));
  return matchingIdentities.length === 1 ? matchingIdentities[0].hash : "-";
}

function codeSigningDetails(appPath) {
  const details = run(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", appPath],
    { allowFailure: true },
  );
  const requirement = run(
    "/usr/bin/codesign",
    ["-d", "-r-", appPath],
    { allowFailure: true },
  );
  const detailsText = `${details.stdout || ""}\n${details.stderr || ""}`;
  const requirementText = `${requirement.stdout || ""}\n${requirement.stderr || ""}`;
  return {
    authority: detailsText.match(/^Authority=(.+)$/m)?.[1] ?? null,
    designatedRequirement: requirementText.match(/^#?\s*designated => (.+)$/m)?.[1] ?? null,
  };
}

function resolveLauncherSigningIdentity(currentLauncherPath) {
  const identityResult = run(
    "/usr/bin/security",
    ["find-identity", "-p", "codesigning", "-v"],
    { allowFailure: true },
  );
  const emailResult = run(
    "/usr/bin/git",
    ["config", "--global", "user.email"],
    { allowFailure: true },
  );
  const identities = identityResult.status === 0
    ? parseCodeSigningIdentities(identityResult.stdout)
    : [];
  const currentAuthority = currentLauncherPath
    ? codeSigningDetails(currentLauncherPath).authority
    : null;
  const existingIdentity = identities.find(({ name }) => name === currentAuthority)?.hash;
  return selectLauncherSigningIdentity({
    environment: process.env,
    existingIdentity,
    gitEmail: emailResult.status === 0 ? emailResult.stdout : "",
    identities,
  });
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

function plistValue(appPath, key) {
  const result = run(plistBuddyPath, [
    "-c",
    `Print :${key}`,
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

async function assertManagedLauncher(appPath) {
  const marker = await managedMarker(appPath);
  if (marker?.generator === "codex-panel") return;
  throw new Error(`Refusing to replace an unmanaged application at ${appPath}`);
}

export function launcherConfiguration({
  codexAppPath = officialCodexAppPath,
  codexAppDesignatedRequirement,
  codexAppExecutablePath,
  codexExecutablePath = officialCodexExecutablePath,
  codexExecutableDesignatedRequirement,
  dataDirectory,
  logPath,
  nodeBinPath,
  nodePath,
  nodeSha256,
  runtimeRelativePath = "runtime",
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
  return {
    version: 4,
    runtimeRelativePath,
    dataDirectory,
    logPath,
    nodePath,
    nodeSha256,
    pathValue,
    codexAppPath,
    codexAppDesignatedRequirement,
    codexAppExecutablePath,
    codexExecutablePath,
    codexExecutableDesignatedRequirement,
    panelPort: 47823,
    cdpPort: 9229,
  };
}

function launcherMarker(
  layout,
  sourceHash,
  runtimeHash,
  signingIdentity,
  designatedRequirement = null,
) {
  return {
    generator: "codex-panel",
    definitionVersion: launcherDefinitionVersion,
    launcher: launcherName,
    dataDirectory: layout.dataDirectory,
    nodePath: process.execPath,
    runtimeDirectory: layout.runtimeDirectory,
    signingIdentity,
    designatedRequirement,
    runtimeHash,
    sourceHash,
  };
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function resolveCodexAppExecutablePath(codexAppPath = officialCodexAppPath) {
  const executableName = plistValue(codexAppPath, "CFBundleExecutable");
  if (!executableName || path.basename(executableName) !== executableName) {
    throw new Error(`Invalid Codex application executable: ${executableName || "missing"}`);
  }
  return path.join(codexAppPath, "Contents", "MacOS", executableName);
}

function verifiedDesignatedRequirement(appPath, label) {
  const verification = run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    { allowFailure: true },
  );
  if (verification.status !== 0) {
    const detail = verification.stderr?.trim()
      || verification.stdout?.trim()
      || verification.error?.message
      || `exit status ${verification.status}`;
    throw new Error(`${label} signature verification failed: ${detail}`);
  }
  const requirement = codeSigningDetails(appPath).designatedRequirement;
  if (!requirement) throw new Error(`Unable to read ${label} designated requirement`);
  return requirement;
}

async function collectLauncherSourceFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".build") continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectLauncherSourceFiles(absolutePath, relativePath));
    } else if (entry.name === "Package.swift" || entry.name.endsWith(".swift")) {
      files.push({ absolutePath, relativePath });
    }
  }
  return files;
}

async function nativeLauncherSourceHash(configuration) {
  const hash = createHash("sha256");
  const files = await collectLauncherSourceFiles(nativeLauncherRoot);
  for (const file of files.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
  ))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(await readFile(file.absolutePath));
    hash.update("\0");
  }
  hash.update(JSON.stringify(configuration));
  return hash.digest("hex");
}

async function launcherBundleMetadataIsCurrent(launcherPath) {
  return bundleIdentifier(launcherPath) === launcherBundleIdentifier
    && plistValue(launcherPath, "CFBundleDisplayName") === "Codex Panel"
    && plistValue(launcherPath, "CFBundleExecutable") === launcherExecutableName
    && plistValue(launcherPath, "CFBundleIconFile") === "CodexPanel"
    && plistValue(launcherPath, "NSRequiresAquaSystemAppearance") === "false"
    && plistValue(launcherPath, "LSUIElement") === null
    && await pathExists(path.join(launcherPath, "Contents", "MacOS", launcherExecutableName))
    && await pathExists(path.join(launcherPath, "Contents", "Resources", "CodexPanel.icns"))
    && await pathExists(path.join(launcherPath, "Contents", "Resources", "CodexPanelDark.icns"))
    && await pathExists(path.join(launcherPath, "Contents", "Resources", "CodexBaseLight.png"))
    && await pathExists(path.join(launcherPath, "Contents", "Resources", "CodexBaseDark.png"))
    && await pathExists(path.join(
      launcherPath,
      "Contents",
      "Resources",
      "runtime",
      "scripts",
      "codex-injector.mjs",
    ))
    && await pathExists(path.join(
      launcherPath,
      "Contents",
      "Resources",
      "runtime",
      "server",
      "index.mjs",
    ))
    && await pathExists(path.join(launcherPath, "Contents", "Resources", launcherConfigurationName));
}

function signingIdentityName(signingIdentity) {
  if (signingIdentity === "-") return null;
  const identities = run(
    "/usr/bin/security",
    ["find-identity", "-p", "codesigning", "-v"],
    { allowFailure: true },
  );
  if (identities.status !== 0) return /^[0-9a-f]{40}$/i.test(signingIdentity)
    ? null
    : signingIdentity;
  const match = parseCodeSigningIdentities(identities.stdout).find(({ hash, name }) => (
    hash === signingIdentity || name === signingIdentity
  ));
  return match?.name ?? (/^[0-9a-f]{40}$/i.test(signingIdentity) ? null : signingIdentity);
}

async function launcherIsCurrent(launcherPath, expectedMarker) {
  const marker = await managedMarker(launcherPath);
  const signatureValid = run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", launcherPath],
    { allowFailure: true },
  ).status === 0;
  if (!signatureValid) return false;
  const signingDetails = codeSigningDetails(launcherPath);
  const expectedAuthority = signingIdentityName(expectedMarker.signingIdentity);
  if (
    expectedMarker.signingIdentity === "-"
    || !expectedAuthority
    || signingDetails.authority !== expectedAuthority
    || !signingDetails.designatedRequirement
    || marker?.designatedRequirement !== signingDetails.designatedRequirement
  ) return false;
  const comparableMarker = { ...marker, designatedRequirement: null };
  return JSON.stringify(comparableMarker) === JSON.stringify(expectedMarker)
    && await launcherBundleMetadataIsCurrent(launcherPath);
}

export async function resolveLauncherIcons(codexAppPath = officialCodexAppPath) {
  const officialResourcesPath = path.join(
    codexAppPath,
    "Contents",
    "Resources",
  );
  const lightSourcePath = path.join(officialResourcesPath, "icon-codex-light.png");
  const darkSourcePath = path.join(officialResourcesPath, "icon-codex-dark-color.png");
  for (const sourcePath of [lightSourcePath, darkSourcePath]) {
    if (!(await pathExists(sourcePath))) {
      throw new Error(`Required official Codex icon is missing: ${sourcePath}`);
    }
  }
  return { darkSourcePath, lightSourcePath };
}

function launcherInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Codex Panel</string>
  <key>CFBundleExecutable</key>
  <string>${launcherExecutableName}</string>
  <key>CFBundleIconFile</key>
  <string>CodexPanel</string>
  <key>CFBundleIdentifier</key>
  <string>${launcherBundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Codex Panel</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>${launcherDefinitionVersion}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSRequiresAquaSystemAppearance</key>
  <false/>
</dict>
</plist>
`;
}

async function buildNativeLauncherProducts(temporaryDirectory) {
  const scratchPath = path.join(temporaryDirectory, "swift-build");
  const swiftArguments = [
    "swift",
    "build",
    "--package-path",
    nativeLauncherRoot,
    "--configuration",
    "release",
    "--scratch-path",
    scratchPath,
  ];
  run("/usr/bin/xcrun", swiftArguments);
  const binPath = run("/usr/bin/xcrun", [
    ...swiftArguments,
    "--show-bin-path",
  ]).stdout.trim();
  return {
    launcherBinary: path.join(binPath, launcherExecutableName),
    iconBuilderBinary: path.join(binPath, launcherIconBuilderName),
  };
}

const launcherIconSizes = [
  { filename: "icon_16x16.png", idiomSize: "16x16", pixels: 16, scale: "1x" },
  { filename: "icon_16x16@2x.png", idiomSize: "16x16", pixels: 32, scale: "2x" },
  { filename: "icon_32x32.png", idiomSize: "32x32", pixels: 32, scale: "1x" },
  { filename: "icon_32x32@2x.png", idiomSize: "32x32", pixels: 64, scale: "2x" },
  { filename: "icon_128x128.png", idiomSize: "128x128", pixels: 128, scale: "1x" },
  { filename: "icon_128x128@2x.png", idiomSize: "128x128", pixels: 256, scale: "2x" },
  { filename: "icon_256x256.png", idiomSize: "256x256", pixels: 256, scale: "1x" },
  { filename: "icon_256x256@2x.png", idiomSize: "256x256", pixels: 512, scale: "2x" },
  { filename: "icon_512x512.png", idiomSize: "512x512", pixels: 512, scale: "1x" },
  { filename: "icon_512x512@2x.png", idiomSize: "512x512", pixels: 1024, scale: "2x" },
];

async function buildIcns(sourcePng, iconsetPath, outputPath) {
  await mkdir(iconsetPath);
  for (const icon of launcherIconSizes) {
    run("/usr/bin/sips", [
      "-z",
      String(icon.pixels),
      String(icon.pixels),
      sourcePng,
      "--out",
      path.join(iconsetPath, icon.filename),
    ]);
  }
  run("/usr/bin/iconutil", ["-c", "icns", iconsetPath, "-o", outputPath]);
  await rm(iconsetPath, { recursive: true });
}

async function buildLauncherIcons(
  iconBuilderBinary,
  lightSourcePath,
  darkSourcePath,
  resourcesPath,
  temporaryDirectory,
) {
  const lightPng = path.join(temporaryDirectory, "CodexPanel-light.png");
  const darkPng = path.join(temporaryDirectory, "CodexPanel-dark.png");
  run(iconBuilderBinary, [lightSourcePath, darkSourcePath, lightPng, darkPng]);
  await buildIcns(
    lightPng,
    path.join(temporaryDirectory, "CodexPanel.iconset"),
    path.join(resourcesPath, "CodexPanel.icns"),
  );
  await buildIcns(
    darkPng,
    path.join(temporaryDirectory, "CodexPanelDark.iconset"),
    path.join(resourcesPath, "CodexPanelDark.icns"),
  );
}

async function writeNativeLauncherBundle({
  configuration,
  iconSourcePaths,
  launcherPath,
  marker,
  runtimeSourcePath,
  temporaryDirectory,
}) {
  const contentsPath = path.join(launcherPath, "Contents");
  const macOSPath = path.join(contentsPath, "MacOS");
  const resourcesPath = path.join(contentsPath, "Resources");
  await mkdir(macOSPath, { recursive: true });
  await mkdir(resourcesPath, { recursive: true });
  await cp(runtimeSourcePath, path.join(resourcesPath, "runtime"), {
    preserveTimestamps: true,
    recursive: true,
  });

  const products = await buildNativeLauncherProducts(temporaryDirectory);
  const launcherBinaryPath = path.join(macOSPath, launcherExecutableName);
  await copyFile(products.launcherBinary, launcherBinaryPath);
  await chmod(launcherBinaryPath, 0o755);
  const baseLightPath = path.join(resourcesPath, "CodexBaseLight.png");
  const baseDarkPath = path.join(resourcesPath, "CodexBaseDark.png");
  for (const [sourcePath, outputPath] of [
    [iconSourcePaths.lightSourcePath, baseLightPath],
    [iconSourcePaths.darkSourcePath, baseDarkPath],
  ]) {
    run("/usr/bin/sips", ["-s", "format", "png", sourcePath, "--out", outputPath]);
  }
  await buildLauncherIcons(
    products.iconBuilderBinary,
    baseLightPath,
    baseDarkPath,
    resourcesPath,
    temporaryDirectory,
  );
  await writeFile(path.join(contentsPath, "Info.plist"), launcherInfoPlist());
  await writeFile(path.join(contentsPath, "PkgInfo"), "APPL????");
  await writeFile(
    path.join(resourcesPath, launcherConfigurationName),
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  await writeFile(
    path.join(resourcesPath, launcherMarkerName),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

async function removeLegacyLauncher(applicationsDirectory) {
  const legacyLauncherPath = path.join(applicationsDirectory, legacyLauncherName);
  if (!(await pathExists(legacyLauncherPath))) return;
  const marker = await managedMarker(legacyLauncherPath);
  if (
    marker?.generator !== "codex-panel"
    && bundleIdentifier(legacyLauncherPath) !== legacyLauncherBundleIdentifier
  ) return;
  run(launchServicesRegister, ["-u", legacyLauncherPath], { allowFailure: true });
  await rm(legacyLauncherPath, { recursive: true });
}

export async function installLauncher(layout, options = {}) {
  if (process.platform !== "darwin") {
    console.log("Skipping Codex launcher installation outside macOS.");
    return;
  }

  const applicationsDirectory = layout.applicationsDirectory;
  const launcherPath = path.join(applicationsDirectory, launcherName);
  const launcherExists = await pathExists(launcherPath);
  const signingIdentity = options.signingIdentity
    ?? resolveLauncherSigningIdentity(launcherExists ? launcherPath : null);
  const codexAppPath = options.codexAppPath ?? officialCodexAppPath;
  const codexAppExecutablePath = options.codexAppExecutablePath
    ?? resolveCodexAppExecutablePath(codexAppPath);
  const codexExecutablePath = options.codexExecutablePath
    ?? path.join(codexAppPath, "Contents", "Resources", "codex");
  for (const [label, executablePath] of [
    ["Codex application", codexAppExecutablePath],
    ["Codex CLI", codexExecutablePath],
  ]) {
    if (!(await pathExists(executablePath))) {
      throw new Error(`Required ${label} executable is missing: ${executablePath}`);
    }
  }
  const codexAppDesignatedRequirement = options.codexAppDesignatedRequirement
    ?? verifiedDesignatedRequirement(codexAppPath, "Codex application");
  const codexExecutableDesignatedRequirement = options.codexExecutableDesignatedRequirement
    ?? verifiedDesignatedRequirement(codexExecutablePath, "Codex CLI");
  const configuration = launcherConfiguration({
    codexAppPath,
    codexAppDesignatedRequirement,
    codexAppExecutablePath,
    codexExecutablePath,
    codexExecutableDesignatedRequirement,
    dataDirectory: layout.dataDirectory,
    logPath: layout.logPath,
    nodeBinPath: path.dirname(process.execPath),
    nodePath: process.execPath,
    nodeSha256: await sha256File(process.execPath),
    runtimeRelativePath: "runtime",
    userBinDirectory: layout.userBinDirectory,
  });
  const runtimeHash = await directoryContentHash(layout.runtimeDirectory);
  const marker = launcherMarker(
    layout,
    await nativeLauncherSourceHash(configuration),
    runtimeHash,
    signingIdentity,
  );

  if (launcherExists) {
    await assertManagedLauncher(launcherPath);
    if (await launcherIsCurrent(launcherPath, marker)) {
      run(launchServicesRegister, ["-f", launcherPath]);
      await removeLegacyLauncher(applicationsDirectory);
      console.log(`Codex Panel launcher already current at ${launcherPath}`);
      return;
    }
  }

  const iconSourcePaths = options.iconSourcePaths ?? await resolveLauncherIcons(codexAppPath);
  await mkdir(applicationsDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(applicationsDirectory, ".codex-panel-launcher-"),
  );
  const temporaryLauncherPath = path.join(temporaryDirectory, launcherName);

  try {
    await writeNativeLauncherBundle({
      configuration,
      iconSourcePaths,
      launcherPath: temporaryLauncherPath,
      marker,
      runtimeSourcePath: layout.runtimeDirectory,
      temporaryDirectory,
    });
    run("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      signingIdentity,
      temporaryLauncherPath,
    ]);
    if (signingIdentity !== "-") {
      const designatedRequirement = codeSigningDetails(
        temporaryLauncherPath,
      ).designatedRequirement;
      if (!designatedRequirement) {
        throw new Error("Unable to read the launcher's designated requirement");
      }
      const signedMarker = launcherMarker(
        layout,
        marker.sourceHash,
        marker.runtimeHash,
        signingIdentity,
        designatedRequirement,
      );
      await writeFile(
        path.join(
          temporaryLauncherPath,
          "Contents",
          "Resources",
          launcherMarkerName,
        ),
        `${JSON.stringify(signedMarker, null, 2)}\n`,
      );
      run("/usr/bin/codesign", [
        "--force",
        "--deep",
        "--sign",
        signingIdentity,
        temporaryLauncherPath,
      ]);
      const finalRequirement = codeSigningDetails(
        temporaryLauncherPath,
      ).designatedRequirement;
      if (finalRequirement !== designatedRequirement) {
        throw new Error("Launcher designated requirement changed during final signing");
      }
    }

    if (await pathExists(launcherPath)) await rm(launcherPath, { recursive: true });
    await rename(temporaryLauncherPath, launcherPath);
    run(launchServicesRegister, ["-f", launcherPath]);
    await removeLegacyLauncher(applicationsDirectory);
    console.log(`Codex Panel launcher installed at ${launcherPath}`);
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
