import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { summarizeThreadUsage, readThreadUsage } from "../scripts/codex-thread-usage.mjs";
import { handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const epoch = 1_700_000_000_000;
const event = (type, payload, seconds = 0) => JSON.stringify({ timestamp: new Date(epoch + seconds * 1000).toISOString(), type, payload }) + "\n";
const start = (turn_id, seconds = 0) => event("event_msg", { type: "task_started", turn_id }, seconds);
const end = (turn_id, seconds) => event("event_msg", { type: "task_complete", turn_id }, seconds);
const usage = (seconds, output, input, cached, lastOutput = output) => JSON.stringify({
  timestamp: new Date(1_700_000_000_000 + seconds * 1000).toISOString(),
  type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { output_tokens: output, total_tokens: output + input },
    last_token_usage: { output_tokens: lastOutput, input_tokens: input, cached_input_tokens: cached },
  } },
}) + "\n";
const fixture = start("old") + usage(0, 10, 100, 100) + start("current")
  + usage(1, 30, 100, 0, 20) + usage(11, 230, 900, 810, 200) + end("current", 11);

test("throughput and weighted cache use only the current turn; missing data stays unknown", () => {
  const result = summarizeThreadUsage(fixture);
  assert.equal(result.speed, 20);
  assert.equal(result.cache, 81);
  assert.equal(summarizeThreadUsage(fixture + usage(11, 230, 900, 810, 200)).cache, 81);
  assert.equal(summarizeThreadUsage(fixture + start("new")).speed, null);
  assert.equal(summarizeThreadUsage(fixture + start("new")).cache, null);
  assert.equal(summarizeThreadUsage(fixture + start("new")).inProgress, true);
  assert.equal(summarizeThreadUsage(fixture + event("event_msg", { type: "task_complete", turn_id: "current" })).inProgress, false);
  assert.equal(summarizeThreadUsage(fixture + event("event_msg", { type: "turn_aborted", turn_id: "current" })).inProgress, false);
  assert.equal(summarizeThreadUsage(usage(1, 10, 100, 0) + usage(5, 20, 100, 50)).speed, null);
  const firstOutput = start("turn") + usage(50, 4090, 100, 0);
  assert.equal(summarizeThreadUsage(firstOutput, epoch + 50_000).speed, 81.8);
  assert.equal(summarizeThreadUsage(firstOutput, epoch + 100_000).speed, 40.9);
  assert.equal(summarizeThreadUsage(firstOutput + end("turn", 100), epoch + 500_000).speed, 40.9);
  assert.equal(summarizeThreadUsage(start("turn") + usage(150, 4090, 100, 0) + end("turn", 200)).speed, 20.45);
});

