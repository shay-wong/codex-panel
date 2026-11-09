import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../scripts/build-windows-app.mjs", import.meta.url), "utf8"))
  .replace('import { spawnSync } from "node:child_process";', "");

function build(environment = {}, args = []) {
  const calls = [];
  vm.runInNewContext(source, {
    URL,
    process: {
      platform: "win32",
      execPath: "fixture/node.exe",
      argv: ["fixture/node.exe", "scripts/build-windows-app.mjs", ...args],
      env: {
        npm_execpath: "fixture/npm-cli.js",
        CODEX_PANEL_CREATE_UPDATER_ARTIFACTS: "1",
        CODEX_PANEL_UPDATER_PUBLIC_KEY: "fixture-updater-key",
        ...environment,
      },
    },
    spawnSync(command, args, options) {
      calls.push({ command, args: Array.from(args), options });
      return { status: 0 };
    },
  });
  return calls;
}

test("Windows without an Authenticode certificate still builds Tauri updater artifacts", () => {
  for (const thumbprint of [undefined, "", " \n\t "]) {
    const calls = build({ CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint });
    assert.equal(calls.length, 2);
    const tauri = calls[1];
    assert.equal(tauri.command, "fixture/node.exe");
    assert.equal(tauri.args[0], "fixture/npm-cli.js");
    assert.ok(tauri.args.includes("src-tauri/tauri.windows.conf.json"));
    assert.ok(!tauri.args.includes("--no-sign"), "the updater must still be signed");
    const config = JSON.parse(tauri.args.at(-1));
    assert.equal(config.bundle.windows, undefined);
    assert.equal(config.bundle.createUpdaterArtifacts, true);
    assert.equal(config.plugins.updater.pubkey, "fixture-updater-key");
    assert.equal(tauri.options.env.CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT, "");
  }
});

test("Windows with a certificate preserves normalized Authenticode settings", () => {
  const calls = build({
    CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: ` ${"ab".repeat(20)} `,
    CODEX_PANEL_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.invalid/",
  });
  const config = JSON.parse(calls[1].args.at(-1));
  assert.deepEqual(config.bundle.windows, {
    certificateThumbprint: "AB".repeat(20),
    digestAlgorithm: "sha256",
    timestampUrl: "https://timestamp.example.invalid/",
    tsp: true,
  });
  assert.equal(calls[1].options.env.CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT, "AB".repeat(20));
  assert.equal(calls[1].options.env.TAURI_SKIP_SIDECAR_SIGNATURE_CHECK, "true");
});

test("the explicit unsigned command ignores an inherited certificate without disabling updater signing", () => {
  const calls = build({ CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: "AB".repeat(20) }, ["--unsigned"]);
  const config = JSON.parse(calls[1].args.at(-1));
  assert.equal(config.bundle.windows, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(calls[1].options.env.CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT, "");
  assert.ok(!calls[1].args.includes("--no-sign"));
});

test("invalid configured Windows signing settings do not fall back to unsigned", () => {
  assert.throws(() => build({ CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: "invalid" }), /40-character SHA-1/);
  assert.throws(() => build({
    CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT: "AB".repeat(20),
    CODEX_PANEL_WINDOWS_TIMESTAMP_URL: "file:///tmp/timestamp",
  }), /must be an HTTP\(S\) URL/);
});
