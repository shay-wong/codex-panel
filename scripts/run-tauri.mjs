import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function createLocalBuildEnvironment(isBuild, cwd = process.cwd()) {
  const env = { ...process.env };
  delete env.CODEX_PANEL_BUILD_NUMBER;
  if (!isBuild || env.GITHUB_ACTIONS === "true") return env;

  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  const directory = git.status === 0 ? git.stdout.trim() : cwd;
  const { DatabaseSync } = await import("node:sqlite");
  const counter = new DatabaseSync(path.join(directory, ".codex-panel-build.sqlite"));
  try {
    counter.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS builds (id INTEGER PRIMARY KEY, number INTEGER NOT NULL)");
    const { number } = counter.prepare(
      "INSERT INTO builds VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET number = number + 1 RETURNING number",
    ).get();
    env.CODEX_PANEL_BUILD_NUMBER = String(number);
  } finally {
    counter.close();
  }
  console.log(`Codex Panel local Build ${env.CODEX_PANEL_BUILD_NUMBER}`);
  return env;
}

export function runTauri(args, env, cwd = process.cwd()) {
  if (env.CODEX_PANEL_BUILD_NUMBER && process.platform === "darwin") {
    const separator = args.indexOf("--");
    args.splice(separator === -1 ? args.length : separator, 0,
      "--config", JSON.stringify({ bundle: { macOS: { bundleVersion: env.CODEX_PANEL_BUILD_NUMBER } } }));
  }
  const cli = path.join(cwd, "node_modules/@tauri-apps/cli/tauri.js");
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.find(argument => !/^(?:-v+|--verbose)$/.test(argument));
  process.exitCode = runTauri(args, await createLocalBuildEnvironment(command === "build"));
}