test("reads a bounded local tail through the trusted native thread path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panel-usage-test-"));
  try {
    const file = path.join(dir, `rollout-${id}.jsonl`);
    await writeFile(file, start("current") + event("response_item", { text: "x".repeat(600_000) })
      + usage(1, 20, 100, 0) + usage(11, 220, 900, 810, 200) + end("current", 11) + '{"unfinished":');
    const read = async () => ({ thread: { id, path: file } });
    const { usage: result } = await readThreadUsage(id, read);
    assert.equal(result.speed, 20);
    assert.equal(result.cache, 81);
    assert.equal(result.partial, false);
    await assert.rejects(readThreadUsage("../file", read), /无效/);
    assert.deepEqual(await readThreadUsage(id, async () => ({ thread: { id: "other", path: file } })), { usage: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a mid-turn context in a truncated tail cannot replace the real start boundary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panel-usage-context-"));
  try {
    const text = start("current") + usage(10, 1000, 100, 80)
      + event("response_item", { text: "x".repeat(2_200_000) }, 20)
      + event("turn_context", { turn_id: "current" }, 30)
      + usage(90, 4090, 100, 80, 3090) + end("current", 100);
    const file = path.join(dir, `rollout-${id}.jsonl`);
    await writeFile(file, text);
    const result = await readThreadUsage(id, async () => ({ thread: { id, path: file } }));
    assert.deepEqual(result.usage, summarizeThreadUsage(text));
    assert.equal(result.usage.speed, 40.9);
    const partial = summarizeThreadUsage(event("turn_context", { turn_id: "current" }, 30)
      + usage(90, 4090, 100, 80, 3090) + end("current", 100));
    assert.equal(partial.partial, true);
    assert.equal(partial.speed, null);
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
  const dom = new JSDOM(`<html lang="zh"><body><div data-codex-composer-root data-composer-placement="thread"><span data-above-composer-conversation-id="local:${id}"></span><div data-composer-surface-variant="default"><textarea></textarea><div data-composer-trailing-controls><div class="flex items-center justify-end"><button>模型</button><button>发送</button></div></div></div></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    dom.window.Element.prototype.getBoundingClientRect = () => ({ height: 100 });
    dom.window.matchMedia = () => ({ matches: true });
    dom.window.eval(`let destroyed = false; let showThreadUsage = true; let threadUsageAboveComposer = false; let usageDotMatrix = true; let usageAnimationMode = "smooth"; let usageAnimationMinSpeed = 5; let usageAnimationMaxSpeed = 40; const OWNED_ATTRIBUTE = "data-codex-panel-owned";
      const normalizeThreadId = value => value.replace(/^local:/, "");
      const threadIdFromLocation = () => "${id}"; const hasLiveHostBinding = () => true;
      const nativeDesktopServices = async () => null;
      const requestHost = async () => {
        if (window.usageFailure) throw new Error("Read timed out");
        return window.usageResult ?? ({ usage: { speed: 20, outputTokens: 200, inputTokens: 100, cachedInputTokens: 81, cache: 81, totalTokens: 300, turnId: "first", startedAt: Date.now() - 10000, endedAt: Date.now(), observedAt: Date.now(), inProgress: false } });
      };
      ${block}\nwindow.pollUsage = () => { usagePolledAt = 0; return pollThreadUsage(); }; window.renderUsage = renderUsageLine; window.usageNotification = onUsageNotification; window.usageStates = usageLines; window.tickUsage = () => usageLines.forEach(state => renderUsageState(state));`);
    await dom.window.pollUsage();
    const line = dom.window.document.querySelector(".codex-panel-usage-line");
    assert.match(line.textContent, /--\s*tok\/s.*缓存命中\s*81.0%/);
    assert.equal(line.querySelectorAll('svg[aria-hidden="true"][stroke="currentColor"]').length, 2);
    assert.equal(line.parentElement.closest("[data-composer-trailing-controls]") != null, true);
    assert.equal(line.nextElementSibling.textContent, "模型");
    dom.window.renderUsage(line, { speed: null, cache: null, inProgress: true });
    assert.equal(line.querySelectorAll('.codex-panel-usage-dots i').length, 3);
    assert.match(line.querySelector('[data-usage-speed]').textContent, /--\s*tok\/s/);
    const dots = line.querySelector('.codex-panel-usage-dots');
    dom.window.renderUsage(line, { speed: null, cache: null, inProgress: true });
    assert.equal(line.querySelector('.codex-panel-usage-dots'), dots);
    dom.window.renderUsage(line, { speed: null, cache: 81, inProgress: true });
    assert.equal(line.querySelectorAll('.codex-panel-usage-dots').length, 0);
    assert.match(line.textContent, /缓存命中\s*81.0%/);
    dom.window.renderUsage(line, { speed: null, cache: 81, inProgress: false });
    assert.equal(line.querySelector('.codex-panel-usage-dots'), null);
    assert.match(line.textContent, /--\s*tok\/s/);
    dom.window.renderUsage(line, { speed: null, cache: null, inProgress: true }, true);
    assert.equal(line.querySelector('.codex-panel-usage-dots'), null);
    let now = epoch;
    dom.window.Date.now = () => now;
    const notify = (method, params, hostId = "local") => dom.window.usageNotification({
      source: null, origin: "", data: { type: "mcp-notification", hostId, method, params: { threadId: id, ...params } },
    });
    notify("turn/started", { turn: { id: "live", startedAt: epoch / 1000 } });
    now += 10_000;
    for (const method of ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/plan/delta"]) {
      notify(method, { turnId: "live", delta: "a".repeat(400) });
    }
    assert.equal([...dom.window.usageStates.values()][0].pendingTokens, 0);
    assert.match(line.querySelector('[data-usage-speed]').textContent, /--\s*tok\/s/);
    notify("item/agentMessage/delta", { turnId: "live", delta: "a".repeat(400) });
    assert.match(line.querySelector('[data-usage-speed]').textContent, /33.3\s*tok\/s/);
    now += 1_000;
    notify("item/agentMessage/delta", { turnId: "live", delta: "a".repeat(400) });
    assert.match(line.textContent, /66.7\s*tok\/s/);
    assert.doesNotMatch(line.textContent, /≈/);
    assert.match(line.title, /估算/);
    now += 500;
    dom.window.tickUsage();
    assert.match(line.textContent, /66.7\s*tok\/s/, "the last body sample must not decay between arrivals");
    now += 2_500;
    dom.window.tickUsage();
    assert.match(line.textContent, /66.7\s*tok\/s/);
    dom.window.usageFailure = true;
    await dom.window.pollUsage();
    assert.match(line.textContent, /66.7\s*tok\/s/);
    assert.equal([...dom.window.usageStates.values()][0].usage.turnId, "live");
    dom.window.usageFailure = false;
    dom.window.usageResult = { usage: null };
    await dom.window.pollUsage();
    assert.match(line.textContent, /66.7\s*tok\/s/);
    notify("item/agentMessage/delta", { turnId: "live", itemId: "next-body", delta: "a".repeat(400) });
    assert.match(line.textContent, /33.3\s*tok\/s/);
    now += 1_000;
    notify("item/agentMessage/delta", { turnId: "live", itemId: "next-body", delta: "a".repeat(400) });
    assert.match(line.textContent, /66.7\s*tok\/s/);
    delete dom.window.usageResult;
    const actual = { turnId: "live", tokenUsage: { last: { outputTokens: 4090, inputTokens: 100, cachedInputTokens: 80 }, total: { totalTokens: 4490 } } };
    notify("thread/tokenUsage/updated", actual);
    assert.match(line.textContent, /66.7\s*tok\/s.*缓存命中\s*80.0%/);
    assert.match(line.title, /估算/);
    notify("thread/tokenUsage/updated", actual);
    assert.match(line.textContent, /66.7\s*tok\/s/);
    notify("turn/completed", { turn: { id: "live", durationMs: 15_000 } });
    now += 100_000;
    dom.window.tickUsage();
    assert.match(line.textContent, /66.7\s*tok\/s/);
    notify("item/agentMessage/delta", { turnId: "live", delta: "ignored" });
    assert.match(line.title, /估算/);
    notify("turn/started", { turn: { id: "remote" } }, "remote");
    assert.match(line.textContent, /66.7\s*tok\/s/);
    const live = [...dom.window.usageStates.values()][0];
    live.pendingTokens = 900;
    dom.window.usageResult = { usage: { ...live.usage } };
    await dom.window.pollUsage();
    assert.equal(live.pendingTokens, 0);
    assert.match(line.textContent, /66.7\s*tok\/s/);
    notify("turn/started", { turn: { id: "next" } });
    assert.equal(line.querySelectorAll('.codex-panel-usage-dots i').length, 3);
    dom.window.document.querySelector("[data-codex-composer-root]").setAttribute("data-composer-placement", "home");
    await dom.window.pollUsage();
    assert.equal(dom.window.document.querySelector(".codex-panel-usage-line"), null);
  } finally { dom.window.close(); }
});

test("native manager streams update TPS once and release every subscription when hidden", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM(`<div data-codex-composer-root data-composer-placement="thread"><span data-above-composer-conversation-id="local:${id}"></span><div id="card"><div id="line"><svg><path data-usage-needle></path></svg><span data-usage-speed></span><span data-usage-cache></span></div></div></div>`, { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    let now = 10_000;
    const disposed = [];
    let onManager, onDelta, breakStream;
    const resource = name => ({ [Symbol.dispose]() { disposed.push(name); }, onRpcBroken() {} });
    const stream = Object.assign(Promise.resolve(resource("stream lease")), resource("stream pending"));
    stream.onRpcBroken = callback => { breakStream = callback; };
    const client = { ...resource("client"), subscribe(options) {
      assert.equal(options.type, "notification");
      assert.equal(options.key.hostId, "local");
      assert.equal(options.methods, "item/agentMessage/delta");
      onDelta = options.listener;
      return stream;
    } };
    const managers = { ...resource("managers"), subscribe(host, listener) {
      assert.equal(host, "local");
      onManager = listener;
      return Object.assign(Promise.resolve(resource("manager lease")), resource("manager pending"));
    } };
    dom.window.services = { appServerManagers: { dup: () => managers } };
    dom.window.Date.now = () => now;
    dom.window.matchMedia = () => ({ matches: true });
    dom.window.eval(`let destroyed = false; let showThreadUsage = true; let usageDotMatrix = true; let usageAnimationMode = "smooth";
      const nativeDesktopServices = async () => window.services;
      const normalizeThreadId = value => value.replace(/^local:/, "");
      ${block}\nwindow.state = { threadId: "${id}", line: document.getElementById("line"), pendingTokens: 0, revision: 0,
        usage: { turnId: "turn", inProgress: true, outputTokens: 0, cache: 80 } };
      usageLines.set(document.getElementById("card"), window.state);
      window.connectUsage = connectNativeUsage; window.notifyUsage = onUsageNotification;
      window.hideUsage = () => setThreadUsageVisible(false);`);
    await dom.window.connectUsage();
    onManager({ status: "ready", manager: { dup: () => client } });
    await Promise.resolve();
    const notification = { method: "item/agentMessage/delta", params: { threadId: id, turnId: "turn", itemId: "body", delta: "a".repeat(400) } };
    onDelta(notification, now - 500);
    // 新版没有旧广播，直接 RPC 也必须让正文速度工作。
    now += 1_000;
    onDelta(notification, now - 500);
    assert.equal(dom.window.state.speedSamples.at(-1).at, now - 500, "原生接收时刻独立于界面回调时间");
    assert.match(dom.window.document.querySelector("[data-usage-speed]").textContent, /66.7\s*tok\/s/);
    assert.equal(dom.window.state.pendingTokens, 200);
    dom.window.notifyUsage({ source: null, origin: "", data: { type: "mcp-notification", hostId: "local", ...notification } });
    assert.equal(dom.window.state.pendingTokens, 200, "原生直连和旧广播不得重复计数");
    breakStream();
    assert.deepEqual(disposed.toSorted(), ["client", "manager lease", "manager pending", "managers", "stream lease", "stream pending"].toSorted());
    dom.window.hideUsage();
    onDelta(notification);
    assert.equal(dom.window.state.pendingTokens, 200, "关闭后晚到的正文回调不得更新");
    assert.equal(new Set(disposed).size, disposed.length, "释放操作须可重复调用而不重复释放资源");
  } finally { dom.window.close(); }
});

test("fixed receive windows show same-tick bursts and preserve readings between messages", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM('<div id="line"><svg><path data-usage-needle></path></svg><span data-usage-speed></span><span data-usage-cache></span></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    let now = 10_000;
    dom.window.Date.now = () => now;
    dom.window.matchMedia = () => ({ matches: true });
    dom.window.eval(`let usageDotMatrix = true; let usageAnimationMode = "smooth"; let usageAnimationMinSpeed = 5; let usageAnimationMaxSpeed = 40;
      ${block}\nwindow.resetUsage = () => {
        window.current = { line: document.getElementById("line"), pendingTokens: 0,
          usage: { inProgress: true, startedAt: 0, outputTokens: 0, cache: 80 } };
      };
      window.addTokens = (tokens, itemId, receivedAtMs) => { recordUsageDelta(window.current, tokens, itemId, receivedAtMs); renderUsageState(window.current); };
      window.drawUsage = () => renderUsageState(window.current);
      window.finishUsage = () => { window.current.usage.inProgress = false; window.current.usage.endedAt = Date.now(); renderUsageState(window.current); };
      window.resetUsage();`);
    const text = () => dom.window.document.querySelector('[data-usage-speed]').textContent;
    for (let count = 0; count < 100; count++) dom.window.addTokens(1);
    assert.match(text(), /33.3\s*tok\/s/, "同一毫秒收到的正文也立即计入固定窗口");
    now += 4_000;
    dom.window.drawUsage();
    assert.match(text(), /33.3\s*tok\/s/);
    dom.window.finishUsage();
    assert.match(text(), /33.3\s*tok\/s/);

    dom.window.resetUsage();
    dom.window.addTokens(43.5, "batched-body");
    now += 2;
    dom.window.addTokens(122.75, "batched-body");
    assert.match(text(), /55.4\s*tok\/s/, "复现现场 2ms 两批正文，不能持续 -- 或按 2ms 算出虚高速率");
    dom.window.finishUsage();
    assert.match(text(), /55.4\s*tok\/s/);

    dom.window.resetUsage();
    dom.window.addTokens(20);
    now += 100;
    dom.window.addTokens(50);
    dom.window.finishUsage();
    assert.match(text(), /23.3\s*tok\/s/, "短回复按固定窗口计数，不再要求最短回调间隔");
    now += 5_000;
    dom.window.drawUsage();
    assert.match(text(), /23.3\s*tok\/s/);

    dom.window.resetUsage();
    dom.window.addTokens(20);
    now += 1_000;
    dom.window.addTokens(100);
    now += 4_000;
    dom.window.drawUsage();
    assert.match(text(), /40.0\s*tok\/s/, "短暂停顿不能清空已测得的读数");
    dom.window.finishUsage();
    assert.match(text(), /40.0\s*tok\/s/, "completion preserves output speed instead of idle zero");

    dom.window.resetUsage();
    dom.window.addTokens(100, "body-a");
    for (let arrival = 0; arrival < 3; arrival++) {
      now += 4_000;
      dom.window.addTokens(100, "body-a");
      assert.match(text(), /33.3\s*tok\/s/, "新批次到达时仅计入最近三秒收到的 Token");
    }
    now += 60_000;
    dom.window.drawUsage();
    assert.match(text(), /33.3\s*tok\/s/);
    dom.window.addTokens(100, "body-b");
    assert.match(text(), /33.3\s*tok\/s/, "新消息不得混入上一条正文的 Token");
    now += 1_000;
    dom.window.addTokens(100, "body-b");
    assert.match(text(), /66.7\s*tok\/s/, "新正文不得计入两条消息之间的工具等待");

    dom.window.resetUsage();
    for (let second = 0; second < 6; second++) {
      dom.window.addTokens(300, "continuous-body");
      if (second >= 2) assert.match(text(), /300.0\s*tok\/s/, "稳定流持续使用完整三秒窗口");
      now += 1_000;
    }

    dom.window.resetUsage();
    dom.window.addTokens(300, "queued-body", now - 4_000);
    dom.window.addTokens(300, "queued-body", now);
    assert.match(text(), /100.0\s*tok\/s/, "同一回调批次仍按原始接收时刻排除窗口外片段");
  } finally { dom.window.close(); }
});

test("usage retargeting changes velocity gradually while keeping the current value", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM('<div id="line"><svg><path data-usage-needle></path></svg><span data-usage-speed></span><span data-usage-cache></span></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    let time = 0;
    let sequence = 0;
    const frames = new Map();
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.performance.now = () => time;
    dom.window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    dom.window.cancelAnimationFrame = frame => frames.delete(frame);
    dom.window.eval(`let usageDotMatrix = true; let usageAnimationMode = "smooth"; let usageAnimationMinSpeed = 0.2; let usageAnimationMaxSpeed = 20;
      ${block}\nwindow.showUsage = speed => renderUsageLine(document.getElementById("line"), { speed, cache: 80 });`);
    const value = () => (Number(dom.window.document.querySelector("[data-usage-needle]").getAttribute("transform").match(/rotate\(([^ ]+)/)[1]) + 90) / 1.8;
    const step = () => {
      const before = value();
      time += 20;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(time));
      return (value() - before) / 0.02;
    };
    dom.window.showUsage(40);
    dom.window.showUsage(42);
    let priorVelocity;
    for (let frame = 0; frame < 6; frame++) priorVelocity = step();
    const beforeRetarget = value();
    dom.window.showUsage(90);
    assert.equal(value(), beforeRetarget);
    const accelerating = step();
    assert.ok(accelerating > priorVelocity);
    assert.ok(accelerating < 20 - 1e-6, "a new target must not instantly jump to maximum speed");
    let forwardVelocity;
    for (let frame = 0; frame < 8; frame++) forwardVelocity = step();
    const beforeReverse = value();
    dom.window.showUsage(10);
    assert.equal(value(), beforeReverse);
    const reversing = step();
    assert.ok(reversing < forwardVelocity);
    assert.ok(reversing < 0, "a lower target must not carry the value farther upward");
    assert.ok(reversing > -20 + 1e-6, "direction changes must accelerate from rest instead of jumping to reverse maximum");
    for (let frame = 0; frame < 40; frame++) step();
    assert.ok(value() < beforeReverse, "the latest target must take over without waiting for the old one");
  } finally { dom.window.close(); }
});

test("body TPS holds its sample between arrivals and does not recalculate at completion", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM('<div id="line"><svg><path data-usage-needle></path></svg><span data-usage-speed></span><span data-usage-cache></span></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    let time = 10_000;
    let sequence = 0;
    const frames = new Map();
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.performance.now = () => time;
    dom.window.Date.now = () => time;
    dom.window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    dom.window.cancelAnimationFrame = frame => frames.delete(frame);
    dom.window.eval(`let usageDotMatrix = true; let usageAnimationMode = "smooth"; let usageAnimationMinSpeed = 0.5; let usageAnimationMaxSpeed = 50;
      ${block}\nwindow.liveUsage = { line: document.getElementById("line"), pendingTokens: 0, lastSpeed: 40,
        speedSamples: [{ at: 8000, tokens: 0 }, { at: 9000, tokens: 40 }, { at: 10000, tokens: 80 }],
        usage: { startedAt: 0, inProgress: true, outputTokens: 400, cache: 80 } };
      window.drawLiveUsage = () => renderUsageState(window.liveUsage);
      window.animation = () => usageValueAnimations.get(document.querySelector('[data-usage-speed]'));
      window.drawLiveUsage();`);
    const value = () => dom.window.animation().value;
    const step = () => {
      time += 20;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(time));
    };
    assert.equal(value(), 40);
    dom.window.liveUsage.lastSpeed = 80;
    dom.window.drawLiveUsage();
    assert.equal(dom.window.animation().target, 80);
    step();
    assert.equal(dom.window.animation().target, 80, "elapsed time must not change the sampled rate");
    for (let frame = 0; frame < 20; frame++) step();
    const shown = (Number(dom.window.document.querySelector("[data-usage-needle]").getAttribute("transform").match(/rotate\(([^ ]+)/)[1]) + 90) / 1.8;
    const fraction = dom.window.document.querySelector(".codex-panel-usage-odometer").lastElementChild.querySelector(".codex-panel-usage-track");
    assert.ok(Math.abs(Number(fraction.style.getPropertyValue("--usage-offset")) - (1 + (shown * 10 % 10 + 10) % 10)) < 1e-8,
      "live targets must retain the fractional wheel position between displayed decimal values");
    for (let frame = 0; frame < 200; frame++) step();
    assert.equal(value(), 80);
    assert.equal(frames.size, 0, "a settled rate needs no animation frames while waiting for new samples");
    dom.window.drawLiveUsage();
    assert.match(dom.window.document.querySelector('[data-usage-speed]').textContent, /80.0\s*tok\/s/);
    dom.window.liveUsage.speedSamples = [{ at: time - 1000, tokens: 0 }, { at: time, tokens: 100 }];
    dom.window.liveUsage.lastSpeed = 100;
    dom.window.drawLiveUsage();
    assert.equal(dom.window.animation().target, 100);
    dom.window.liveUsage.usage.inProgress = false;
    dom.window.liveUsage.usage.endedAt = time;
    dom.window.drawLiveUsage();
    for (let frame = 0; frame < 600 && frames.size; frame++) step();
    assert.equal(frames.size, 0);
    assert.equal(value(), 100);
  } finally { dom.window.close(); }
});

test("dot animation offers morphing while plain numbers always fade", async () => {
  const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const usageLines = new Map();"), source.indexOf("  function mount() {"));
  const dom = new JSDOM('<div id="line"><svg><path data-usage-needle></path></svg><span data-usage-speed></span><span data-usage-cache></span></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  try {
    const animations = [];
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.Element.prototype.animate = function animate(frames, options) {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; }, onfinish: null };
      animations.push(animation);
      return animation;
    };
    dom.window.eval(`let usageDotMatrix = true; let usageAnimationMode = "morph"; let usageAnimationMinSpeed = 5; let usageAnimationMaxSpeed = 40;
      ${block}\nwindow.showUsage = (speed, dotMatrix = true, mode = "morph") => { usageDotMatrix = dotMatrix; usageAnimationMode = mode; renderUsageLine(document.getElementById("line"), { speed, cache: 80 }); };`);
    dom.window.showUsage(10);
    dom.window.showUsage(20);
    assert.ok(dom.window.document.querySelectorAll("[data-usage-speed] svg circle").length > 0);
    assert.ok(animations.length > 0);
    assert.ok(animations.every(animation => animation.options.duration === 500));
    dom.window.showUsage(30, false, "smooth");
    dom.window.showUsage(40, false, "smooth");
    assert.ok(dom.window.document.querySelector(".codex-panel-usage-plain-number"));
    assert.equal(animations.at(-1).options.duration, 120);
    animations.at(-1).onfinish();
    assert.equal(animations.at(-1).options.duration, 180);
    assert.equal(dom.window.document.querySelector(".codex-panel-usage-plain-number").textContent, "40.0");
    dom.window.showUsage(40, true);
    assert.ok(dom.window.document.querySelector("[data-usage-speed] svg circle"));
    assert.equal(dom.window.document.querySelector(".codex-panel-usage-plain-number"), null);
    assert.equal(dom.window.document.querySelector("[data-usage-needle]").getAttribute("transform"), "rotate(-18 12 15)");
    dom.window.showUsage(500);
    assert.match(dom.window.document.querySelector('[data-usage-speed]').textContent, /500.0/);
    assert.match(dom.window.document.querySelector('#line').title, /仅指针/);
    assert.equal(dom.window.document.querySelector('[data-usage-needle]').getAttribute('transform'), 'rotate(90 12 15)');
  } finally { dom.window.close(); }
});
