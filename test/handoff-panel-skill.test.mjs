import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const skillDirectory = fileURLToPath(new URL("../skills/handoff-panel/", import.meta.url));
const publisherPath = path.join(skillDirectory, "scripts", "publish-handoff.mjs");
const [skillSource, agentMetadata, installerSource] = await Promise.all([
  readFile(path.join(skillDirectory, "SKILL.md"), "utf8"),
  readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8"),
  readFile(new URL("../scripts/install-macos-launcher.mjs", import.meta.url), "utf8"),
]);

async function createPublisherFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "handoff-panel-test-"));
  const binDirectory = path.join(directory, "bin");
  const capturePath = path.join(directory, "panelctl.jsonl");
  const handoffPath = path.join(directory, "handoff.md");
  const handoff = "\n# Session handoff\n\nKeep the exact acceptance decision.\n\n";
  const panelctlPath = path.join(binDirectory, "panelctl");
  await mkdir(binDirectory);
  await writeFile(handoffPath, handoff);
  await writeFile(panelctlPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PANELCTL_CAPTURE, JSON.stringify({
  args,
  threadId: process.env.CODEX_THREAD_ID,
}) + "\\n");
if (args[0] === "issue" && args[1] === "get") {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    task: { identifier: args[2], archivedAt: null },
  }) + "\\n");
  process.exit(0);
}
if (process.env.FAKE_PANELCTL_FAIL_COMMENT === "1") {
  process.stderr.write('{"error":{"message":"comment rejected"}}\\n');
  process.exit(4);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 2,
  comment: { id: "comment-1", threadId: process.env.CODEX_THREAD_ID },
}) + "\\n");
`);
  await chmod(panelctlPath, 0o755);
  return {
    capturePath,
    directory,
    handoff,
    handoffPath,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "thread-123",
      FAKE_PANELCTL_CAPTURE: capturePath,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

test("handoff-panel remains an explicit wrapper around the installed handoff Skill", () => {
  assert.match(skillSource, /\$handoff-panel --issue ISSUE-ID/);
  assert.match(skillSource, /~\/\.agents\/skills\/handoff\/SKILL\.md/);
  assert.match(skillSource, /Follow all of its instructions exactly/);
  assert.match(skillSource, /publisher validates that the target is an existing, non-archived Issue/);
  assert.match(skillSource, /Reuse the base handoff document verbatim/);
  assert.match(skillSource, /Never change the behavior or files of the original `\$handoff` Skill/);
  const baseHandoffIndex = skillSource.indexOf("Read the installed base Skill");
  const publishIndex = skillSource.indexOf("publish the document");
  assert.ok(baseHandoffIndex >= 0);
  assert.ok(publishIndex > baseHandoffIndex, "Panel publication must follow the base handoff");
  assert.doesNotMatch(skillSource, /Before creating the handoff, run `panelctl issue get/);
  assert.match(agentMetadata, /allow_implicit_invocation: false/);
  assert.match(installerSource, /handoff-panel/);
});

test("the publisher validates the issue and adds the handoff as an attributed Panel comment", async () => {
  const fixture = await createPublisherFixture();
  try {
    const result = spawnSync(process.execPath, [
      publisherPath,
      "--issue",
      "PROJECT-123",
      "--handoff-file",
      fixture.handoffPath,
    ], { encoding: "utf8", env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    const captures = (await readFile(fixture.capturePath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(captures[0], {
      args: ["issue", "get", "PROJECT-123", "--json"],
      threadId: "thread-123",
    });
    assert.equal(captures[1].args.slice(0, 3).join(" "), "comment add PROJECT-123");
    assert.equal(captures[1].threadId, "thread-123");
    const body = captures[1].args[captures[1].args.indexOf("--body") + 1];
    assert.equal(body, [
      "<!-- codex-panel:ai-chat-handoff:v1 -->",
      "### AI 对话交接",
      "",
      fixture.handoff,
      "",
      "> 来源：全局 Codex 对话（`$handoff-panel`）",
    ].join("\n"));
    assert.match(result.stdout, /"comment"/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a publication failure preserves and reports the temporary handoff document", async () => {
  const fixture = await createPublisherFixture();
  try {
    const result = spawnSync(process.execPath, [
      publisherPath,
      "--issue=PROJECT-123",
      `--handoff-file=${fixture.handoffPath}`,
    ], {
      encoding: "utf8",
      env: { ...fixture.env, FAKE_PANELCTL_FAIL_COMMENT: "1" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /comment rejected/);
    assert.match(result.stderr, /The handoff document remains at/);
    assert.equal(await readFile(fixture.handoffPath, "utf8"), fixture.handoff);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
