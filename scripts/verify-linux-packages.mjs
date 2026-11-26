#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRuntimeIntegrity } from "./runtime-integrity.mjs";

const debPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const appImagePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!debPath || !appImagePath || process.argv.length !== 4) {
  throw new Error("Usage: verify-linux-packages.mjs <package.deb> <package.AppImage>");
}
if (process.platform !== "linux") {
  throw new Error("Linux packages must be verified on Linux");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message
      || result.stderr?.trim()
      || result.stdout?.trim()
      || `${command} failed`,
    );
  }
  return result.stdout.trim();
}

async function assertExecutable(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || (details.mode & 0o111) === 0) {
    throw new Error(`Expected executable file: ${filePath}`);
  }
}

async function assertElfX64(filePath) {
  const header = Buffer.alloc(20);
  const file = await open(filePath, "r");
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  await file.close();
  if (
    bytesRead !== header.length
    || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || header[4] !== 2
    || header[5] !== 1
    || header.readUInt16LE(18) !== 0x3e
  ) {
    throw new Error(`Expected Linux x86_64 ELF: ${filePath}`);
  }
}

async function verifyPackageRoot(root, label) {
  const launcherPath = path.join(root, "usr", "bin", "codex-panel-launcher");
  const runtimePath = path.join(root, "usr", "bin", "codex-panel-runtime");
  const resourceRoot = path.join(root, "usr", "lib", "Codex Panel");
  const panelctlPath = path.join(resourceRoot, "bin", "panelctl");
  const requiredResources = [
    "app/dist/web/index.html",
    "app/inject/codex-panel.user.js",
    "app/skills/manage-panel/SKILL.md",
    "app/skills/handoff-panel/SKILL.md",
  ];

  await assertExecutable(launcherPath);
  await assertElfX64(launcherPath);
  await assertExecutable(runtimePath);
  await assertElfX64(runtimePath);
  await assertExecutable(panelctlPath);
  await verifyRuntimeIntegrity(resourceRoot, runtimePath);
  for (const resource of requiredResources) {
    const details = await stat(path.join(resourceRoot, resource));
    if (!details.isFile()) throw new Error(`${label} is missing ${resource}`);
  }
  const wrapper = await readFile(panelctlPath, "utf8");
  if (!wrapper.includes("codex-panel-runtime\" ctl")) {
    throw new Error(`${label} panelctl does not use the packaged Rust CLI`);
  }
  if (!run(runtimePath, ["--help"]).includes("codex-panel-runtime")) {
    throw new Error(`${label} Rust runtime did not answer --help`);
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-panel-linux-packages."));
try {
  if (run("dpkg-deb", ["--field", debPath, "Architecture"]) !== "amd64") {
    throw new Error("Debian package architecture is not amd64");
  }
  const debRoot = path.join(temporaryRoot, "deb");
  run("dpkg-deb", ["--extract", debPath, debRoot]);
  await verifyPackageRoot(debRoot, "Debian package");

  await assertExecutable(appImagePath);
  await assertElfX64(appImagePath);
  const appImageRoot = path.join(temporaryRoot, "appimage");
  await mkdir(appImageRoot);
  run(appImagePath, ["--appimage-extract"], {
    cwd: appImageRoot,
  });
  await verifyPackageRoot(path.join(appImageRoot, "squashfs-root"), "AppImage");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Verified Linux x64 deb and AppImage package contents");
