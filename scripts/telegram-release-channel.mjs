import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { releaseMetadata } from "./release-metadata.mjs";

const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function channelMessage(release, tag) {
  const metadata = releaseMetadata(tag.replace(/^v/, ""), tag, ["arm64", "x86_64"]);
  if (release.isDraft || release.tagName !== tag) throw new Error("Release 尚未发布或标签不匹配");
  const releaseUrl = `https://github.com/shay-wong/codex-panel/releases/tag/${tag}`;
  if (release.url !== releaseUrl) throw new Error("Release 地址不匹配");
  const dmgName = metadata.assetNames[0];
  const dmgUrl = `https://github.com/shay-wong/codex-panel/releases/download/${tag}/${dmgName}`;
  const dmg = release.assets.find((asset) => asset.name === dmgName);
  if (!dmg || dmg.size <= 0 || dmg.state !== "uploaded" || dmg.url !== dmgUrl) {
    throw new Error("macOS 安装包缺失或上传未完成");
  }
  const header = `Codex Panel 新版本发布\n\n版本：${metadata.version}\n平台：macOS 通用版（Apple Silicon / Intel）\n\n本频道提供下载链接，未直接传包。\n`;
  const footer = `\n安装：打开 DMG，将 App 拖入 Applications。\n临时签名，未经 Apple 公证；首次打开可能需在“隐私与安全性”中允许。\n\n<a href="${escapeHtml(dmgUrl)}">下载安装包</a> · <a href="${escapeHtml(releaseUrl)}">完整版本说明</a>\n\n#CodexPanel #Release #${tag.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const summary = (release.body ?? "").split(/^## Changes\s*$/m)[0]
    .split("\n").filter((line) => /^- /.test(line))
    .map((line) => line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, ""))
    .join("\n");
  // 按 UTF-16 预算整条消息，按码点截断摘要，避免切断 emoji。
  const budget = 4096 - header.length - footer.length - "\n更新内容\n".length - 1;
  let excerpt = "";
  for (const character of summary) {
    if (excerpt.length + character.length > budget) break;
    excerpt += character;
  }
  if (excerpt.length < summary.length) excerpt += "…";
  return escapeHtml(header) + (excerpt ? `\n更新内容\n${escapeHtml(excerpt)}` : "") + footer;
}

export async function sendChannelMessage({ token, chatId, text, fetchImpl = fetch }) {
  if (!token || !chatId) throw new Error("缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_PACKAGE_CHAT_ID");
  let response;
  let body;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(30_000),
    });
    body = await response.json();
  } catch {
    // 网络中断可能发生在服务端接收之后，不自动重试以免重复公告。
    throw new Error("TG 频道投递结果未知：网络超时或响应不可读，请核对频道后再重发");
  }
  if (!response.ok || body.ok !== true) throw new Error(`TG 频道发送失败（HTTP ${response.status}）`);
  if (!Number.isInteger(body.result?.message_id)) throw new Error("TG 频道投递未确认：响应缺少消息 ID");
  return body.result.message_id;
}

async function main() {
  let result;
  try {
    const release = JSON.parse(await readFile(process.argv[2], "utf8"));
    const messageId = await sendChannelMessage({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_PACKAGE_CHAT_ID,
      text: channelMessage(release, process.env.RELEASE_TAG ?? ""),
    });
    result = `Release 已发布；TG 频道下载链接已发送，消息 ID：${messageId}（未直接传包）。`;
  } catch (error) {
    result = `Release 已发布；${error.message}`;
    process.exitCode = 1;
  }
  console.log(result);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
