import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeDataDirectory,
  installLauncher,
  installPanelTools,
  installRuntime,
  launcherSource,
  panelctlLauncher,
  resolveInstallLayout,
} from "../scripts/install-macos-launcher.mjs";
import { installManagedDirectory } from "../scripts/managed-install.mjs";
import { resolvePanelDataDirectory, resolvePanelSupportRoot } from "../shared/panel-paths.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const installerSource = await readFile(
  new URL("../scripts/install-macos-launcher.mjs", import.meta.url),
  "utf8",
);
const runtimeDirectories = [
  "cli",
  "inject",
  "server",
  "shared",
  path.join("dist", "web"),
  path.join("skills", "manage-panel"),
  path.join("skills", "handoff-panel"),
];
const runtimeScripts = [
  "codex-injector-runtime.mjs",
  "codex-injector.mjs",
  "codex-rate-limits.mjs",
];
const launchServicesRegister = [
  "/System/Library/Frameworks/CoreServices.framework",
  "Frameworks/LaunchServices.framework/Support/lsregister",
].join("/");

async function missing(targetPath) {
  await assert.rejects(access(targetPath), { code: "ENOENT" });
}

async function createRuntimeFixture(root, content) {
  for (const relativePath of runtimeDirectories) {
    const directory = path.join(root, relativePath);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "fixture.txt"), content);
  }
  await mkdir(path.join(root, "scripts"), { recursive: true });
  for (const filename of runtimeScripts) {
    await writeFile(path.join(root, "scripts", filename), content);
  }
}

test("Panel uses the standard user Skill directory and a stable support root", () => {
  const homeDirectory = "/Users/example";
  const environment = {};
  assert.equal(
    resolvePanelSupportRoot({ environment, homeDirectory, platform: "darwin" }),
    "/Users/example/Library/Application Support/Codex Panel",
  );
  assert.equal(
    resolvePanelDataDirectory({ environment, homeDirectory, platform: "darwin" }),
    "/Users/example/Library/Application Support/Codex Panel/data",
  );

  const layout = resolveInstallLayout({
    environment,
    homeDirectory,
    nodeBinDirectory: "/node/bin",
    platform: "darwin",
  });
  assert.equal(layout.skillsDirectory, "/Users/example/.agents/skills");
  assert.equal(layout.userBinDirectory, "/Users/example/.local/bin");
  assert.equal(layout.runtimeDirectory, "/Users/example/Library/Application Support/Codex Panel/runtime");
});

test("runtime and launchers use installed files instead of repository paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-runtime-install-"));
  const firstSource = path.join(directory, "source-a");
  const secondSource = path.join(directory, "source-b");
  const runtimeDirectory = path.join(directory, "installed", "runtime");
  try {
    await createRuntimeFixture(firstSource, "first");
    await installRuntime(runtimeDirectory, { skipBuild: true, sourceRoot: firstSource });
    assert.equal((await lstat(runtimeDirectory)).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(runtimeDirectory, "server", "fixture.txt"), "utf8"), "first");

    await createRuntimeFixture(secondSource, "second");
    await installRuntime(runtimeDirectory, { skipBuild: true, sourceRoot: secondSource });
    assert.equal(await readFile(path.join(runtimeDirectory, "server", "fixture.txt"), "utf8"), "second");

    const cliLauncher = panelctlLauncher(runtimeDirectory);
    assert.match(cliLauncher, /codex-panel-managed:panelctl:1/);
    assert.match(cliLauncher, new RegExp(runtimeDirectory.replaceAll("/", "\\/")));
    assert.doesNotMatch(cliLauncher, new RegExp(projectRoot.replaceAll("/", "\\/")));

    const appSource = launcherSource({
      dataDirectory: path.join(directory, "data"),
      logPath: path.join(directory, "panel.log"),
      nodeBinPath: "/node/bin",
      nodePath: "/node/bin/node",
      runtimeDirectory,
      userBinDirectory: path.join(directory, "bin"),
    });
    assert.match(appSource, /--launch --watch --open/);
    assert.match(appSource, /CODEX_PANEL_DATA_DIR/);
    assert.doesNotMatch(appSource, /npmPath|projectPath|npm run/);
    assert.doesNotMatch(appSource, new RegExp(projectRoot.replaceAll("/", "\\/")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the generated launcher gives the Codex icon file precedence", () => {
  assert.match(
    installerSource,
    /setPlistValue\(plistPath, "CFBundleIconFile", "Codex"\)/,
  );
  assert.match(
    installerSource,
    /deletePlistValue\(plistPath, "CFBundleIconName"\)/,
  );
});

