import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const launcherSource = fs.readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

test("launcher keeps Codex CDP random and prefers the Panel port with a fallback", () => {
  assert.match(
    launcherSource,
    /fn loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/,
  );
  assert.match(launcherSource, /const PANEL_PREFERRED_PORT: u16 = 47823;/);
  assert.match(
    launcherSource,
    /fn panel_loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", PANEL_PREFERRED_PORT\)\)[\s\S]*?\.or_else\(\|_\| TcpListener::bind\(\("127\.0\.0\.1", 0\)\)\)/,
  );
  assert.equal(
    launcherSource.match(
      /fn panel_listener\([^)]*\)[\s\S]*?panel_loopback_listener\(\)\?/g,
    )?.length,
    2,
  );
  assert.match(
    launcherSource,
    /fn codex_port\([\s\S]*?let listener = loopback_listener\(\)\?;/,
  );
});

test("launcher lifecycle commands do not block WebView rendering", () => {
  const lifecycleCalls = {
    start_service: ["start_launcher", "current_ui_state"],
    stop_service: ["stop_managed_child", "current_ui_state"],
    reconnect_codex: ["restart_launcher", "current_ui_state"],
    open_embedded_panel: ["open_panel", "start_launcher"],
  };
  for (const [command, calls] of Object.entries(lifecycleCalls)) {
    const body = launcherSource.match(new RegExp(`async fn ${command}\\([\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(body, `${command} must remain async`);
    const blockingStart = body.indexOf("tauri::async_runtime::spawn_blocking(move || {");
    const blockingEnd = body.indexOf("\n    })", blockingStart);
    assert.ok(blockingStart >= 0, `${command} must use spawn_blocking`);
    assert.ok(blockingEnd > blockingStart, `${command} must await the blocking closure`);
    for (const call of calls) {
      const callIndex = body.indexOf(`${call}(`);
      assert.ok(
        callIndex > blockingStart && callIndex < blockingEnd,
        `${command} must keep ${call} inside spawn_blocking`,
      );
    }
  }
});
