import { open, realpath } from "node:fs/promises";
import path from "node:path";

// 用量由原生调用上报；耗时覆盖整轮，包含等待、思考和工具执行。
export function summarizeThreadUsage(text, now = Date.now()) {
  let turnId = null;
  let startedAt = null;
  let endedAt = null;
  let inProgress = false;
  let previous = null;
  let input = 0;
  let cached = 0;
  let tokens = 0;
  let observedAt = null;
  const reset = (id, at) => {
    turnId = id;
    startedAt = Number.isFinite(at) ? at : null;
    endedAt = observedAt = null;
    input = cached = tokens = 0;
  };
  for (const line of text.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const event = record?.payload;
    if (!event) continue;
    const at = Date.parse(record.timestamp);
    if (record.type === "event_msg" && ["task_started", "turn_started"].includes(event.type)) {
      reset(event.turn_id ?? null, at);
      inProgress = true;
      continue;
    }
    if (record.type === "turn_context" && event.turn_id && event.turn_id !== turnId) {
      reset(event.turn_id, at);
      inProgress = true;
      continue;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(event.type)) {
      if (!event.turn_id || !turnId || event.turn_id === turnId) {
        inProgress = false;
        endedAt = Number.isFinite(at) ? at : null;
      }
      continue;
    }
    if (record.type !== "event_msg" || event.type !== "token_count") continue;
    const last = event.info?.last_token_usage;
    const total = event.info?.total_token_usage;
    if (!last || !total || !Number.isFinite(at)) continue;
    if (previous?.output_tokens === total.output_tokens && previous.total_tokens === total.total_tokens) continue;
    // 缺少轮边界时只能显示最近调用的缓存，不能把会话累计输出当成本轮输出。
    if (!turnId) reset(null, null);
    if (Number.isFinite(last.output_tokens) && last.output_tokens >= 0) tokens += last.output_tokens;
    if (Number.isFinite(last.input_tokens) && last.input_tokens > 0
      && Number.isFinite(last.cached_input_tokens) && last.cached_input_tokens >= 0) {
      input += last.input_tokens;
      cached += Math.min(last.cached_input_tokens, last.input_tokens);
    }
    previous = total;
    observedAt = at;
  }
  const elapsed = startedAt == null ? 0 : ((inProgress ? now : endedAt) - startedAt) / 1000;
  return {
    speed: tokens > 0 && elapsed > 0 ? tokens / elapsed : null,
    cache: input > 0 ? cached / input * 100 : null,
    outputTokens: tokens,
    inputTokens: input,
    cachedInputTokens: cached,
    totalTokens: previous?.total_tokens ?? null,
    turnId,
    startedAt,
    endedAt,
    observedAt,
    partial: !turnId || startedAt == null,
    inProgress,
  };
}

export async function readThreadUsage(threadId, readThread) {
  // 路径只能来自原生只读 RPC，前端不能指定文件或 host；不返回日志内容和磁盘路径。
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) {
    throw new Error("无效的会话编号");
  }
  const result = await readThread(threadId);
  if (result?.thread?.id !== threadId || !result.thread.path) return { usage: null };
  const file = await realpath(result.thread.path);
  // 原生延续日志可能在会话 ID 后附加另一个 UUID。
  const filename = new RegExp(`-${threadId}(?:_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?\\.jsonl$`, "i");
  if (!filename.test(path.basename(file))) throw new Error("会话日志路径不匹配");
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("会话日志不是普通文件");
    // 大会话只读取尾部；找不到当前轮边界时扩展窗口，最多读取 8 MiB。
    for (let limit = 512 * 1024; ; limit *= 4) {
      const size = Math.min(stat.size, limit);
      const start = stat.size - size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      // 未写完的尾行等下次轮询，不能解析一半的 JSON。
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      const usage = summarizeThreadUsage(text);
      if (!usage.partial || start === 0 || limit >= 8 * 1024 * 1024) {
        return { usage };
      }
    }
  } finally {
    await handle.close();
  }
}
