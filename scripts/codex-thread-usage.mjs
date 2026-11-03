import { open, realpath } from "node:fs/promises";
import path from "node:path";

// 日志只有模型调用结束时的用量，因此计算输出吞吐，不声称是流式解码速度。
export function summarizeThreadUsage(text) {
  let turnId = null;
  let inProgress = false;
  let previous = null;
  let input = 0;
  let cached = 0;
  let tokens = 0;
  let seconds = 0;
  const reset = (id) => {
    turnId = id;
    previous = null;
    input = cached = tokens = seconds = 0;
  };
  for (const line of text.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const event = record?.payload;
    if (!event) continue;
    if (record.type === "event_msg" && ["task_started", "turn_started"].includes(event.type)) {
      reset(event.turn_id ?? null);
      inProgress = true;
      continue;
    }
    if (record.type === "turn_context" && event.turn_id && event.turn_id !== turnId) {
      reset(event.turn_id);
      inProgress = true;
      continue;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(event.type)) {
      if (!event.turn_id || !turnId || event.turn_id === turnId) inProgress = false;
      continue;
    }
    if (record.type !== "event_msg" || event.type !== "token_count") continue;
    const last = event.info?.last_token_usage;
    const total = event.info?.total_token_usage;
    const at = Date.parse(record.timestamp);
    if (!last || !total || !Number.isFinite(at)) continue;
    const output = total.output_tokens;
    if (!Number.isFinite(output) || output < 0) continue;
    // 重复 token_count 不能重复计入缓存分母；累计值回退则不跨段计算。
    if (previous?.output === output && previous.total === total.total_tokens) continue;
    if (!turnId || (previous && output < previous.output)) reset(turnId);
    if (previous) {
      const elapsed = (at - previous.at) / 1000;
      if (output > previous.output && elapsed >= 0.5 && elapsed <= 120) {
        tokens += output - previous.output;
        seconds += elapsed;
      }
    }
    if (Number.isFinite(last.input_tokens) && last.input_tokens > 0
      && Number.isFinite(last.cached_input_tokens) && last.cached_input_tokens >= 0) {
      input += last.input_tokens;
      cached += Math.min(last.cached_input_tokens, last.input_tokens);
    }
    previous = { at, output, total: total.total_tokens };
  }
  return {
    speed: seconds > 0 ? tokens / seconds : null,
    cache: input > 0 ? cached / input * 100 : null,
    observedAt: previous?.at ?? null,
    partial: !turnId,
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
