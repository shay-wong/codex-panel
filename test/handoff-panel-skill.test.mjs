import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [skillSource, agentMetadata, installerSource, contractSource] = await Promise.all([
  readFile(new URL("../skills/handoff-panel/SKILL.md", import.meta.url), "utf8"),
  readFile(new URL("../skills/handoff-panel/agents/openai.yaml", import.meta.url), "utf8"),
  readFile(new URL("../scripts/install-macos-launcher.mjs", import.meta.url), "utf8"),
  readFile(new URL("../runtime/assets/cli-contract.json", import.meta.url), "utf8"),
]);

test("handoff-panel uses the native publisher after resolving the configured workflow", () => {
  assert.match(skillSource, /\$handoff-panel --issue ISSUE-ID/);
  assert.match(skillSource, /panelctl workflow get handoff --project PROJECT_ID --json/);
  assert.match(skillSource, /Never assume a personal `handoff` Skill is installed/);
  assert.match(skillSource, /the built-in handoff will be used/);
  assert.match(skillSource, /publisher validates that the target is an existing, non-archived Issue/);
  assert.match(skillSource, /Reuse the temporary handoff document verbatim/);
  assert.match(skillSource, /panelctl handoff publish/);
  assert.doesNotMatch(skillSource, /node |\.mjs/);
  assert.ok(skillSource.indexOf("panelctl handoff publish") > skillSource.indexOf("panelctl workflow get handoff"));
  assert.match(agentMetadata, /allow_implicit_invocation: false/);
  assert.match(installerSource, /handoff-panel/);
  assert.deepEqual(JSON.parse(contractSource).options["handoff publish"], ["issue", "handoff-file", "json"]);
});
