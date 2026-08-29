import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-panel/SKILL.md", import.meta.url),
  "utf8",
);
const cliReference = await readFile(
  new URL("../skills/manage-panel/references/cli.md", import.meta.url),
  "utf8",
);

test("the Panel skill selects the injected or packaged CLI without guessing", () => {
  assert.match(skillSource, /exact `panelctl` binary and Panel URL supplied/i);
  assert.match(skillSource, /On Linux[\s\S]*desktop app adds its packaged wrapper/i);
  assert.match(skillSource, /do not reconstruct its tokenized URL/i);
});

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

test("the Panel skill preserves complete task bindings", () => {
  assert.match(
    skillSource,
    /complete saved `threadBinding`:[\s\S]*`threadId`[\s\S]*`codexProjectId`[\s\S]*`codexProjectKind`[\s\S]*`codexHostId`[\s\S]*`workspacePath`/i,
  );
  assert.match(skillSource, /all five explicit `--binding-\*` options/i);
  assert.match(cliReference, /--binding-codex-project-kind local\|remote/i);
  assert.match(cliReference, /`--thread-id` records the conversation performing the mutation; it does not create a complete task binding/i);
  assert.match(skillSource, /explicitly asks to bind the current conversation[\s\S]*`conversation bind ISSUE_ID`/i);
  assert.match(cliReference, /panelctl conversation bind ISSUE_ID/);
  assert.match(cliReference, /refuses to replace another conversation's binding/i);
});

test("the Panel skill resolves an explicit Jira ID before workspace context", () => {
  assert.match(
    skillSource,
    /any user message supplies an exact Jira task ID[\s\S]*`jira planning get`[\s\S]*before `context current`/i,
  );
  assert.match(skillSource, /returned `context\.issues` as the Jira-linked Panel Issues/i);
  assert.match(
    skillSource,
    /read-only lookup does not turn the conversation into a Jira planning conversation/i,
  );
});

test("the Panel CLI reference covers help, project README, files, and incremental cursors", () => {
  assert.match(cliReference, /panelctl --help/);
  assert.match(cliReference, /panelctl project readme get/);
  assert.match(cliReference, /panelctl project readme set/);
  assert.match(cliReference, /panelctl comment list ISSUE_ID \[--after CURSOR\]/);
  assert.match(cliReference, /--body TEXT \| --body-file FILE/);
  assert.match(cliReference, /panelctl attachment list \(--task TASK_ID \| --comment COMMENT_ID\) \[--after CURSOR\]/);
  assert.match(cliReference, /separate cursors for each task or comment target/i);
});