test("the generated launcher opts into the current macOS appearance", () => {
  assert.match(
    installerSource,
    /setPlistBoolean\(plistPath, "NSRequiresAquaSystemAppearance", false\)/,
  );
});

test("the generated launcher does not leave a temporary Dock application", () => {
  assert.match(
    installerSource,
    /setPlistBoolean\(plistPath, "LSUIElement", true\)/,
  );
});

test("reinstalling an unchanged launcher preserves its macOS permission identity", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-launcher-identity-"));
  const applicationsDirectory = path.join(directory, "Applications");
  const launcherPath = path.join(applicationsDirectory, "Codex.app");
  const resourcesPath = path.join(launcherPath, "Contents", "Resources");
  const layout = {
    applicationsDirectory,
    dataDirectory: path.join(directory, "data"),
    logPath: path.join(directory, "panel.log"),
    runtimeDirectory: path.join(directory, "runtime"),
    userBinDirectory: path.join(directory, "bin"),
  };

  const designatedRequirement = () => {
    const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", launcherPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const requirement = `${result.stdout}${result.stderr}`.match(/designated => (.+)/)?.[1];
    assert.ok(requirement, "generated launcher must have a designated requirement");
    return requirement;
  };

  try {
    await mkdir(resourcesPath, { recursive: true });
    await writeFile(path.join(resourcesPath, "Codex.icns"), "fixture icon");
    await writeFile(
      path.join(resourcesPath, "codex-panel-launcher.json"),
      `${JSON.stringify({ generator: "codex-panel" })}\n`,
    );

    await installLauncher(layout);
    const firstRequirement = designatedRequirement();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await installLauncher(layout);

    assert.equal(designatedRequirement(), firstRequirement);

    const markerPath = path.join(resourcesPath, "codex-panel-launcher.json");
    const legacyMarker = JSON.parse(await readFile(markerPath, "utf8"));
    delete legacyMarker.definitionVersion;
    delete legacyMarker.sourceHash;
    legacyMarker.generatedAt = "2026-08-06T00:00:00.000Z";
    await writeFile(markerPath, `${JSON.stringify(legacyMarker, null, 2)}\n`);
    const resign = spawnSync(
      "/usr/bin/codesign",
      ["--force", "--deep", "--sign", "-", launcherPath],
      { encoding: "utf8" },
    );
    assert.equal(resign.status, 0, resign.stderr || resign.stdout);
    const legacyRequirement = designatedRequirement();

    await installLauncher(layout);

    assert.equal(designatedRequirement(), legacyRequirement);
  } finally {
    spawnSync(launchServicesRegister, ["-u", launcherPath]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed installation refuses to overwrite a user-owned directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-managed-install-"));
  const sourceDirectory = path.join(directory, "source");
  const targetDirectory = path.join(directory, "target");
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    await writeFile(path.join(sourceDirectory, "SKILL.md"), "managed\n");
    await writeFile(path.join(targetDirectory, "SKILL.md"), "user-owned\n");

    await assert.rejects(
      installManagedDirectory(sourceDirectory, targetDirectory, "test Skill", {
        artifact: "test-skill",
      }),
      /is not managed by Codex Panel/,
    );
    assert.equal(await readFile(path.join(targetDirectory, "SKILL.md"), "utf8"), "user-owned\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill and CLI installation creates managed copies and removes owned legacy links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-tools-install-"));
  const homeDirectory = path.join(directory, "home");
  const runtimeDirectory = path.join(directory, "runtime");
  const layout = resolveInstallLayout({
    environment: {},
    homeDirectory,
    installRoot: directory,
    nodeBinDirectory: path.join(directory, "node-bin"),
    platform: "darwin",
  });
  layout.runtimeDirectory = runtimeDirectory;
  try {
    await mkdir(path.join(runtimeDirectory, "skills"), { recursive: true });
    await cp(
      path.join(projectRoot, "skills", "manage-panel"),
      path.join(runtimeDirectory, "skills", "manage-panel"),
      { recursive: true },
    );
    await cp(
      path.join(projectRoot, "skills", "handoff-panel"),
      path.join(runtimeDirectory, "skills", "handoff-panel"),
      { recursive: true },
    );
    await mkdir(path.join(runtimeDirectory, "cli"), { recursive: true });
    await copyFile(
      path.join(projectRoot, "cli", "panelctl.mjs"),
      path.join(runtimeDirectory, "cli", "panelctl.mjs"),
    );

    await mkdir(layout.legacyCodexSkillsDirectory, { recursive: true });
    await mkdir(layout.legacyNodeBinDirectory, { recursive: true });
    await symlink(
      path.join(projectRoot, "skills", "manage-panel"),
      path.join(layout.legacyCodexSkillsDirectory, "manage-panel"),
      "dir",
    );
    await symlink(
      path.join(projectRoot, "skills", "handoff-panel"),
      path.join(layout.legacyCodexSkillsDirectory, "handoff-panel"),
      "dir",
    );
    await symlink(
      path.join(projectRoot, "cli", "panelctl.mjs"),
      path.join(layout.legacyNodeBinDirectory, "panelctl"),
      "file",
    );

    await installPanelTools(layout);

    for (const skillName of ["manage-panel", "handoff-panel"]) {
      const installedSkill = path.join(layout.skillsDirectory, skillName);
      assert.equal((await lstat(installedSkill)).isSymbolicLink(), false);
      assert.match(
        await readFile(path.join(installedSkill, ".codex-panel-managed.json"), "utf8"),
        new RegExp(`"artifact": "${skillName}"`),
      );
    }
    const panelctlPath = path.join(layout.userBinDirectory, "panelctl");
    assert.equal((await lstat(panelctlPath)).isSymbolicLink(), false);
    assert.match(await readFile(panelctlPath, "utf8"), new RegExp(runtimeDirectory));
    await missing(path.join(layout.legacyCodexSkillsDirectory, "manage-panel"));
    await missing(path.join(layout.legacyCodexSkillsDirectory, "handoff-panel"));
    await missing(path.join(layout.legacyNodeBinDirectory, "panelctl"));

    await installPanelTools(layout);
    assert.equal((await lstat(panelctlPath)).isSymbolicLink(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial installation snapshots live SQLite data without overwriting installed data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-data-install-"));
  const sourceDirectory = path.join(directory, "source-data");
  const targetDirectory = path.join(directory, "installed-data");
  await mkdir(path.join(sourceDirectory, "attachments"), { recursive: true });
  await writeFile(path.join(sourceDirectory, "attachments", "asset"), "attachment");
  await writeFile(path.join(sourceDirectory, "codex-automation-policies.json"), "{}\n");

  const sourceDatabase = new DatabaseSync(path.join(sourceDirectory, "panel.sqlite"));
  try {
    sourceDatabase.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT)");
    sourceDatabase.prepare("INSERT INTO records VALUES (?)").run("first");

    assert.equal(await initializeDataDirectory(sourceDirectory, targetDirectory), true);
    const installedDatabase = new DatabaseSync(path.join(targetDirectory, "panel.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        installedDatabase.prepare("SELECT value FROM records").all().map((row) => row.value),
        ["first"],
      );
    } finally {
      installedDatabase.close();
    }
    assert.equal(
      await readFile(path.join(targetDirectory, "attachments", "asset"), "utf8"),
      "attachment",
    );

    sourceDatabase.prepare("INSERT INTO records VALUES (?)").run("second");
    assert.equal(await initializeDataDirectory(sourceDirectory, targetDirectory), false);
    const preservedDatabase = new DatabaseSync(path.join(targetDirectory, "panel.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(preservedDatabase.prepare("SELECT COUNT(*) AS count FROM records").get().count, 1);
    } finally {
      preservedDatabase.close();
    }
  } finally {
    sourceDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }
});
