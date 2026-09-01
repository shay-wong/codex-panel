#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverRuntimePackages } from "./runtime-packages.mjs";

const nodeVersion = "22.23.2";
const nodeArchitectures = ["arm64", "x64"];
const nodeArchiveSha256 = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const windowsTarget = "x86_64-pc-windows-msvc";
const windowsNodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const windowsNodeArchiveSha256 =
  "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
const linuxTarget = "x86_64-unknown-linux-gnu";
const linuxNodeArchiveName = `node-v${nodeVersion}-linux-x64.tar.gz`;
const linuxNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";
const supportedTargets = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "universal-apple-darwin",
  windowsTarget,
  linuxTarget,
]);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const projectManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const tauriRoot = path.join(projectRoot, "src-tauri");
const binariesDirectory = path.join(tauriRoot, "binaries");
const resourcesDirectory = path.join(tauriRoot, "resources");
const runtimeCacheDirectory = path.join(projectRoot, "dist", "tauri-runtime-cache");
const extractionDirectory = path.join(runtimeCacheDirectory, "extracted");
const target = parseTarget(process.argv.slice(2));

if (target === windowsTarget && process.platform !== "win32") {
  throw new Error("Codex Panel for Windows must be prepared on Windows");
}
if (target === linuxTarget && process.platform !== "linux") {
  throw new Error("Codex Panel for Linux must be prepared on Linux");
}
if (target !== windowsTarget && target !== linuxTarget && process.platform !== "darwin") {
  throw new Error("Codex Panel for macOS must be prepared on macOS");
}

function parseTarget(argv) {
  let selected = process.platform === "win32"
    ? windowsTarget
    : process.platform === "linux"
      ? linuxTarget
      : "universal-apple-darwin";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") selected = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!supportedTargets.has(selected)) {
    throw new Error(`Unsupported Tauri target: ${selected}`);
  }
  return selected;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyRuntimePackage(packageName, destinationNodeModules, copiedPackages) {
  if (copiedPackages.has(packageName)) return;
  copiedPackages.add(packageName);
  const packageSegments = packageName.split("/");
  const sourcePath = path.join(projectRoot, "node_modules", ...packageSegments);
  const destinationPath = path.join(destinationNodeModules, ...packageSegments);
  const manifest = JSON.parse(await readFile(path.join(sourcePath, "package.json"), "utf8"));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyRuntimePackage(dependency, destinationNodeModules, copiedPackages);
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function runtimeIntegrityEntries(rootPath, relativePath = "") {
  const entries = [];
  const directoryEntries = await readdir(path.join(rootPath, relativePath), {
    withFileTypes: true,
  });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of directoryEntries) {
    const childRelativePath = path.posix.join(relativePath, entry.name);
    const childPath = path.join(rootPath, ...childRelativePath.split("/"));
    const details = await lstat(childPath);
    if (details.isSymbolicLink()) {
      throw new Error(`Refusing to package a runtime symbolic link: ${childRelativePath}`);
    }
    if (details.isDirectory()) {
      entries.push(...await runtimeIntegrityEntries(rootPath, childRelativePath));
    } else if (details.isFile()) {
      entries.push({ path: childRelativePath, sha256: await sha256(childPath) });
    } else {
      throw new Error(`Unsupported packaged runtime entry: ${childRelativePath}`);
    }
  }
  return entries;
}

async function writeRuntimeIntegrityManifest() {
  const manifestPath = path.join(resourcesDirectory, "runtime-integrity.json");
  await rm(manifestPath, { force: true });
  const files = await runtimeIntegrityEntries(resourcesDirectory);
  const nodePath = target === windowsTarget
    ? path.join(binariesDirectory, `node-${windowsTarget}.exe`)
    : target === linuxTarget
      ? path.join(binariesDirectory, `codex-panel-node-${linuxTarget}`)
      : path.join(binariesDirectory, "node-universal-apple-darwin");
  files.push({
    path: target === windowsTarget
      ? "node.exe"
      : target === linuxTarget
        ? "codex-panel-node"
        : "node",
    sha256: await sha256(nodePath),
  });
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  await writeFile(
    manifestPath,
    JSON.stringify({ version: 1, files }),
  );
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }
  const temporaryPath = `${destination}.download`;
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await rename(temporaryPath, destination);
}

