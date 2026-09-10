import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyUpdaterSignature } from "../scripts/verify-updater-signature.mjs";

test("updater verification accepts signed bytes and rejects tampering or another key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-updater-signature-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = randomBytes(8);
    const keyBytes = Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]);
    const envelope = (lines) => Buffer.from(lines.join("\n")).toString("base64");
    const key = envelope(["untrusted comment: test public key", keyBytes.toString("base64")]);
    const bytes = Buffer.from("disposable signed updater fixture");
    const digest = createHash("blake2b512").update(bytes).digest();
    const signature = sign(null, digest, privateKey);
    const comment = Buffer.from("test fixture");
    const signed = envelope([
      "untrusted comment: test signature",
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${comment}`,
      sign(null, Buffer.concat([signature, comment]), privateKey).toString("base64"),
    ]);
    const artifactPath = path.join(directory, "fixture.tar.gz");
    await writeFile(artifactPath, bytes);
    await verifyUpdaterSignature({ publicKey: key, artifactPath, signature: signed });
    await writeFile(artifactPath, "tampered");
    await assert.rejects(verifyUpdaterSignature({ publicKey: key, artifactPath, signature: signed }), /verification failed/);
    keyBytes[2] ^= 1;
    await assert.rejects(verifyUpdaterSignature({
      publicKey: envelope(["untrusted comment: other key", keyBytes.toString("base64")]), artifactPath, signature: signed,
    }), /different key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
