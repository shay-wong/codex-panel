import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const injectedSource = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const functionStart = source.indexOf("async function prefillTaskComposerViaCdp");
const functionEnd = source.indexOf("\nasync function sendHostResponse", functionStart);
const functionSource = source.slice(functionStart, functionEnd);

test("composer prefill recovers a mention-only draft after slow Skill selection", async () => {
  let now = 0;
  let selectedAll = false;
  let mentionSelected = true;
  let mentionPolls = 0;
  let editorText = "Manage Panel";
  const inserted = [];
  const instruction = [
    "Continue work on issue LOCAL-42: Preserve context",
    "Before acting, use panelctl to read the latest issue content and every comment.",
  ].join("\n\n");
  const skillPath = "/tmp/manage-panel/SKILL.md";
  const mention = {
    getAttribute(name) {
      if (name === "skill-mention-name") return "manage-panel";
      if (name === "skill-mention-path") return skillPath;
      return null;
    },
  };
  const editor = {
    get textContent() {
      return editorText;
    },
    getClientRects: () => [1],
    focus() {},
    querySelectorAll(selector) {
      if (selector !== "[skill-mention-name]" || !mentionSelected) return [];
      if (mentionPolls++ > 59) return [mention];
      return [];
    },
  };
  const button = {
    click() {
      now = 7_920;
      mentionSelected = true;
      editorText = "Manage Panel";
    },
    querySelectorAll: () => [{ textContent: "Manage Panel" }],
  };
  const overlay = {
    getClientRects: () => [1],
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
          mentionSelected = false;
          selectedAll = false;
        } else {
          editorText = `Manage Panel${params.text.replace(/\s+/g, "")}`;
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
      skillDisplayName: "Manage Panel",
      skillName: "manage-panel",
      skillPath,
    }),
    { prefilled: true },
  );
  assert.deepEqual(inserted, ["$", instruction]);
  assert.ok(editorText.includes("LOCAL-42"));
  assert.ok(now > 12_000);
  assert.match(injectedSource, /const COMPOSER_PREFILL_REQUEST_TIMEOUT_MS = 36_000/);
  assert.match(
    injectedSource,
    /requestHost\("prefill-task-composer", \{[\s\S]*?\}, COMPOSER_PREFILL_REQUEST_TIMEOUT_MS\)/,
  );
});
