import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
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
  launcherConfiguration,
  launcherInfoPlist,
  launcherVersionMetadata,
  panelctlLauncher,
  resolveLauncherIcons,
  resolveInstallLayout,
  selectLauncherSigningIdentity,
} from "../scripts/install-macos-launcher.mjs";
import { installManagedDirectory } from "../scripts/managed-install.mjs";
import { resolvePanelDataDirectory, resolvePanelSupportRoot } from "../shared/panel-paths.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const installerSource = await readFile(
  new URL("../scripts/install-macos-launcher.mjs", import.meta.url),
  "utf8",
);
const launcherAppSource = await readFile(
  new URL(
    "../macos/CodexPanelLauncher/Sources/CodexPanelLauncher/App/CodexPanelLauncherApp.swift",
    import.meta.url,
  ),
  "utf8",
);
const launcherConfigurationSource = await readFile(
  new URL(
    "../macos/CodexPanelLauncher/Sources/CodexPanelLauncher/Services/LauncherConfiguration.swift",
    import.meta.url,
  ),
  "utf8",
);
const panelManagerSource = await readFile(
  new URL(
    "../macos/CodexPanelLauncher/Sources/CodexPanelLauncher/Stores/PanelManager.swift",
    import.meta.url,
  ),
  "utf8",
);
const buildAndRunSource = await readFile(
  new URL("../script/build_and_run.sh", import.meta.url),
  "utf8",
);
const iconBuilderSource = await readFile(
  new URL(
    "../macos/CodexPanelLauncher/Sources/CodexPanelIconBuilder/main.swift",
    import.meta.url,
  ),
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
  "codex-cdp-pipe.mjs",
  "codex-injector-control.mjs",
  "codex-injector-runtime.mjs",
  "codex-injector.mjs",
  "codex-rate-limits.mjs",
  "panel-supervisor.mjs",
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

test("Fork prerelease versions use a numeric macOS version and preserve the full release", () => {
  assert.deepEqual(launcherVersionMetadata("0.2.0-fork.1"), {
    bundleShortVersion: "0.2.0",
    fullVersion: "0.2.0-fork.1",
  });
  const plist = launcherInfoPlist("0.2.0-fork.1");
  assert.match(
    plist,
    /<key>CFBundleShortVersionString<\/key>\s*<string>0\.2\.0<\/string>/,
  );
  assert.match(
    plist,
    /<key>CodexPanelVersion<\/key>\s*<string>0\.2\.0-fork\.1<\/string>/,
  );
  assert.throws(() => launcherVersionMetadata("0.2-fork.1"), /Invalid launcher version/);
});

test("runtime and native launcher configuration use installed files instead of repository paths", async () => {
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

    const appConfiguration = launcherConfiguration({
      dataDirectory: path.join(directory, "data"),
      logPath: path.join(directory, "panel.log"),
      nodeBinPath: "/node/bin",
      nodePath: "/node/bin/node",
      nodeSha256: "node-sha256",
      runtimeRelativePath: "runtime",
      codexAppDesignatedRequirement: "identifier test.codex",
      codexAppExecutablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      codexExecutablePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      codexExecutableDesignatedRequirement: "identifier test.codex-cli",
      userBinDirectory: path.join(directory, "bin"),
    });
    assert.equal(appConfiguration.version, 4);
    assert.equal(appConfiguration.runtimeRelativePath, "runtime");
    assert.equal(appConfiguration.dataDirectory, path.join(directory, "data"));
    assert.equal(appConfiguration.nodePath, "/node/bin/node");
    assert.equal(appConfiguration.nodeSha256, "node-sha256");
    assert.equal(
      appConfiguration.codexAppExecutablePath,
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    );
    assert.equal(
      appConfiguration.codexExecutablePath,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    );
    assert.equal(
      appConfiguration.codexExecutableDesignatedRequirement,
      "identifier test.codex-cli",
    );
    assert.equal(Object.hasOwn(appConfiguration, "codexAppExecutableSha256"), false);
    assert.equal(Object.hasOwn(appConfiguration, "codexExecutableSha256"), false);
    assert.match(appConfiguration.pathValue, new RegExp(path.join(directory, "bin")));
    assert.doesNotMatch(
      JSON.stringify(appConfiguration),
      new RegExp(projectRoot.replaceAll("/", "\\/")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the native launcher packages official light and dark Codex icons", () => {
  assert.match(installerSource, /icon-codex-light\.png/);
  assert.match(installerSource, /icon-codex-dark-color\.png/);
  assert.match(installerSource, /CodexBaseLight\.png/);
  assert.match(installerSource, /CodexBaseDark\.png/);
  assert.match(installerSource, /<string>CodexPanel<\/string>/);
});

test("launcher icon resolution fails when either official appearance resource is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-icons-"));
  const resourcesPath = path.join(directory, "ChatGPT.app", "Contents", "Resources");
  try {
    await mkdir(resourcesPath, { recursive: true });
    await writeFile(path.join(resourcesPath, "icon-codex-light.png"), "light");
    await assert.rejects(
      resolveLauncherIcons(path.join(directory, "ChatGPT.app")),
      /icon-codex-dark-color\.png/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the launcher accepts signed ChatGPT updates while pinning runtime and Node identity", () => {
  assert.match(installerSource, /runtimeRelativePath/);
  assert.match(installerSource, /nodeSha256/);
  assert.match(installerSource, /runtimeHash/);
  assert.match(installerSource, /codexAppDesignatedRequirement/);
  assert.match(installerSource, /codexExecutableDesignatedRequirement/);
  assert.doesNotMatch(installerSource, /codexAppExecutableSha256/);
  assert.doesNotMatch(installerSource, /codexExecutableSha256/);
  assert.match(installerSource, /Contents["']?,\s*["']Resources["']?,\s*["']runtime/);
  assert.match(launcherConfigurationSource, /validatedNodeURL/);
  assert.match(launcherConfigurationSource, /validatedCodexAppExecutableURL/);
  assert.match(launcherConfigurationSource, /validatedBundledExecutableURL/);
  assert.match(launcherConfigurationSource, /SecRequirementCreateWithString/);
  assert.match(launcherConfigurationSource, /kSecCSCheckNestedCode/);
  assert.match(launcherConfigurationSource, /SHA256/);
  assert.match(launcherConfigurationSource, /isSymbolicLink/);
  assert.match(panelManagerSource, /CODEX_EXECUTABLE/);
  assert.match(panelManagerSource, /--app-executable/);
});

test("the manager waits for renderer injection and never detaches ownership when opening Panel", () => {
  assert.match(panelManagerSource, /--control", "status/);
  assert.match(panelManagerSource, /--startup-token/);
  assert.match(panelManagerSource, /--control", "open/);
  assert.doesNotMatch(panelManagerSource, /--daemon/);
  assert.match(panelManagerSource, /--stop-residents", "--port"/);
  assert.match(launcherConfigurationSource, /launcher-runtime\.json/);
  assert.match(panelManagerSource, /CodexPanelVersion/);
});

test("cancelled recovery cannot launch managed processes after an async probe", () => {
  const panelStart = panelManagerSource.indexOf("private func startPanelService(");
  const integrationStart = panelManagerSource.indexOf("private func startIntegration(");
  const terminateStart = panelManagerSource.indexOf("private func terminateManagedProcesses(");
  assert.ok(panelStart >= 0 && integrationStart > panelStart && terminateStart > integrationStart);

  const panelFunction = panelManagerSource.slice(panelStart, integrationStart);
  const panelProbe = panelFunction.indexOf(
    "let panelIsReachable = await endpointIsReachable",
  );
  const panelRecheck = panelFunction.indexOf(
    "lifecycleGeneration: expectedLifecycleGeneration",
    panelProbe + 1,
  );
  const panelRun = panelFunction.indexOf("try process.run()");
  assert.ok(panelProbe >= 0 && panelRecheck > panelProbe && panelRun > panelRecheck);

  const integrationFunction = panelManagerSource.slice(integrationStart, terminateStart);
  const integrationProbe = integrationFunction.indexOf(
    "let cdpReachable = await endpointIsReachable",
  );
  const integrationRecheck = integrationFunction.indexOf(
    "lifecycleGeneration: expectedLifecycleGeneration",
    integrationProbe + 1,
  );
  const integrationRun = integrationFunction.indexOf("try process.run()");
  assert.ok(
    integrationProbe >= 0
      && integrationRecheck > integrationProbe
      && integrationRun > integrationRecheck,
  );

  assert.match(
    panelManagerSource,
    /let isReachable = await endpointIsReachable\(url\)\s+try assertStartTransaction\(\s+lifecycleGeneration: expectedLifecycleGeneration/,
  );
  assert.match(
    panelManagerSource,
    /try await assertIntegrationReady\(port: port\)\s+try assertStartTransaction\(\s+lifecycleGeneration: expectedLifecycleGeneration/,
  );
  assert.match(panelManagerSource, /private var lifecycleGeneration = 0/);
  assert.match(
    panelManagerSource,
    /private func cancelIntegrationRecovery\(\) \{\s+lifecycleGeneration \+= 1/,
  );
  const integrationWaitStart = panelManagerSource.indexOf(
    "private func waitUntilIntegrationReady(",
  );
  const endpointProbeStart = panelManagerSource.indexOf(
    "private func endpointIsReachable(",
    integrationWaitStart,
  );
  const reachableWaitStart = panelManagerSource.indexOf(
    "private func waitUntilReachable(",
    endpointProbeStart,
  );
  const processLookupStart = panelManagerSource.indexOf(
    "private func processIsRunning(",
    reachableWaitStart,
  );
  assert.ok(
    integrationWaitStart >= 0
      && endpointProbeStart > integrationWaitStart
      && reachableWaitStart > endpointProbeStart
      && processLookupStart > reachableWaitStart,
  );
  assert.doesNotMatch(
    panelManagerSource.slice(integrationWaitStart, endpointProbeStart),
    /try\? await Task\.sleep/,
  );
  assert.doesNotMatch(
    panelManagerSource.slice(reachableWaitStart, processLookupStart),
    /try\? await Task\.sleep/,
  );
});

test("launcher termination awaits only managed children, preserves ChatGPT, and development restarts request a normal quit", () => {
  assert.match(launcherAppSource, /applicationShouldTerminate/);
  assert.match(launcherAppSource, /terminateLater/);
  assert.match(launcherAppSource, /await shutdownHandler/);
  assert.match(panelManagerSource, /func shutdown\(\) async/);
  assert.match(panelManagerSource, /integration\?\.terminate\(\)/);
  assert.match(panelManagerSource, /panel\?\.terminate\(\)/);
  assert.doesNotMatch(panelManagerSource, /NSRunningApplication[\s\S]*terminate\(\)/);
  assert.doesNotMatch(panelManagerSource, /(?:killall|pkill)[\s\S]*(?:ChatGPT|Codex)/i);
  assert.match(panelManagerSource, /0\.\.<100/);
  assert.match(buildAndRunSource, /osascript/);
  assert.match(buildAndRunSource, /stop_app_with_wait_iterations 300/);
  assert.doesNotMatch(buildAndRunSource, /CODEX_PANEL_STOP_WAIT_ITERATIONS/);
  assert.match(buildAndRunSource, /pid_matches_app_binary "\$app_pid"/);
  assert.match(buildAndRunSource, /\/bin\/kill -KILL "\$app_pid"/);
  assert.doesNotMatch(buildAndRunSource, /(?:killall|pkill)[\s\S]*(?:ChatGPT|Codex)/i);
  assert.match(buildAndRunSource, /BASH_SOURCE\[0\].*==.*\$0/);
});

test("development restart keeps its 30-second production wait", () => {
  const scriptPath = fileURLToPath(new URL("../script/build_and_run.sh", import.meta.url));
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    stop_app_with_wait_iterations() { printf '%s' "$1"; }
    stop_app
  `, "test-stop-wait", scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_PANEL_STOP_WAIT_ITERATIONS: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "300");
});

test("development restart force-kills only the captured launcher binary", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-panel-stop-app-"));
  const launcherBinary = path.join(directory, "CodexPanelLauncher");
  const unrelatedBinary = path.join(directory, "ChatGPT");
  await copyFile(process.execPath, launcherBinary);
  await copyFile(process.execPath, unrelatedBinary);
  await chmod(launcherBinary, 0o755);
  await chmod(unrelatedBinary, 0o755);

  const keepAlive = "setInterval(() => {}, 1_000)";
  const launcher = spawn(launcherBinary, ["--eval", keepAlive], { stdio: "ignore" });
  const unrelated = spawn(unrelatedBinary, ["--eval", keepAlive], { stdio: "ignore" });
  t.after(async () => {
    for (const child of [launcher, unrelated]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  });

  const scriptPath = fileURLToPath(new URL("../script/build_and_run.sh", import.meta.url));
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    APP_BINARY="$2"
    request_app_quit() { :; }
    stop_app_with_wait_iterations 1
  `, "test-stop-app", scriptPath, launcherBinary], {
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await once(launcher, "exit");
  assert.equal(launcher.signalCode, "SIGKILL");
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("current-launcher detection binds the marker to the real designated requirement", () => {
  assert.match(installerSource, /designatedRequirement/);
  assert.match(installerSource, /codesign[\s\S]*-d[\s\S]*-r-/);
  assert.match(installerSource, /marker\?\.designatedRequirement/);
});

test("the Panel ribbon is symmetrically clipped at both corner edges", () => {
  assert.match(iconBuilderSource, /translateX\(by: 800, yBy: 800\)/);
  assert.match(iconBuilderSource, /rotate\(byDegrees: -45\)/);
  assert.match(
    iconBuilderSource,
    /NSRect\(x: -280, y: -50, width: 560, height: 100\)/,
  );
});

test("the generated launcher opts into the current macOS appearance", () => {
  assert.match(installerSource, /<key>NSRequiresAquaSystemAppearance<\/key>\s*<false\/>/);
});

test("the native launcher switches its Dock icon with the current macOS appearance", () => {
  assert.match(launcherAppSource, /observe\(\s*\\\.effectiveAppearance/);
  assert.match(launcherAppSource, /"CodexPanelDark"/);
  assert.match(launcherAppSource, /NSApp\.applicationIconImage = icon/);
});

test("the native launcher remains a foreground Dock application", () => {
  assert.match(installerSource, /plistValue\(launcherPath, "LSUIElement"\) === null/);
  assert.doesNotMatch(installerSource, /<key>LSUIElement<\/key>/);
});

test("reinstalling an unchanged launcher preserves its macOS permission identity", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const identities = spawnSync(
    "/usr/bin/security",
    ["find-identity", "-p", "codesigning", "-v"],
    { encoding: "utf8" },
  );
  const signingIdentity = identities.stdout.match(
    /^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development:/m,
  )?.[1];
  if (!signingIdentity) {
    t.skip("a stable Apple Development signing identity is not installed");
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-launcher-identity-"));
  const applicationsDirectory = path.join(directory, "Applications");
  const launcherPath = path.join(applicationsDirectory, "Codex Panel.app");
  const resourcesPath = path.join(launcherPath, "Contents", "Resources");
  const lightIconPath = path.join(projectRoot, "web", "public", "codex-app-icon.png");
  const darkIconPath = lightIconPath;
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
    await createRuntimeFixture(layout.runtimeDirectory, "runtime");
    await writeFile(path.join(layout.runtimeDirectory, "server", "index.mjs"), "// fixture\n");

    const installOptions = {
      codexAppDesignatedRequirement: "identifier test.codex-panel.fake-app",
      codexAppExecutablePath: process.execPath,
      codexExecutablePath: process.execPath,
      iconSourcePaths: {
        lightSourcePath: lightIconPath,
        darkSourcePath: darkIconPath,
      },
      signingIdentity,
    };
    await installLauncher(layout, installOptions);
    const firstRequirement = designatedRequirement();
    const firstMarker = JSON.parse(
      await readFile(path.join(resourcesPath, "codex-panel-launcher.json"), "utf8"),
    );
    const firstExecutable = await lstat(path.join(
      launcherPath,
      "Contents",
      "MacOS",
      "CodexPanelLauncher",
    ));
    assert.equal(
      firstMarker.designatedRequirement,
      firstRequirement,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await installLauncher(layout, installOptions);

    assert.equal(designatedRequirement(), firstRequirement);
    assert.equal(
      (await lstat(path.join(
        launcherPath,
        "Contents",
        "MacOS",
        "CodexPanelLauncher",
      ))).ino,
      firstExecutable.ino,
    );

    await writeFile(
      path.join(layout.runtimeDirectory, "scripts", "codex-injector.mjs"),
      "runtime changed\n",
    );
    await installLauncher(layout, installOptions);
    const updatedMarker = JSON.parse(
      await readFile(path.join(resourcesPath, "codex-panel-launcher.json"), "utf8"),
    );
    assert.notEqual(updatedMarker.runtimeHash, firstMarker.runtimeHash);
    assert.equal(
      await readFile(
        path.join(resourcesPath, "runtime", "scripts", "codex-injector.mjs"),
        "utf8",
      ),
      "runtime changed\n",
    );
    assert.equal(designatedRequirement(), firstRequirement);
  } finally {
    spawnSync(launchServicesRegister, ["-u", launcherPath]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher signing prefers an explicit or matching stable development identity", () => {
  const personalIdentity = {
    hash: "1111111111111111111111111111111111111111",
    name: "Apple Development: Shay (TEAMID1234)",
  };
  const otherIdentity = {
    hash: "2222222222222222222222222222222222222222",
    name: "Apple Development: Other (TEAMID5678)",
  };
  const identities = [personalIdentity, otherIdentity];

  assert.equal(selectLauncherSigningIdentity({
    environment: { CODEX_PANEL_CODESIGN_IDENTITY: "Configured Identity" },
    gitEmail: "shay@example.com",
    identities,
  }), "Configured Identity");
  assert.equal(selectLauncherSigningIdentity({
    existingIdentity: otherIdentity.hash,
    gitEmail: "shay@example.com",
    identities,
  }), otherIdentity.hash);
  assert.equal(selectLauncherSigningIdentity({
    gitEmail: "shay@example.com",
    identities: [
      { ...personalIdentity, name: "Apple Development: shay@example.com (TEAMID1234)" },
      otherIdentity,
    ],
  }), personalIdentity.hash);
  assert.equal(selectLauncherSigningIdentity({
    gitEmail: "missing@example.com",
    identities,
  }), "-");
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

test("managed installation leaves an unchanged Skill directory in place", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-managed-install-"));
  const sourceDirectory = path.join(directory, "source");
  const targetDirectory = path.join(directory, "target");
  try {
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, "SKILL.md"), "managed\n");

    assert.equal(await installManagedDirectory(
      sourceDirectory,
      targetDirectory,
      "test Skill",
      { artifact: "test-skill" },
    ), true);
    const before = await lstat(targetDirectory);

    assert.equal(await installManagedDirectory(
      sourceDirectory,
      targetDirectory,
      "test Skill",
      { artifact: "test-skill" },
    ), false);
    const after = await lstat(targetDirectory);
    assert.equal(after.ino, before.ino);
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

    const installedSkillInodes = new Map();
    for (const skillName of ["manage-panel", "handoff-panel"]) {
      const installedSkill = path.join(layout.skillsDirectory, skillName);
      const installedSkillStats = await lstat(installedSkill);
      assert.equal(installedSkillStats.isSymbolicLink(), false);
      installedSkillInodes.set(skillName, installedSkillStats.ino);
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
    for (const [skillName, inode] of installedSkillInodes) {
      assert.equal(
        (await lstat(path.join(layout.skillsDirectory, skillName))).ino,
        inode,
      );
    }
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
