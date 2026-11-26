import { spawn } from "node:child_process";

const children = [
  // 开发入口和安装包复用同一套 Rust 服务；前端仍由 Vite 热更新。
  spawn("cargo", ["run", "--locked", "--manifest-path", "runtime/Cargo.toml", "--bin", "codex-panel-runtime", "--", "serve", "--dev"], {
    stdio: "inherit",
  }),
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:web"], {
    stdio: "inherit",
  }),
];

let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
