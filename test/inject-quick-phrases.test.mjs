import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { DOMSerializer, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

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

test("command search ranks names before descriptions and filters each new query", () => {
  const start = source.indexOf("  function quickPhraseCommandRank(");
  const end = source.indexOf("  function quickPhrasesDocument(", start);
  const rank = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
  const skills = [
    { name: "openai-template:alpha", description: "Use this to review drafts" },
    { name: "shay-skills:code-review" },
    { name: "shay-skills:review-game" },
    { name: "shay-skills:review" },
    { name: "shay-skills:commit", interface: { displayName: "提交代码" } },
  ];
  const matches = query => skills.filter(skill => rank(skill, query) >= 0)
    .sort((left, right) => rank(left, query) - rank(right, query) || left.name.localeCompare(right.name))
    .map(skill => skill.name);
  assert.deepEqual(matches("review"), ["shay-skills:review", "shay-skills:review-game", "shay-skills:code-review", "openai-template:alpha"]);
  assert.deepEqual(matches("review-g"), ["shay-skills:review-game"]);
  assert.deepEqual(matches("提交"), ["shay-skills:commit"]);
  assert.deepEqual(matches("missing-command"), []);
});

test("quick phrase cards use native mention views without changing the composer or retaining old icons", () => {
  const dom = new JSDOM(`<html lang="zh-CN"><body>
    <div data-codex-composer-root data-composer-placement="home">
      <div data-codex-composer="true" contenteditable="true"></div>
    </div>
  </body></html>`, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const entries = new Set();
  const schema = new Schema({ nodes: {
    doc: { content: "paragraph+" }, paragraph: { content: "inline*", toDOM: () => ["p", 0] }, text: { group: "inline" },
    skillMention: { inline: true, group: "inline", attrs: { name: {}, displayName: {} },
      toDOM: node => ["span", { "skill-mention-name": node.attrs.name }, node.attrs.displayName] },
  } });
  let frames = [];
  const editor = window.document.querySelector("[contenteditable]");
  const controller = {
    plainTextMode: false,
    view: { dom: editor },
    setPromptText() { assert.fail("rendering a label must not change the composer draft"); },
    parsePromptText() {
      assert.equal(this.plainTextMode, true);
      return schema.node("doc", null, [schema.node("paragraph", null, [
        schema.nodes.skillMention.create({ name: "shay-skills:commit", displayName: "Shay Skills: Commit" }),
        schema.text(" 请提交"),
      ])]);
    },
    inlineMentionIconRegistry: {
      createView(document, spec) {
        const { dom } = DOMSerializer.renderSpec(document, spec);
        entries.add(dom);
        return { dom, destroy: () => entries.delete(dom) };
      },
      publish() {},
    },
  };
  try {
    window.setTimeout = () => 1;
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    window.Element.prototype.getBoundingClientRect = () => ({ left: 700, top: 52, width: 300, height: 100, bottom: 152 });
    editor.__reactFiber$fixture = { memoizedProps: { composerController: controller }, return: null };
    window.localStorage.setItem("codex-panel.quick-phrases.v1", "[$shay-skills:commit?label=Shay+Skills%3A+Commit](/test/SKILL.md) 请提交");
    window.__CODEX_PANEL_SOURCE_HASH__ = "native-quick-phrase-labels-test";
    window.eval(source);
    const pending = frames; frames = []; pending.forEach(callback => callback(0));
    const panel = window.document.getElementById("codex-panel-quick-phrases");
    assert.equal(panel.querySelector(".codex-panel-phrase > span").textContent, "Shay Skills: Commit 请提交");
    assert.equal(panel.querySelector(".codex-panel-phrase").title, "Shay Skills: Commit 请提交");
    assert.ok(panel.querySelector('[skill-mention-name="shay-skills:commit"]'));
    assert.equal(controller.plainTextMode, false);
    for (let index = 0; index < 3; index++) {
      panel.querySelector(".codex-panel-phrases-action-switch").click();
      assert.equal(entries.size, 1, "rerendering must unregister the previous native mention");
    }
    window.__codexPanelInjection__.destroy();
    assert.equal(entries.size, 0, "injection cleanup must unregister card mentions");
  } finally {
    window.__codexPanelInjection__?.destroy();
    window.close();
  }
});

test("saving a selected skill preserves its native display name and icon when parsed again", () => {
  const start = source.indexOf("  function quickPhrasesDocument(");
  const end = source.indexOf("  function renderQuickPhrases(", start);
  const api = vm.runInNewContext(`(() => { ${source.slice(start, end)} return { quickPhrasesText, quickPhrasesDocument }; })()`, { URLSearchParams });
  const schema = new Schema({ nodes: {
    doc: { content: "paragraph+" }, paragraph: { content: "inline*" }, text: { group: "inline" },
    skillMention: { inline: true, group: "inline", attrs: {
      name: {}, displayName: {}, path: {}, skillIcon: { default: null }, promptLinkLabel: { default: "" },
    } },
  } });
  const mention = schema.nodes.skillMention.create({ name: "shay-skills:commit", displayName: "Commit", path: "/isolated/SKILL.md", skillIcon: "pencil-sparkle" });
  const state = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph", null, [mention])]) });
  const controller = {
    getPersistedText(doc, options) {
      assert.equal(options.format, "plain");
      const node = doc.firstChild.firstChild;
      return `[${node.attrs.promptLinkLabel || `$${node.attrs.name}`}](${node.attrs.path})`;
    },
    parsePromptText(text) {
      const [, label, path] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text);
      const [name, query] = label.slice(1).split("?");
      const params = new URLSearchParams(query);
      return schema.node("doc", null, [schema.node("paragraph", null, [schema.nodes.skillMention.create({
        name, path, displayName: params.get("label") || name, skillIcon: params.get("icon"), promptLinkLabel: label,
      })])]);
    },
  };
  const saved = api.quickPhrasesText(controller, state);
  assert.equal(saved, "[$shay-skills:commit?label=Commit&icon=pencil-sparkle](/isolated/SKILL.md)");
  const restored = api.quickPhrasesDocument(controller, saved).firstChild.firstChild;
  assert.equal(restored.attrs.displayName, "Commit");
  assert.equal(restored.attrs.skillIcon, "pencil-sparkle");
  assert.equal(state.doc.firstChild.firstChild.attrs.promptLinkLabel, "", "serialization must leave the active editor document unchanged");
});