async function verifiedNodeArchive(archiveName, expectedChecksum) {
  const archivePath = path.join(runtimeCacheDirectory, archiveName);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== expectedChecksum) {
    await rm(archivePath, { force: true });
    await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archivePath);
  }
  if ((await sha256(archivePath)) !== expectedChecksum) {
    throw new Error(`Checksum verification failed for ${archiveName}`);
  }
  return { archiveName, archivePath };
}

async function extractNodeRuntime(architecture) {
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const { archivePath } = await verifiedNodeArchive(
    archiveName,
    nodeArchiveSha256[architecture],
  );
  const destination = path.join(extractionDirectory, architecture);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
  return path.join(destination, `node-v${nodeVersion}-darwin-${architecture}`);
}

async function prepareMacNodeRuntime() {
  const runtimes = new Map();
  for (const architecture of nodeArchitectures) {
    runtimes.set(architecture, await extractNodeRuntime(architecture));
  }

  const universalNodePath = path.join(binariesDirectory, "node-universal-apple-darwin");
  await mkdir(binariesDirectory, { recursive: true });
  run("/usr/bin/lipo", [
    "-create",
    path.join(runtimes.get("arm64"), "bin", "node"),
    path.join(runtimes.get("x64"), "bin", "node"),
    "-output",
    universalNodePath,
  ]);
  await chmod(universalNodePath, 0o755);
  const architectures = run("/usr/bin/lipo", ["-archs", universalNodePath]);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`Universal Node runtime has unexpected architectures: ${architectures}`);
  }

  for (const targetTriple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const targetPath = path.join(binariesDirectory, `node-${targetTriple}`);
    await rm(targetPath, { force: true });
    await link(universalNodePath, targetPath);
  }
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtimes.get("arm64"), "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function prepareWindowsNodeRuntime() {
  const { archivePath } = await verifiedNodeArchive(
    windowsNodeArchiveName,
    windowsNodeArchiveSha256,
  );
  const destination = path.join(extractionDirectory, "win-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run(path.join(process.env.SystemRoot, "System32", "tar.exe"), [
    "-xf",
    archivePath,
    "-C",
    destination,
  ]);

  const runtime = path.join(destination, `node-v${nodeVersion}-win-x64`);
  const targetPath = path.join(binariesDirectory, `node-${windowsTarget}.exe`);
  await mkdir(binariesDirectory, { recursive: true });
  await rm(targetPath, { force: true });
  await copyFile(path.join(runtime, "node.exe"), targetPath);
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtime, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function prepareLinuxNodeRuntime() {
  const { archivePath } = await verifiedNodeArchive(
    linuxNodeArchiveName,
    linuxNodeArchiveSha256,
  );
  const destination = path.join(extractionDirectory, "linux-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);

  const runtime = path.join(destination, `node-v${nodeVersion}-linux-x64`);
  const targetPath = path.join(
    binariesDirectory,
    `codex-panel-node-${linuxTarget}`,
  );
  await mkdir(binariesDirectory, { recursive: true });
  await rm(targetPath, { force: true });
  await copyFile(path.join(runtime, "bin", "node"), targetPath);
  await chmod(targetPath, 0o755);
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtime, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function copyApplicationResources() {
  const appResources = path.join(resourcesDirectory, "app");
  await rm(resourcesDirectory, { recursive: true, force: true });
  await mkdir(appResources, { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "server"), path.join(appResources, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(appResources, "shared"), { recursive: true }),
    cp(path.join(projectRoot, "dist", "web"), path.join(appResources, "dist", "web"), {
      recursive: true,
    }),
    cp(
      path.join(projectRoot, "skills", "manage-panel"),
      path.join(appResources, "skills", "manage-panel"),
      { recursive: true },
    ),
    cp(
      path.join(projectRoot, "skills", "handoff-panel"),
      path.join(appResources, "skills", "handoff-panel"),
      { recursive: true },
    ),
  ]);
  await mkdir(path.join(appResources, "scripts"), { recursive: true });
  for (const fileName of [
    "codex-cdp-pipe.mjs",
    "codex-injector-control.mjs",
    "codex-injector.mjs",
    "codex-injector-runtime.mjs",
    "codex-rate-limits.mjs",
    "panel-supervisor.mjs",
  ]) {
    await copyFile(
      path.join(projectRoot, "scripts", fileName),
      path.join(appResources, "scripts", fileName),
    );
  }
  await mkdir(path.join(appResources, "inject"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "inject", "codex-panel.user.js"),
    path.join(appResources, "inject", "codex-panel.user.js"),
  );
  await mkdir(path.join(appResources, "cli"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "cli", "panelctl.mjs"),
    path.join(appResources, "cli", "panelctl.mjs"),
  );
  const destinationNodeModules = path.join(appResources, "node_modules");
  await mkdir(destinationNodeModules, { recursive: true });
  const copiedPackages = new Set();
  const runtimePackages = await discoverRuntimePackages(
    appResources,
    projectManifest.dependencies ?? {},
  );
  for (const packageName of runtimePackages) {
    await copyRuntimePackage(packageName, destinationNodeModules, copiedPackages);
  }
  await writeFile(
    path.join(resourcesDirectory, "codex-panel-launcher.json"),
    `${JSON.stringify({
      generator: "codex-panel",
      definitionVersion: 11,
      launcher: "tauri",
      version: projectManifest.version,
    }, null, 2)}\n`,
  );

  if (target === windowsTarget) {
    const taskctlWrapper = [
      "@echo off",
      "setlocal",
      "set \"CODEX_PANEL_DATA_DIR=%LOCALAPPDATA%\\Codex Panel\\data\"",
      "set \"CODEX_PANEL_RUNTIME_FILE=%CODEX_PANEL_DATA_DIR%\\launcher-runtime.json\"",
      "\"%~dp0..\\node.exe\" \"%~dp0..\\app\\cli\\panelctl.mjs\" %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    const panelctlPath = path.join(resourcesDirectory, "bin", "panelctl.cmd");
    await mkdir(path.dirname(panelctlPath), { recursive: true });
    await writeFile(panelctlPath, taskctlWrapper);
    return;
  }

  if (target === linuxTarget) {
    const panelctlWrapper = `#!/bin/sh
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
export CODEX_PANEL_DATA_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/Codex Panel/data"
if [ -z "\${WSL_DISTRO_NAME-}" ] && [ -z "\${WSL_INTEROP-}" ] && [ -z "\${CODEX_PANEL_RUNTIME_FILE-}" ] && [ -z "\${CODEX_TASKBOARD_RUNTIME_FILE-}" ]; then
  export CODEX_PANEL_RUNTIME_FILE="$CODEX_PANEL_DATA_DIR/launcher-runtime.json"
fi
exec "$RESOURCE_DIR/../../bin/codex-panel-node" "$RESOURCE_DIR/app/cli/panelctl.mjs" "$@"
`;
    const panelctlPath = path.join(resourcesDirectory, "bin", "panelctl");
    await mkdir(path.dirname(panelctlPath), { recursive: true });
    await writeFile(panelctlPath, panelctlWrapper);
    await chmod(panelctlPath, 0o755);
    return;
  }

  const taskctlWrapper = `#!/bin/zsh
set -u

SCRIPT_PATH="$0"
if [ -L "$SCRIPT_PATH" ]; then
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export CODEX_PANEL_DATA_DIR="$HOME/Library/Application Support/Codex Panel/data"
export CODEX_PANEL_RUNTIME_FILE="$CODEX_PANEL_DATA_DIR/launcher-runtime.json"
exec "$CONTENTS_DIR/MacOS/node" "$CONTENTS_DIR/Resources/app/cli/panelctl.mjs" "$@"
`;
  const panelctlPath = path.join(resourcesDirectory, "bin", "panelctl");
  await mkdir(path.dirname(panelctlPath), { recursive: true });
  await writeFile(panelctlPath, taskctlWrapper);
  await chmod(panelctlPath, 0o755);
}

await mkdir(runtimeCacheDirectory, { recursive: true });
await copyApplicationResources();
if (target === windowsTarget) await prepareWindowsNodeRuntime();
else if (target === linuxTarget) await prepareLinuxNodeRuntime();
else await prepareMacNodeRuntime();
await writeRuntimeIntegrityManifest();
await rm(extractionDirectory, { recursive: true, force: true });
console.log(`Prepared Tauri resources for ${target} with Node.js ${nodeVersion}`);
