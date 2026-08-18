#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const target = "x86_64-pc-windows-msvc";
const thumbprint = (process.env.CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT || "")
  .replaceAll(/\s/g, "")
  .toUpperCase();
if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
  throw new Error(
    "CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT must be the 40-character SHA-1 thumbprint of the Windows code-signing certificate",
  );
}

const timestampUrl = new URL(
  process.env.CODEX_PANEL_WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com",
);
if (!new Set(["http:", "https:"]).has(timestampUrl.protocol)
  || timestampUrl.username
  || timestampUrl.password) {
  throw new Error("CODEX_PANEL_WINDOWS_TIMESTAMP_URL must be an HTTP(S) URL without credentials");
}

function runNpm(args, extraEnvironment = {}) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

if (process.platform !== "win32") {
  throw new Error("Codex Panel for Windows must be built and signed on Windows");
}

runNpm(["run", "app:prepare", "--", "--target", target]);
runNpm([
  "run",
  "tauri",
  "--",
  "build",
  "--target",
  target,
  "--bundles",
  "nsis",
  "--ci",
  "--config",
  JSON.stringify({
    bundle: {
      windows: {
        certificateThumbprint: thumbprint,
        digestAlgorithm: "sha256",
        timestampUrl: timestampUrl.toString(),
        tsp: true,
      },
    },
  }),
], {
  CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint,
  TAURI_SKIP_SIDECAR_SIGNATURE_CHECK: "true",
});
