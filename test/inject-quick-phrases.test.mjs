import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const threadId = "11111111-1111-4111-8111-111111111111";

for (const placement of ["thread", "home"]) {
test(`quick phrases stay available and send from ${placement} without a project summary`, async () => {
  const dom = new JSDOM(`<html lang="zh-CN"><body>
    <aside data-summary-panel-variant="summary" hidden></aside>
    <div data-codex-composer-root data-composer-placement="${placement}">
      <span data-above-composer-conversation-id="${placement === "thread" ? threadId : ""}"></span>
      <div><div data-codex-composer="true" contenteditable="true"></div></div>
      <button aria-label="发送" disabled>发送</button>
    </div>
  </body></html>`, { url: `http://localhost/${placement === "thread" ? `local/${threadId}` : ""}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  try {
    window.setTimeout = () => 1;
    window.requestAnimationFrame = callback => { callback(); return 1; };
    window.Element.prototype.getClientRects = function () {
      return this.closest("[hidden]") ? [] : [this.getBoundingClientRect()];
    };
    window.Element.prototype.getBoundingClientRect = () => ({ left: 700, top: 52, width: 300, height: 100, bottom: 152 });
    const editor = window.document.querySelector("[contenteditable]");
    const send = window.document.querySelector('button[aria-label="发送"]');
    const submitted = [];
    editor.parentElement.__reactFiber$fixture = { memoizedProps: { composerController: {
      view: { dom: editor },
      getText: () => editor.textContent,
      setText: text => { editor.textContent = text; send.disabled = !text; },
    } }, return: null };
    send.addEventListener("click", () => { submitted.push(editor.textContent); editor.textContent = ""; send.disabled = true; });
    window.__CODEX_PANEL_SOURCE_HASH__ = "independent-quick-phrases-test";
    window.eval(source);
    const panel = window.document.getElementById("codex-panel-quick-phrases");
    assert.ok(panel && !panel.hidden, "quick phrases must mount without a visible summary");

    const summary = window.document.querySelector("aside");
    summary.hidden = false;
    window.__codexPanelInjection__.refresh();
    assert.equal(panel.hidden, false);
    assert.ok(Number.parseFloat(panel.style.top) > summary.getBoundingClientRect().bottom);
    summary.hidden = true;
    window.__codexPanelInjection__.refresh();
    assert.equal(panel.hidden, false);
    summary.remove();
    window.__codexPanelInjection__.refresh();
    assert.equal(panel.hidden, false);
    assert.ok(Number.parseFloat(panel.style.left) >= 0);
    assert.ok(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width) <= window.innerWidth);

    panel.querySelector(".codex-panel-phrase").click();
    await Promise.resolve();
    assert.deepEqual(submitted, ["继续"]);

    const sidebar = window.document.createElement("aside");
    sidebar.setAttribute("data-app-shell-focus-area", "right-panel");
    window.document.body.append(sidebar);
    window.__codexPanelInjection__.refresh();
    assert.equal(panel.hidden, true, "quick phrases must not cover an open right sidebar");
    sidebar.remove();
    window.__codexPanelInjection__.refresh();
    assert.equal(panel.hidden, false, "closing the right sidebar restores quick phrases");
  } finally {
    window.__codexPanelInjection__?.destroy();
    window.close();
  }
});
}
