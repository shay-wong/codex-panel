import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveServerOptions } from "../server/app.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function missing(targetPath) {
  await assert.rejects(access(targetPath), { code: "ENOENT" });
}

test("Panel is the canonical Skill and CLI identity", async () => {
  const [skillSource, agentMetadata, packageSource, mainSource, storageMigrationSource] = await Promise.all([
    readFile(path.join(projectRoot, "skills", "manage-panel", "SKILL.md"), "utf8"),
    readFile(path.join(projectRoot, "skills", "manage-panel", "agents", "openai.yaml"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "web", "src", "main.tsx"), "utf8"),
    readFile(path.join(projectRoot, "web", "src", "storageMigration.ts"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(skillSource, /^name: manage-panel$/m);
  assert.match(skillSource, /^# Manage Panel$/m);
  assert.match(agentMetadata, /display_name: "Manage Panel"/);
  assert.match(agentMetadata, /\$manage-panel/);
  assert.equal(packageJson.bin.panelctl, "./cli/panelctl.mjs");
  assert.equal(packageJson.scripts.panelctl, "node cli/panelctl.mjs");
  assert.equal(packageJson.scripts["codex:install"], "node scripts/install-macos-launcher.mjs");
  assert.equal(Object.hasOwn(packageJson.scripts, "postinstall"), false);
  assert.match(mainSource, /migrateLegacyPanelStorage\(window\.localStorage\)/);
  assert.match(storageMigrationSource, /"taskboard\.theme", "panel\.theme"/);
  assert.match(storageMigrationSource, /"taskboard\.comment-draft\.", "panel\.comment-draft\."/);
  await access(path.join(projectRoot, "cli", "panelctl.mjs"));
  await missing(path.join(projectRoot, "skills", "manage-taskboard"));
  await missing(path.join(projectRoot, "cli", "taskctl.mjs"));
});

test("a configured data path uses panel.sqlite without migrating legacy files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-data-path-"));
  const legacyPath = path.join(directory, "taskboard.sqlite");
  try {
    await writeFile(legacyPath, "legacy database");

    const resolved = resolveServerOptions({ dataDirectory: directory });

    assert.equal(resolved.databasePath, path.join(directory, "panel.sqlite"));
    assert.equal(await readFile(legacyPath, "utf8"), "legacy database");
    await missing(resolved.databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
