import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveServerOptions } from "../server/app.mjs";
import { resolveInstallLayout } from "../scripts/install-macos-launcher.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function missing(targetPath) {
  await assert.rejects(access(targetPath), { code: "ENOENT" });
}

test("Panel is the canonical Skill, CLI, runtime, and integration identity", async () => {
  const [
    skillSource,
    agentMetadata,
    packageSource,
    mainSource,
    storageMigrationSource,
    injectorSource,
    embeddedHostSource,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "skills", "manage-panel", "SKILL.md"), "utf8"),
    readFile(path.join(projectRoot, "skills", "manage-panel", "agents", "openai.yaml"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "web", "src", "main.tsx"), "utf8"),
    readFile(path.join(projectRoot, "web", "src", "storageMigration.ts"), "utf8"),
    readFile(path.join(projectRoot, "scripts", "codex-injector.mjs"), "utf8"),
    readFile(path.join(projectRoot, "web", "src", "embeddedHost.mjs"), "utf8"),
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
  assert.match(injectorSource, /createPanelSupervisor/);
  assert.match(injectorSource, /__CODEX_PANEL_FRAME_CAPABILITY__/);
  assert.match(embeddedHostSource, /type: "panel:open-external"/);
  assert.doesNotMatch(injectorSource, /createTaskboardSupervisor/);
  await access(path.join(projectRoot, "cli", "panelctl.mjs"));
  await access(path.join(projectRoot, "scripts", "panel-supervisor.mjs"));
  await access(path.join(projectRoot, "inject", "workbuddy-panel.user.js"));
  await missing(path.join(projectRoot, "skills", "manage-taskboard"));
  await missing(path.join(projectRoot, "cli", "taskctl.mjs"));
  await missing(path.join(projectRoot, "scripts", "taskboard-supervisor.mjs"));
  await missing(path.join(projectRoot, "inject", "workbuddy-taskboard.user.js"));
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

test("the macOS product installer always uses the fixed Panel data directory", () => {
  const layout = resolveInstallLayout({
    environment: {
      CODEX_PANEL_HOME: "/tmp/other-panel-home",
      CODEX_PANEL_DATA_DIR: "/tmp/other-panel-data",
    },
    homeDirectory: "/Users/panel-test",
    platform: "darwin",
  });

  const productRoot = path.join(
    "/Users/panel-test",
    "Library",
    "Application Support",
    "Codex Panel",
  );
  assert.equal(layout.installRoot, productRoot);
  assert.equal(layout.dataDirectory, path.join(productRoot, "data"));
});

test("the Windows release preserves the hashed Node sidecar", async () => {
  const source = await readFile(
    path.join(projectRoot, "scripts", "build-windows-app.mjs"),
    "utf8",
  );
  assert.match(source, /certificateThumbprint: thumbprint/);
  assert.match(source, /tsp: true/);
  assert.match(source, /TAURI_SKIP_SIDECAR_SIGNATURE_CHECK: "true"/);
});
