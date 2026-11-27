#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCodexDeltaTool } from "./prepare-codex-delta.mjs";
import { ensureCodexTransport } from "./prepare-codex-transport.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supported = new Set(["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]);
const args = process.argv.slice(2);
const target = args.length === 0
  ? process.platform === "darwin" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu"
  : args.length === 2 && args[0] === "--target" ? args[1] : null;
if (!supported.has(target)) throw new Error("Expected --target with a supported Rust target");
if (target.includes("apple") !== (process.platform === "darwin")
  || target.includes("windows") !== (process.platform === "win32")) {
  throw new Error("Rust app resources must be prepared on the target operating system");
}

const binaries = path.join(root, "src-tauri/binaries");
const resources = path.join(root, "src-tauri/resources");
const app = path.join(resources, "app");
const executable = process.platform === "win32" ? "codex-panel-runtime.exe" : "codex-panel-runtime";
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

await mkdir(binaries, { recursive: true });
const triples = target === "universal-apple-darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [target];
for (const triple of triples) {
  run("cargo", ["build", "--locked", "--release", "--manifest-path", "runtime/Cargo.toml", "--target", triple, "--bin", "codex-panel-runtime"]);
}
const output = path.join(binaries, `codex-panel-runtime-${target}${process.platform === "win32" ? ".exe" : ""}`);
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, "runtime/target");
const inputs = triples.map(triple => path.join(targetDirectory, triple, "release", executable));
if (inputs.length === 2) run("/usr/bin/lipo", ["-create", ...inputs, "-output", output]);
else await copyFile(inputs[0], output);
await chmod(output, 0o755);
const signingIdentity = process.env.CODEX_PANEL_CODESIGN_IDENTITY?.trim()
  || process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
// 先签 sidecar 再计算清单，避免最终签名改变清单中的哈希。
if (process.platform === "darwin") {
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--sign", signingIdentity, output]);
}
// Tauri 分别编译双架构时按各自后缀找 sidecar，仍须使用同一份已签名通用文件。
if (triples.length === 2) {
  for (const triple of triples) await copyFile(output, path.join(binaries, `codex-panel-runtime-${triple}`));
}

// 资源目录重新生成，避免上一次 Node 构建的运行时或依赖残留在原生包内。
await rm(resources, { recursive: true, force: true });
await mkdir(app, { recursive: true });
for (const directory of ["dist/web", "inject", "skills"]) {
  await cp(path.join(root, directory), path.join(app, directory), { recursive: true });
}
if (process.platform === "darwin") {
  const delta = await ensureCodexDeltaTool({ projectRoot: root });
  const transport = await ensureCodexTransport({ projectRoot: root, signingIdentity, target });
  await mkdir(path.join(app, "tools"), { recursive: true });
  await copyFile(delta.binaryPath, path.join(app, "tools/BinaryDelta"));
  await copyFile(delta.licensePath, path.join(app, "tools/Sparkle-LICENSE"));
  await copyFile(transport.binaryPath, path.join(app, "tools/CodexTransport"));
  for (const name of ["BinaryDelta", "CodexTransport"]) await chmod(path.join(app, "tools", name), 0o755);
}
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(path.join(resources, "codex-panel-launcher.json"), JSON.stringify({
  generator: "codex-panel", definitionVersion: 12, launcher: "tauri", runtime: "rust", version: manifest.version,
}));
await mkdir(path.join(resources, "bin"), { recursive: true });
if (process.platform === "win32") {
  await writeFile(path.join(resources, "bin/panelctl.cmd"), '@echo off\r\nsetlocal\r\nset "CODEX_PANEL_RUNTIME_FILE=%LOCALAPPDATA%\\Codex Panel\\data\\launcher-runtime.json"\r\n"%~dp0..\\codex-panel-runtime.exe" ctl %*\r\nexit /b %ERRORLEVEL%\r\n');
} else {
  const mac = process.platform === "darwin";
  const wrapper = `#!/bin/sh
set -eu
SCRIPT="$0"
if [ -L "$SCRIPT" ]; then SCRIPT="$(readlink "$SCRIPT")"; fi
DIRECTORY="$(CDPATH= cd -- "$(dirname -- "$SCRIPT")" && pwd)"
${mac ? 'export CODEX_PANEL_RUNTIME_FILE="$HOME/Library/Application Support/Codex Panel/data/launcher-runtime.json"' : 'if [ -z "${WSL_DISTRO_NAME-}${WSL_INTEROP-}${CODEX_PANEL_RUNTIME_FILE-}${CODEX_TASKBOARD_RUNTIME_FILE-}" ]; then\n  export CODEX_PANEL_RUNTIME_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/Codex Panel/data/launcher-runtime.json"\nfi'}
exec "$DIRECTORY/${mac ? "../../MacOS" : "../../../bin"}/codex-panel-runtime" ctl "$@"
`;
  await writeFile(path.join(resources, "bin/panelctl"), wrapper);
  await chmod(path.join(resources, "bin/panelctl"), 0o755);
}

async function entries(directory, prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const file = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Refusing runtime symbolic link: ${relative}`);
    if (info.isDirectory()) result.push(...await entries(file, relative));
    else if (info.isFile()) result.push({ path: relative, sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
    else throw new Error(`Unsupported runtime resource: ${relative}`);
  }
  return result;
}
const files = await entries(resources);
files.push({ path: executable, sha256: createHash("sha256").update(await readFile(output)).digest("hex") });
files.sort((a, b) => a.path.localeCompare(b.path, "en"));
await writeFile(path.join(resources, "runtime-integrity.json"), JSON.stringify({ version: 1, files }));
console.log(`Prepared Rust-only runtime resources for ${target}`);
