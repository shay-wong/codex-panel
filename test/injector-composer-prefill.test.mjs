import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const injectedSource = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const functionStart = source.indexOf("async function prefillTaskComposerViaCdp");
const functionEnd = source.indexOf("\nasync function sendHostResponse", functionStart);
const functionSource = source.slice(functionStart, functionEnd);

test("composer prefill waits for the Skill menu to close between linked Skills", async () => {
  let now = 0;
  let selectedAll = false;
  let pendingSkill = null;
  let menuSkillIndex = 0;
  let overlayClosePolls = 0;
  let editorText = "";
  const inserted = [];
  const instruction = [
    "Continue work on issue LOCAL-42: Preserve context",
    "Before acting, use panelctl to read the latest issue content and every comment.",
  ].join("\n\n");
  const skills = [
    { name: "manage-panel", displayName: "Manage Panel", path: "/tmp/manage-panel/SKILL.md" },
    { name: "grill-me", displayName: "Grill Me", path: "/tmp/grill-me/SKILL.md" },
  ];
  const mentions = [];
  const editor = {
    get textContent() {
      return editorText;
    },
    getClientRects: () => [1],
    focus() {},
    querySelectorAll(selector) {
      return selector === "[skill-mention-name]" ? mentions : [];
    },
  };
  const button = {
    click() {
      const skill = pendingSkill;
      mentions.push({
        getAttribute(name) {
          if (name === "skill-mention-name") return skill.name;
          return name === "skill-mention-path" ? skill.path : null;
        },
      });
      editorText += skill.displayName;
      overlayClosePolls = 2;
    },
    querySelectorAll: () => [{ get textContent() { return pendingSkill?.displayName ?? ""; } }],
  };
  const overlay = {
    getClientRects() {
      if (!pendingSkill) return [];
      if (overlayClosePolls > 0 && --overlayClosePolls === 0) pendingSkill = null;
      return pendingSkill ? [1] : [];
    },
    querySelectorAll: () => [button],
  };
  const document = {
    createRange: () => ({
      selectNodeContents() {
        selectedAll = true;
      },
    }),
    querySelectorAll(selector) {
      return selector === '[data-composer-overlay-floating-ui="true"]' ? [overlay] : [editor];
    },
  };
  const window = {
    getSelection: () => ({ addRange() {}, removeAllRanges() {} }),
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const fakeSetTimeout = (callback, delay) => {
    now += delay;
    callback();
  };
  const prefillTaskComposerViaCdp = new Function(
    "Date",
    "setTimeout",
    `${functionSource}\nreturn prefillTaskComposerViaCdp;`,
  )(FakeDate, fakeSetTimeout);
  const cdp = {
    async send(method, params) {
      if (method === "Input.insertText") {
        inserted.push(params.text);
        if (params.text === "$") {
          if (selectedAll) editorText = "$";
          if (!pendingSkill) pendingSkill = skills[menuSkillIndex++];
          selectedAll = false;
        } else {
          editorText += params.text;
        }
        return {};
      }
      const evaluate = new Function("document", "window", `return ${params.expression}`);
      return { result: { value: evaluate(document, window) } };
    },
  };

  assert.deepEqual(
    await prefillTaskComposerViaCdp(cdp, undefined, {
      instruction,
      skills,
    }),
    { prefilled: true },
  );
  assert.deepEqual(inserted, ["$", " ", "$", instruction]);
  assert.ok(editorText.includes("LOCAL-42"));
  assert.equal(mentions.length, 2);
  assert.match(injectedSource, /const COMPOSER_PREFILL_REQUEST_TIMEOUT_MS = 36_000/);
  assert.match(
    injectedSource,
    /requestHost\("prefill-task-composer", \{[\s\S]*?\}, COMPOSER_PREFILL_REQUEST_TIMEOUT_MS\)/,
  );
});
