import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const threadId = "11111111-1111-4111-8111-111111111111";

for (const placement of ["thread", "home"]) {
test(`quick phrases stay available and send from ${placement} without a project summary`, async () => {
  const dom = new JSDOM(`<html lang="zh-CN"><body>
    <div class="flex flex-col gap-3"><aside data-summary-panel-variant="summary" hidden></aside></div>
    <div data-codex-composer-root data-composer-placement="${placement}">
      <span data-above-composer-conversation-id="${placement === "thread" ? threadId : ""}"></span>
      <div><div data-codex-composer="true" contenteditable="true"></div></div>
      <button aria-label="发送" disabled>发送</button>
    </div>
  </body></html>`, { url: `http://localhost/${placement === "thread" ? `local/${threadId}` : ""}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  try {
    window.setTimeout = () => 1;
    let frames = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const flushFrames = () => { const pending = frames; frames = []; pending.forEach(callback => callback(0)); };
    window.Element.prototype.getClientRects = function () {
      return this.closest("[hidden]") ? [] : [this.getBoundingClientRect()];
    };
    window.Element.prototype.getBoundingClientRect = () => ({ left: 700, top: 52, width: 300, height: 100, bottom: 152 });
    const editor = window.document.querySelector("[contenteditable]");
    const send = window.document.querySelector('button[aria-label="发送"]');
    const submitted = [];
    editor.parentElement.__reactFiber$fixture = { memoizedProps: { composerController: {
      view: { dom: editor, focus: () => editor.focus() },
      getText: () => editor.textContent,
      setPromptText: text => { editor.textContent = text; send.disabled = !text; },
    } }, return: null };
    let receiveCommand;
    window.addEventListener("message", event => {
      if (event.data?.type !== "run-command") return;
      assert.equal(window.document.activeElement, editor, "native commands target the focused composer");
      assert.ok(["composer.queue", "composer.steer"].includes(event.data.id));
      send.click();
      receiveCommand?.(event.data.id);
    });
    send.addEventListener("click", () => { submitted.push(editor.textContent); editor.textContent = ""; send.disabled = true; });
    window.__CODEX_PANEL_SOURCE_HASH__ = "independent-quick-phrases-test";
    window.eval(source);
    flushFrames();
    const panel = window.document.getElementById("codex-panel-quick-phrases");
    assert.ok(panel && !panel.hidden, "quick phrases must mount without a visible summary");

    const summary = window.document.querySelector("aside");
    summary.hidden = false;
    window.__codexPanelInjection__.refresh();
    flushFrames();
    assert.equal(panel.hidden, false);
    assert.equal(panel.parentElement, summary.parentElement, "visible summary and phrases share the native animation container");
    assert.equal(panel.style.position, "");
    summary.hidden = true;
    window.__codexPanelInjection__.refresh();
    flushFrames();
    assert.equal(panel.hidden, false);
    assert.equal(panel.parentElement, window.document.body, "hidden summary restores independent placement");
    summary.remove();
    window.__codexPanelInjection__.refresh();
    flushFrames();
    assert.equal(panel.hidden, false);
    assert.ok(Number.parseFloat(panel.style.left) >= 0);
    assert.ok(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width) <= window.innerWidth);

    const command = new Promise(resolve => { receiveCommand = resolve; });
    panel.querySelector(".codex-panel-phrase").click();
    flushFrames();
    assert.equal(await command, "composer.queue");
    assert.deepEqual(submitted, ["继续"]);

    send.setAttribute("aria-label", "排队");
    const action = panel.querySelector(".codex-panel-phrases-action-switch");
    action.click();
    assert.equal(panel.querySelector(".codex-panel-phrases-action-mode").textContent, "直接引导");
    const steer = new Promise(resolve => { receiveCommand = resolve; });
    panel.querySelector(".codex-panel-phrase").click();
    flushFrames();
    assert.equal(await steer, "composer.steer", "running turns use native steer without looking for a Send button");
    assert.deepEqual(submitted, ["继续", "继续"]);

    action.click();
    assert.equal(panel.querySelector(".codex-panel-phrases-action-mode").textContent, "填入输入框");
    panel.querySelector(".codex-panel-phrase").click();
    assert.equal(editor.textContent, "继续");
    assert.equal(window.document.activeElement, editor);
    assert.deepEqual(submitted, ["继续", "继续"], "fill mode must keep the draft without submitting");
    assert.equal(window.localStorage.getItem("codex-panel.quick-phrases.action.v1"), "fill");
    action.click();
    assert.equal(panel.querySelector(".codex-panel-phrases-action-mode").textContent, "加入队列");

    const sidebar = window.document.createElement("aside");
    sidebar.setAttribute("data-app-shell-focus-area", "right-panel");
    window.document.body.append(sidebar);
    window.__codexPanelInjection__.refresh();
    flushFrames();
    assert.equal(panel.hidden, true, "quick phrases must not cover an open right sidebar");
    sidebar.remove();
    window.__codexPanelInjection__.refresh();
    flushFrames();
    assert.equal(panel.hidden, false, "closing the right sidebar restores quick phrases");
  } finally {
    window.__codexPanelInjection__?.destroy();
    window.close();
  }
});
}
