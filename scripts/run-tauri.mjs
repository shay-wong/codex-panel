import { spawnSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.CODEX_PANEL_BUILD_NUMBER;
const command = args.find(argument => !/^(?:-v+|--verbose)$/.test(argument));

if (command === "build" && env.GITHUB_ACTIONS !== "true") {
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  const directory = git.status === 0 ? git.stdout.trim() : process.cwd();
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
  if (process.platform === "darwin") {
    const separator = args.indexOf("--");
    args.splice(separator === -1 ? args.length : separator, 0,
      "--config", JSON.stringify({ bundle: { macOS: { bundleVersion: env.CODEX_PANEL_BUILD_NUMBER } } }));
  }
}

const cli = path.resolve("node_modules/@tauri-apps/cli/tauri.js");
const result = spawnSync(process.execPath, [cli, ...args], { env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
