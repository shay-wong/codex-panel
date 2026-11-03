import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { summarizeThreadUsage, readThreadUsage } from "../scripts/codex-thread-usage.mjs";
import { handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const event = (type, payload) => JSON.stringify({ type, payload }) + "\n";
const start = (turn_id) => event("event_msg", { type: "task_started", turn_id });
const usage = (seconds, output, input, cached) => JSON.stringify({
  timestamp: new Date(1_700_000_000_000 + seconds * 1000).toISOString(),
  type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { output_tokens: output, total_tokens: output + input },
    last_token_usage: { input_tokens: input, cached_input_tokens: cached },
  } },
}) + "\n";
const fixture = start("old") + usage(0, 10, 100, 100) + start("current")
  + usage(1, 20, 100, 0) + usage(11, 220, 900, 810);

test("throughput and weighted cache use only the current turn; missing data stays unknown", () => {
  const result = summarizeThreadUsage(fixture);
  assert.equal(result.speed, 20);
  assert.equal(result.cache, 81);
  assert.equal(summarizeThreadUsage(fixture + usage(11, 220, 900, 810)).cache, 81);
  assert.equal(summarizeThreadUsage(fixture + start("new")).speed, null);
  assert.equal(summarizeThreadUsage(fixture + start("new")).cache, null);
  assert.equal(summarizeThreadUsage(usage(1, 10, 100, 0) + usage(5, 20, 100, 50)).speed, null);
  assert.equal(summarizeThreadUsage(start("turn") + usage(0, 10, 100, 0) + usage(150, 20, 100, 50)).speed, null);
});

test("reads a bounded local tail through the trusted native thread path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panel-usage-test-"));
  try {
    const file = path.join(dir, `rollout-${id}.jsonl`);
    await writeFile(file, start("current") + event("response_item", { text: "x".repeat(600_000) })
      + usage(1, 20, 100, 0) + usage(11, 220, 900, 810) + '{"unfinished":');
    const read = async () => ({ thread: { id, path: file } });
    const { usage: result } = await readThreadUsage(id, read);
    assert.equal(result.speed, 20);
    assert.equal(result.cache, 81);
    assert.equal(result.partial, false);
    await assert.rejects(readThreadUsage("../file", read), /无效/);
    assert.deepEqual(await readThreadUsage(id, async () => ({ thread: { id: "other", path: file } })), { usage: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("accepts native continuation filenames while rejecting another thread's log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panel-usage-continuation-"));
  const continuationId = "22222222-2222-4222-8222-222222222222";
  try {
    for (const suffix of [id, `${id}_${continuationId}`, continuationId]) {
      const file = path.join(dir, `rollout-2026-10-23T11-16-27-${suffix}.jsonl`);
      await writeFile(file, fixture);
      const read = () => readThreadUsage(id, async () => ({ thread: { id, path: file } }));
      if (suffix === continuationId) await assert.rejects(read(), /路径不匹配/);
      else {
        const { usage: result } = await read();
        assert.equal(result.speed, 20);
        assert.equal(result.cache, 81);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("host bridge validates thread identity and does not forward renderer file paths", async () => {
  const request = { id: "usage-1", action: "read-thread-usage", threadId: id, path: "/secret" };
  let invalid;
  await handleHostBindingPayload({ payload: JSON.stringify({ ...request, threadId: "../../file" }), executionContextId: 1 }, {
    sendResponse: async (_, value) => { invalid = value; },
  });
  assert.equal(invalid.ok, false);
  let response;
  await handleHostBindingPayload({ payload: JSON.stringify(request), executionContextId: 1 }, {
    isAuthorizedContext: () => true,
    readThreadUsage: async (accepted) => { assert.equal(accepted.path, undefined); return { usage: { speed: 20, cache: 81 } }; },
    sendResponse: async (_, value) => { response = value; },
  });
  assert.equal(response.usage.cache, 81);
});

test("composer status follows its own thread and removes values on Home", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM(`<html lang="zh"><body><div data-codex-composer-root data-composer-placement="thread"><span data-above-composer-conversation-id="local:${id}"></span><div data-composer-surface-variant="default"><textarea></textarea></div></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    dom.window.Element.prototype.getBoundingClientRect = () => ({ height: 100 });
    dom.window.eval(`let destroyed = false; const OWNED_ATTRIBUTE = "data-codex-panel-owned";
      const normalizeThreadId = value => value.replace(/^local:/, "");
      const threadIdFromLocation = () => "${id}"; const hasLiveHostBinding = () => true;
      const requestHost = async () => ({ usage: { speed: 20, cache: 81, observedAt: Date.now() } });
      ${block}\nwindow.pollUsage = pollThreadUsage;`);
    await dom.window.pollUsage();
    const line = dom.window.document.querySelector(".codex-panel-usage-line");
    assert.match(line.textContent, /20 tok\/s.*缓存命中 81.0%/);
    assert.equal(line.previousElementSibling.hasAttribute("data-composer-surface-variant"), true);
    dom.window.document.querySelector("[data-codex-composer-root]").setAttribute("data-composer-placement", "home");
    await dom.window.pollUsage();
    assert.equal(dom.window.document.querySelector(".codex-panel-usage-line"), null);
  } finally { dom.window.close(); }
});
