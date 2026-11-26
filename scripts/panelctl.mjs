#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// npm 链接仅负责开发时编译和转发；安装包里的 panelctl 直接执行原生二进制。
const manifest = fileURLToPath(new URL("../runtime/Cargo.toml", import.meta.url));
const result = spawnSync("cargo", ["run", "--quiet", "--locked", "--manifest-path", manifest,
  "--bin", "panelctl", "--", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
