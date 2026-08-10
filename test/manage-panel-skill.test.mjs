import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-panel/SKILL.md", import.meta.url),
  "utf8",
);

test("the panel skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /read the latest issue content and all comments/i);
  assert.match(skillSource, /completed work has been returned for changes/i);
  assert.match(skillSource, /claim a `todo` issue, move it to `in_progress` with `--if-version`/i);
  assert.match(skillSource, /version conflict[\s\S]*skip the issue and do not implement/i);

  assert.match(
    skillSource,
    /verify the requested work and acceptance criteria[\s\S]*add a comment summarizing the key changes, verification, result, and remaining risks[\s\S]*move the issue to `in_review`/i,
  );
});
