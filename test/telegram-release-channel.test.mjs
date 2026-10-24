import test from "node:test";
import assert from "node:assert/strict";
import { channelMessage, sendChannelMessage } from "../scripts/telegram-release-channel.mjs";

const tag = "v0.4.7-fork";
const release = {
  tagName: tag, isDraft: false,
  url: `https://github.com/shay-wong/codex-panel/releases/tag/${tag}`,
  body: '## 更新内容\n\n- 修复 & <标题> "引号" 😀\n- 感谢 [贡献者](https://example.com)\n\n## Changes\n- English',
  assets: [{ name: "Codex.Panel_0.4.7-fork_universal.dmg", size: 110069328, state: "uploaded", url: `https://github.com/shay-wong/codex-panel/releases/download/${tag}/Codex.Panel_0.4.7-fork_universal.dmg` }],
};

test("channel announcement validates the published DMG and escapes bounded Chinese release notes", () => {
  const text = channelMessage(release, tag);
  assert.match(text, /&amp; &lt;标题&gt; &quot;引号&quot; 😀/);
  assert.match(text, /感谢 贡献者/);
  assert.doesNotMatch(text, /本频道提供下载链接|未直接传包/);
  assert.doesNotMatch(text, /English/);
  assert.throws(() => channelMessage({ ...release, isDraft: true }, tag));
  assert.throws(() => channelMessage({ ...release, assets: [] }, tag));
  assert.throws(() => channelMessage(release, "v0.4.8-fork"));
  const long = channelMessage({ ...release, body: `- ${'😀<&'.repeat(5000)}` }, tag);
  const rendered = long.replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  assert.ok(rendered.length <= 4096);
  assert.ok(rendered.isWellFormed());
  assert.doesNotMatch(channelMessage({ ...release, body: "" }, tag), /更新内容/);
});

test("channel delivery requires API confirmation and never retries an unknown delivery", async () => {
  const args = { token: "fake-token", chatId: "-1004305126751", text: channelMessage(release, tag) };
  assert.equal(await sendChannelMessage({ ...args, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.telegram.org/botfake-token/sendMessage");
    assert.equal(JSON.parse(options.body).chat_id, args.chatId);
    assert.equal(JSON.parse(options.body).parse_mode, "HTML");
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  } }), 42);
  await assert.rejects(sendChannelMessage({ ...args, token: "" }), /缺少/);
  await assert.rejects(sendChannelMessage({ ...args, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false }) }) }), /发送失败/);
  await assert.rejects(sendChannelMessage({ ...args, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }) }), /发送失败/);
  let calls = 0;
  await assert.rejects(sendChannelMessage({ ...args, fetchImpl: async () => { calls++; throw new Error("fake-token"); } }), /投递结果未知/);
  assert.equal(calls, 1);
});
