import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const banner = '<aside><h3><div>You’re out of Codex and Work usage<span>Try again later.</span></div></h3><button>Add credits</button></aside>';

test("conversation banners stay hidden before deferred refresh, and restore when disabled", async () => {
  const dom = new JSDOM('<main></main><aside id="other"><h3>Connection error</h3><button>Retry</button></aside>', {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  const { window } = dom;
  try {
    // Keep deferred refreshes pending: hiding must happen before their timer runs.
    window.setTimeout = () => 1;
    window.__CODEX_PANEL_SOURCE_HASH__ = "usage-banner-test";
    window.__CODEX_PANEL_HOST_CAPABILITY__ = "test";
    window.eval(source);
    const heartbeat = (enabled) => window.dispatchEvent(new window.MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { type: "__codexPanelHostHeartbeatV1", capability: "test", at: Date.now(), hideUsageBanner: enabled },
    }));
    const main = window.document.querySelector("main");
    heartbeat(true);
    for (let i = 0; i < 2; i += 1) {
      main.innerHTML = banner;
      await new Promise(queueMicrotask);
      assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    }
    assert.notEqual(window.getComputedStyle(window.document.querySelector("#other")).display, "none");
    const title = main.querySelector("h3 div").firstChild;
    title.data = "A different notice";
    await new Promise(queueMicrotask);
    assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none");
    title.data = "You’re out of Codex and Work usage";
    await new Promise(queueMicrotask);
    assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    heartbeat(false);
    assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none");
  } finally {
    window.__codexPanelInjection__?.destroy();
    window.close();
  }
});
