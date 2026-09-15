import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseMetadata } from "../scripts/release-metadata.mjs";

test("fork updater metadata stays on the fork and advertises only bundled architectures", () => {
  const metadata = releaseMetadata("0.0.1-fork", "v0.0.1-fork", ["arm64"]);
  assert.match(metadata.url, /^https:\/\/github.com\/shay-wong\/codex-panel\/releases\/download\//);
  assert.deepEqual(metadata.platforms, ["darwin-aarch64", "darwin-aarch64-app"]);
  assert.ok(metadata.assetNames.includes("Codex.Panel_0.0.1-fork_aarch64.dmg"));
  assert.equal(releaseMetadata("0.0.1-fork", "v0.0.1-fork", ["arm64", "x86_64"]).platforms.length, 4);
  assert.throws(() => releaseMetadata("0.0.1", "v0.0.1", ["arm64"]));
  assert.throws(() => releaseMetadata("0.0.1-fork.1", "v0.0.1-fork.1", ["arm64"]));
  assert.throws(() => releaseMetadata("0.0.1-fork", "v0.0.2-fork", ["arm64"]));
});
