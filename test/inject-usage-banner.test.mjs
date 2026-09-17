import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const banner = '<aside><h3><div>You’re out of Codex and Work usage<span>Try again later.</span></div></h3><button>Add credits</button></aside>';
const currentBanner = '<aside><div><h3>Codex 和工作使用额度已用完</h3><div>你的速率限制将于稍后重置。</div></div><button>添加额度</button><button>重置使用量</button></aside>';

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
    const attachBannerType = (element, type) => {
      element.__reactFiber$test = {
        memoizedProps: {},
        return: { memoizedProps: { banner: { banner_type: type } }, return: null },
      };
    };
    heartbeat(true);
    for (let i = 0; i < 2; i += 1) {
      main.innerHTML = banner;
      attachBannerType(main.firstElementChild, "pro_rate_limit_reached");
      await new Promise(queueMicrotask);
      assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    }
    assert.notEqual(window.getComputedStyle(window.document.querySelector("#other")).display, "none");
    const title = main.querySelector("h3 div").firstChild;
    title.data = "Un nouveau titre sans correspondance";
    await new Promise(queueMicrotask);
    assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    title.data = "You’re out of Codex and Work usage";
    await new Promise(queueMicrotask);
    assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    main.innerHTML = currentBanner;
    attachBannerType(main.firstElementChild, "plus_rate_limit_reached");
    await new Promise(queueMicrotask);
    assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    for (const type of ["selected_model_limit_reached", "connection_error", "unknown_banner"]) {
      attachBannerType(main.firstElementChild, type);
      heartbeat(true);
      assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none", type);
    }
    delete main.firstElementChild.__reactFiber$test;
    heartbeat(true);
    assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none", "text alone does not identify a banner");
    attachBannerType(main.firstElementChild, "pro_rate_limit_reached");
    heartbeat(true);
    assert.equal(window.getComputedStyle(main.firstElementChild).display, "none");
    const currentProps = {};
    main.firstElementChild.__reactProps$test = currentProps;
    main.firstElementChild.__reactFiber$test.alternate = {
      memoizedProps: currentProps,
      return: { memoizedProps: { banner: { banner_type: "selected_model_limit_reached" } }, return: null },
    };
    heartbeat(true);
    assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none", "use current React props after an update");
    delete main.firstElementChild.__reactProps$test;
    attachBannerType(main.firstElementChild, "pro_rate_limit_reached");
    heartbeat(true);
    heartbeat(false);
    assert.notEqual(window.getComputedStyle(main.firstElementChild).display, "none");
  } finally {
    window.__codexPanelInjection__?.destroy();
    window.close();
  }
});
