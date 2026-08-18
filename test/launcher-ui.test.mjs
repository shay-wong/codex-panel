import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("launcher actions show feedback on the button that was clicked", async () => {
  const html = fs.readFileSync(new URL("../src-tauri/ui/index.html", import.meta.url), "utf8");
  let openRequestPending = false;
  let finishRestart;
  let finishRefresh;
  let holdRefresh = false;
  let browserShouldFail = false;
  let phase = "waiting";
  let statusListener;
  const state = () => ({
    snapshot: {
      phase,
      message: phase === "running" ? "任务面板已在 Codex 客户端中打开。" : "Panel 服务已启动，正在等待 Codex 连接。",
      version: "0.1.0",
      childPid: 31281,
      openSignalPid: null,
      openRequestPending,
      embeddedVisible: false,
      updateMessage: "尚未检查更新。",
      updateAvailable: false,
      appPath: "/Applications/Codex.app",
    },
    preferences: { autoConnectCodex: true, autoOpenPanel: true },
    autostart: true,
    dataDirectory: "/tmp/panel-data",
    logPath: "/tmp/panel.log",
  });
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.scrollTo = () => {};
      window.__TAURI__ = {
        core: {
          invoke: async (action) => {
            if (action === "open_embedded_panel") openRequestPending = true;
            if (action === "open_browser_panel" && browserShouldFail) throw new Error("open failed");
            if (action === "reconnect_codex") {
              await new Promise((resolve) => { finishRestart = resolve; });
            }
            if (action === "launcher_ui_state" && holdRefresh) {
              await new Promise((resolve) => { finishRefresh = resolve; });
            }
            return action === "launcher_ui_state" ? state() : undefined;
          },
        },
        event: {
          listen: async (event, listener) => {
            if (event === "launcher-status") statusListener = listener;
            return () => {};
          },
        },
      };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const button = dom.window.document.getElementById("primaryAction");
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(button.textContent, "等待连接");
  assert.equal(button.disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 320));

  phase = "running";
  openRequestPending = false;
  statusListener({ payload: state().snapshot });
  assert.equal(button.textContent, "打开面板");
  assert.equal(button.disabled, false);

  const restartButton = dom.window.document.getElementById("restartService");
  restartButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(restartButton.classList.contains("is-busy"), true);
  assert.equal(restartButton.getAttribute("aria-busy"), "true");

  finishRestart();
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(restartButton.classList.contains("is-busy"), false);
  assert.equal(restartButton.classList.contains("is-success"), true);

  holdRefresh = true;
  const refreshButton = dom.window.document.getElementById("refresh");
  refreshButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshButton.classList.contains("is-busy"), true);
  finishRefresh();
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(refreshButton.classList.contains("is-busy"), false);
  assert.equal(refreshButton.classList.contains("is-success"), true);

  holdRefresh = false;
  const browserButton = dom.window.document.getElementById("browserPanel");
  browserButton.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(browserButton.classList.contains("is-busy"), true);

  browserShouldFail = true;
  await new Promise((resolve) => setTimeout(resolve, 220));
  browserButton.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(browserButton.classList.contains("is-busy"), true);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(browserButton.classList.contains("is-failed"), true);
  assert.match(dom.window.document.getElementById("errorText").textContent, /open failed/);

  refreshButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.document.getElementById("codexStatus").textContent, "连接已就绪");
  assert.equal(dom.window.document.getElementById("embeddedStatus").textContent, "可以打开");
  dom.window.close();
});
