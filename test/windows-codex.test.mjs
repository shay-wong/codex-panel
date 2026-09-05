import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activateWindowsCodex,
  windowsCodexProcesses,
  windowsCodexProfileArgument,
} from "../scripts/windows-codex.mjs";

const appPath = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__example\app\ChatGPT.exe`;
const profilePath = String.raw`C:\Users\alice\AppData\Local\Codex Panel\codex-profile`;

test("Windows Codex process inspection uses the protected executable path", () => {
  const calls = [];
  const processes = windowsCodexProcesses(appPath, { SAFE: "1" }, (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: JSON.stringify({
        ProcessId: 123,
        ParentProcessId: 1,
        ExecutablePath: appPath,
        CommandLine: `"${appPath}" "--user-data-dir=${profilePath}" --remote-debugging-port=9229`,
      }),
      stderr: "",
    };
  });

  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.env.CODEX_PANEL_CODEX_APP_PATH, appPath);
  assert.deepEqual(processes, [{
    pid: 123,
    parentPid: 1,
    executable: appPath,
    command: `"${appPath}" "--user-data-dir=${profilePath}" --remote-debugging-port=9229`,
  }]);
  assert.equal(windowsCodexProfileArgument(processes[0].command, profilePath), true);
  assert.equal(processes[0].parentPid, 1);
});

test("Windows Store activation passes the app, isolated profile, and CDP port through environment", () => {
  const calls = [];
  const pid = activateWindowsCodex(
    appPath,
    profilePath,
    43123,
    { SAFE: "1" },
    (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "456\n", stderr: "" };
    },
  );

  assert.equal(pid, 456);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.env.CODEX_PANEL_CODEX_APP_PATH, appPath);
  assert.equal(calls[0].options.env.CODEX_PANEL_CODEX_PROFILE, profilePath);
  assert.equal(calls[0].options.env.CODEX_PANEL_CODEX_PORT, "43123");
  assert.match(calls[0].args.at(-1), /IApplicationActivationManager/);
  assert.match(calls[0].args.at(-1), /--remote-debugging-port=/);
  assert.match(calls[0].args.at(-1), /LocalNetworkAccessForSubframeNavigations/);
});
