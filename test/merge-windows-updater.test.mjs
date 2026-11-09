import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Windows updater manifests work without macOS and retain verified merge boundaries", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-windows-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installerPath = path.join(directory, "Codex.Panel_0.5.1-fork_x86_64-setup.exe");
  const latestPath = path.join(directory, "latest.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const envelope = lines => Buffer.from(lines.join("\n")).toString("base64");
  const key = envelope([
    "untrusted comment: test public key",
    Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64"),
  ]);
  const bytes = Buffer.from("isolated Windows updater fixture");
  const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
  const comment = Buffer.from("test fixture");
  const signed = envelope([
    "untrusted comment: test signature",
    Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
    `trusted comment: ${comment}`,
    sign(null, Buffer.concat([signature, comment]), privateKey).toString("base64"),
  ]);
  await writeFile(installerPath, bytes);
  await writeFile(`${installerPath}.sig`, signed);
  const invoke = (manifest = latestPath) => spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/merge-windows-updater.mjs", import.meta.url)),
    manifest, installerPath, "v0.5.1-fork",
  ], { cwd: directory, env: { ...process.env, CODEX_PANEL_UPDATER_PUBLIC_KEY: key }, encoding: "utf8" });
  const windowsEntry = {
    signature: signed,
    url: "https://github.com/shay-wong/codex-panel/releases/download/v0.5.1-fork/Codex.Panel_0.5.1-fork_x86_64-setup.exe",
  };

  await t.test("creates a Windows-only manifest when macOS is unavailable", async () => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(latestPath, "utf8")), {
      version: "0.5.1-fork",
      platforms: { "windows-x86_64": windowsEntry, "windows-x86_64-nsis": windowsEntry },
    });
  });

  await t.test("retains existing macOS platforms and release fields", async () => {
    const existing = {
      version: "0.5.1-fork", notes: "Release notes", pub_date: "2026-11-09T00:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "mac-arm-fixture", url: "https://example.invalid/arm" },
        "darwin-x86_64": { signature: "mac-x64-fixture", url: "https://example.invalid/x64" },
      },
    };
    await writeFile(latestPath, JSON.stringify(existing));
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(latestPath, "utf8")), {
      ...existing,
      platforms: { ...existing.platforms, "windows-x86_64": windowsEntry, "windows-x86_64-nsis": windowsEntry },
    });
  });

  await t.test("rejects a mismatched version without replacing the manifest", async () => {
    const existing = JSON.stringify({ version: "0.5.0-fork", platforms: {} });
    await writeFile(latestPath, existing);
    const result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release tag must match/);
    assert.equal(await readFile(latestPath, "utf8"), existing);
  });

  await t.test("rejects tampering before replacing or creating a manifest", async () => {
    const existing = JSON.stringify({ version: "0.5.1-fork", platforms: {} });
    await writeFile(latestPath, existing);
    await writeFile(installerPath, "tampered");
    for (const manifest of [latestPath, path.join(directory, "new.json")]) {
      const result = invoke(manifest);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /signature verification failed/);
    }
    assert.equal(await readFile(latestPath, "utf8"), existing);
    await assert.rejects(readFile(path.join(directory, "new.json")), { code: "ENOENT" });
  });
});
