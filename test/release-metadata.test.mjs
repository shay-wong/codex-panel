import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseMetadata } from "../scripts/release-metadata.mjs";

test("fork updater metadata stays on the fork and advertises only bundled architectures", () => {
  const metadata = releaseMetadata("1.1.23-fork.1", "v1.1.23-fork.1", ["arm64"]);
  assert.match(metadata.url, /^https:\/\/github.com\/shay-wong\/codex-panel\/releases\/download\//);
  assert.deepEqual(metadata.platforms, ["darwin-aarch64", "darwin-aarch64-app"]);
  assert.ok(metadata.assetNames[0].endsWith(".dmg"));
  assert.equal(releaseMetadata("1.1.23-fork.1", "v1.1.23-fork.1", ["arm64", "x86_64"]).platforms.length, 4);
  assert.throws(() => releaseMetadata("0.1.0", "v0.1.0", ["arm64"]));
  assert.throws(() => releaseMetadata("1.1.23-fork.1", "v1.1.23-fork.2", ["arm64"]));
});
