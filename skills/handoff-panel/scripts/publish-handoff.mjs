#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const HANDOFF_COMMENT_MARKER = "<!-- codex-panel:ai-chat-handoff:v1 -->";

function usage(message) {
  const detail = message ? `${message}\n` : "";
  throw new Error(
    `${detail}Usage: publish-handoff.mjs --issue ISSUE-ID --handoff-file FILE`,
  );
}

function parseCommandArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        issue: { type: "string" },
        "handoff-file": { type: "string" },
      },
    });
  } catch (error) {
    usage(error.message);
  }

  for (const name of ["issue", "handoff-file"]) {
    if (parsed.tokens.filter((token) => token.kind === "option" && token.name === name).length > 1) {
      usage(`Duplicate option: --${name}`);
    }
  }
  if (!parsed.values.issue) usage("Missing required option: --issue");
  if (!parsed.values["handoff-file"]) usage("Missing required option: --handoff-file");
  return {
    issue: parsed.values.issue,
    handoffFile: parsed.values["handoff-file"],
  };
}

function runPanelctl(args) {
  const windowsBin = process.platform === "win32"
    ? (process.env.PATH ?? "")
      .split(path.delimiter)
      .find((entry) => existsSync(path.join(entry, "panelctl.cmd")))
    : null;
  if (process.platform === "win32" && !windowsBin) {
    throw new Error("Could not find the packaged panelctl command");
  }
  const windowsCli = windowsBin
    ? path.resolve(windowsBin, "..", "app", "cli", "panelctl.mjs")
    : null;
  const result = spawnSync(
    process.platform === "win32" ? process.execPath : "panelctl",
    process.platform === "win32" ? [windowsCli, ...args] : args,
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`Could not run panelctl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`panelctl ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function commentBody(handoff) {
  return [
    HANDOFF_COMMENT_MARKER,
    "### AI 对话交接",
    "",
    handoff,
    "",
    "> 来源：全局 Codex 对话（`$handoff-panel`）",
  ].join("\n");
}

let handoffFile = null;

async function main() {
  const options = parseCommandArgs(process.argv.slice(2));
  const issue = options.issue;
  handoffFile = options.handoffFile;
  const handoff = await readFile(handoffFile, "utf8");
  if (!handoff.trim()) throw new Error(`Handoff document is empty: ${handoffFile}`);

  const issueOutput = runPanelctl(["issue", "get", issue, "--json"]);
  let issueResponse;
  try {
    issueResponse = JSON.parse(issueOutput);
  } catch {
    throw new Error("panelctl issue get returned invalid JSON");
  }
  if (!issueResponse.task || issueResponse.task.archivedAt != null) {
    throw new Error(`Issue is missing or archived: ${issue}`);
  }
  const output = runPanelctl([
    "comment",
    "add",
    issue,
    "--body",
    commentBody(handoff),
    "--json",
  ]);
  if (output) process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  console.error(`Handoff Panel publication failed: ${error.message}`);
  if (handoffFile) console.error(`The handoff document remains at ${handoffFile}`);
  process.exitCode = 1;
});
