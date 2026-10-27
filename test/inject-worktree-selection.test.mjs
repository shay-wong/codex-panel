import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const functionSource = source.slice(source.indexOf("  async function selectNativeWorktree("), source.indexOf("  async function selectNativeCollaborationMode("));
function harness(t, { checked = false, cloud = false, legacy = false } = {}) {
  const dom = new JSDOM(`<section data-codex-composer-root data-composer-placement="home"></section>`);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const root = document.querySelector("section");
  let now = 0, toggles = 0;
  const add = (html, parent = root) => { parent.insertAdjacentHTML("beforeend", html); return parent.lastElementChild; };
  const interactive = (element) => Boolean(element && !element.closest("[hidden]") && !element.disabled);
  if (legacy) {
    const trigger = add('<button data-composer-navigation-target="run-location" aria-expanded="false">本地模式</button>');
    trigger.onclick = () => {
      trigger.setAttribute("aria-expanded", "true");
      const item = add('<button role="menuitem">新建本地工作树</button>', document.body);
      item.onclick = () => { trigger.textContent = item.textContent; trigger.setAttribute("aria-expanded", "false"); item.remove(); toggles++; };
    };
  } else {
    const location = add(`<button aria-label="工作位置">${cloud ? "云端" : "此计算机"}</button>`);
    const settings = add('<button aria-label="配置本地环境"></button>');
    settings.hidden = cloud;
    location.onclick = () => {
      const item = add('<button role="menuitem">此计算机</button>', document.body);
      item.onclick = () => { location.textContent = "此计算机"; settings.hidden = false; item.remove(); };
    };
    settings.onclick = () => {
      const existing = document.getElementById("settings");
      if (existing) { existing.remove(); return; }
      const dialog = add(`<div id="settings" role="dialog" aria-label="配置本地环境"><label for="worktree">新建工作树</label><button id="worktree" role="switch" aria-checked="${checked}"></button></div>`, document.body);
      dialog.querySelector("button").onclick = event => { checked = !checked; event.currentTarget.setAttribute("aria-checked", String(checked)); toggles++; };
    };
  }
  const select = vm.runInNewContext(`(${functionSource})`, {
    document, Date: { now: () => now },
    window: { setTimeout: callback => { now += 80; callback(); } },
    normalizedLabel: value => String(value || "").trim().toLowerCase(),
    isInteractiveElement: interactive,
    NATIVE_WORKTREE_LABELS: ["新建本地工作树", "新增本機工作樹", "new local worktree"],
  });
  return { select, checked: () => checked, toggles: () => toggles, document };
}

test("new composer selects this computer and enables its separate worktree switch", async t => {
  const h = harness(t, { cloud: true });
  await h.select(true);
  assert.equal(h.checked(), true);
  assert.equal(h.toggles(), 1);
  assert.equal(h.document.querySelector('[role="dialog"]'), null);
});

test("new composer disables worktree mode and leaves an already correct switch alone", async t => {
  const h = harness(t, { checked: true });
  await h.select(false);
  assert.equal(h.checked(), false);
  await h.select(false);
  assert.equal(h.toggles(), 1);
});

test("legacy run-location menu still selects a worktree", async t => {
  const h = harness(t, { legacy: true });
  await h.select(true);
  assert.equal(h.toggles(), 1);
});
