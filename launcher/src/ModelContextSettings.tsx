import { useEffect, useState, type FormEvent } from "react";
import { Badge, Box, Button, Dialog, Flex, Select, Text, TextField } from "@radix-ui/themes";

type ModelContextSettings = {
  models: Array<{ slug: string; displayName: string; contextWindow: number | null; autoCompactTokenLimit: number | null; multiAgentReasoningEffort: string | null; reasoningEfforts: string[] }>;
  contextWindows: Record<string, number>;
  autoCompactTokenLimits: Record<string, number | string>;
  multiAgentReasoningEfforts: Record<string, string>;
  globalContextWindow: number | null;
  globalAutoCompactTokenLimit: number | null;
};

function contextWindowFor(model: ModelContextSettings["models"][number], contextValue: string | undefined) {
  const entered = Number(contextValue);
  return Number.isSafeInteger(entered) && entered > 0 ? entered : model.contextWindow;
}

function autoCompactPlaceholder(model: ModelContextSettings["models"][number], contextValue: string | undefined, percentage = false) {
  const contextWindow = contextWindowFor(model, contextValue);
  // 与 Codex 核心一致：目录未指定阈值时取窗口的 90%，显式默认值也受此上限约束。
  const ceiling = contextWindow === null ? Infinity : Math.floor(contextWindow * 9 / 10);
  const limit = Math.min(model.autoCompactTokenLimit ?? Infinity, ceiling);
  if (percentage) return contextWindow ? String(Math.round(limit / contextWindow * 10000) / 100) : "未提供";
  return Number.isFinite(limit) ? String(limit) : "未提供";
}

function percentageHint(model: ModelContextSettings["models"][number], contextValue: string | undefined, compactValue = "") {
  if (!compactValue.trim()) return null;
  const percent = Number(compactValue);
  if (!(percent > 0 && percent <= 90)) return "百分比需大于 0 且不超过 90%";
  const context = contextWindowFor(model, contextValue);
  return context === null ? "请先填写上下文大小" : `对应 ${Math.floor(context * percent / 100).toLocaleString("en-US")} tokens（上下文 ${context.toLocaleString("en-US")}）`;
}

export function ModelContextSettings({ open, onOpenChange, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
}) {
  const [settings, setSettings] = useState<ModelContextSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [compactValues, setCompactValues] = useState<Record<string, string>>({});
  const [percentageModes, setPercentageModes] = useState<Record<string, boolean>>({});
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettings(null);
    setError("");
    window.__TAURI__.core.invoke<ModelContextSettings>("read_model_context_settings").then(result => {
      if (cancelled) return;
      setSettings(result);
      setCompactValues(Object.fromEntries(Object.entries(result.autoCompactTokenLimits).map(([slug, size]) => [slug, String(size).replace(/%$/, "")])));
      setPercentageModes(Object.fromEntries(Object.entries(result.autoCompactTokenLimits).map(([slug, size]) => [slug, typeof size === "string"])));
      setValues(Object.fromEntries(Object.entries(result.contextWindows).map(([slug, size]) => [slug, String(size)])));
      setReasoningEfforts(result.multiAgentReasoningEfforts);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const contextWindows = Object.fromEntries(Object.entries(values)
        .filter(([, value]) => value.trim())
        .map(([slug, value]) => [slug, Number(value)]));
      const autoCompactTokenLimits = Object.fromEntries(Object.entries(compactValues)
        .filter(([, value]) => value.trim())
        .map(([slug, value]) => [slug, percentageModes[slug] ? `${Number(value)}%` : Number(value)]));
      await window.__TAURI__.core.invoke("set_model_context_windows", {
        contextWindows, autoCompactTokenLimits, multiAgentReasoningEfforts: reasoningEfforts,
      });
      onSaved();
      onOpenChange(false);
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  }

  function toggleCompactMode(model: ModelContextSettings["models"][number]) {
    const percentage = !percentageModes[model.slug];
    const value = compactValues[model.slug];
    if (value?.trim()) {
      const context = contextWindowFor(model, values[model.slug]);
      if (!context) { setError("请先填写上下文大小，再切换自动压缩阈值的单位"); return; }
      const converted = percentage ? Math.round(Number(value) / context * 10000) / 100
        : Math.floor(context * Number(value) / 100);
      setCompactValues(current => ({ ...current, [model.slug]: String(converted) }));
    }
    setPercentageModes(current => ({ ...current, [model.slug]: percentage }));
    setError("");
  }

  return <Dialog.Root open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <Dialog.Content className="model-context-dialog" maxWidth="720px" size="2" style={{ display: "flex", flexDirection: "column", height: "min(680px, calc(100dvh - 24px))", overflow: "hidden" }}>
      <Dialog.Title mb="1">模型上下文与子代理推理</Dialog.Title>
      <Dialog.Description size="1" color="gray">
        留空或选默认恢复。Sol 原生旧目录默认修正为 500000，保存后重启 Codex 生效。
      </Dialog.Description>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        {settings && <Box mt="2" style={{ flexShrink: 0 }}>
          <Flex gap="3" aria-label="当前配置来源">
            {[
              { label: "上下文大小", value: settings.globalContextWindow },
              { label: "自动压缩阈值", value: settings.globalAutoCompactTokenLimit },
            ].map(({ label, value }) => <Box key={label} px="3" py="2" style={{ flex: 1, minWidth: 0, border: "1px solid var(--gray-6)", borderRadius: "var(--radius-3)", background: "var(--gray-2)" }}>
              <Flex align="center" justify="between" gap="2">
                <Text size="1" color="gray">{label}</Text>
                <Badge color={value != null ? "amber" : "gray"} variant="soft">{value != null ? "全局" : "按模型"}</Badge>
              </Flex>
              <Flex align="baseline" gap="1" mt="1">
                <Text size="3" weight="medium" style={{ fontVariantNumeric: "tabular-nums" }}>{value != null ? value.toLocaleString("en-US") : "独立配置"}</Text>
                {value != null && <Text size="1" color="gray">tokens</Text>}
              </Flex>
            </Box>)}
          </Flex>
          <Text as="p" size="1" color="gray" mt="1">全局配置优先生效；下方设置可保存，不修改全局值。</Text>
          <Box my="2" pl="2" style={{ borderLeft: "2px solid var(--gray-6)" }}>
            <Text as="p" size="1" color="gray">实际阈值 = min(设置值, 上下文 × 90%)</Text>
          </Box>
        </Box>}
        <Box pr="1" style={{ minHeight: 0, flex: 1, overflowY: "auto", scrollbarWidth: "none", overscrollBehavior: "contain" }}>
          {!settings && !error && <Text as="p" size="2" role="status" mt="4">正在读取模型目录…</Text>}
          {settings && <Box style={{ minWidth: 568 }}>
            <Box mb="2" style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) 128px 128px 136px", gap: 12 }}>
              <Text size="1" color="gray">模型</Text>
              <Text size="1" color="gray">上下文大小</Text>
              <Text size="1" color="gray">自动压缩阈值</Text>
              <Text size="1" color="gray" title="multi_agent_reasoning_effort">子代理推理强度</Text>
            </Box>
            {settings.models.map(model => <Box key={model.slug} py="1">
              <Box style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) 128px 128px 136px", gap: 12, alignItems: "center" }}>
                <Box tabIndex={0} title={`${model.displayName} (${model.slug})`}
                  style={{ minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "thin" }}>
                  <Text size="2" weight="medium">{model.displayName}</Text>
                  {model.displayName.toLowerCase().replaceAll(" ", "-") !== model.slug.toLowerCase()
                    && <Text size="1" color="gray"> ({model.slug})</Text>}
                </Box>
                <TextField.Root
                  id={`context-${model.slug}`} type="number" min="1" step="1"
                  aria-label={`${model.displayName} context tokens`}
                  value={values[model.slug] ?? ""}
                  placeholder={model.contextWindow === null ? "默认" : String(model.contextWindow)}
                  disabled={saving}
                  onChange={event => setValues(current => ({ ...current, [model.slug]: event.target.value }))}
                >
                  <TextField.Slot side="right" px="2">
                    <Text size="1" color="gray" style={{ pointerEvents: "none" }}>tokens</Text>
                  </TextField.Slot>
                </TextField.Root>
                <TextField.Root
                  id={`compact-${model.slug}`} type="number"
                  min={percentageModes[model.slug] ? "0" : "1"}
                  max={percentageModes[model.slug] ? "90" : undefined}
                  step={percentageModes[model.slug] ? "any" : "1"}
                  aria-label={`${model.displayName} auto compact tokens`}
                  aria-describedby={`compact-hint-${model.slug}`}
                  value={compactValues[model.slug] ?? ""}
                  placeholder={autoCompactPlaceholder(model, values[model.slug], percentageModes[model.slug])}
                  disabled={saving}
                  onChange={event => setCompactValues(current => ({ ...current, [model.slug]: event.target.value }))}
                >
                  <TextField.Slot side="right" px="1">
                    <Button type="button" variant="ghost" size="1" disabled={saving} style={{ margin: 0 }}
                      aria-label={`${model.displayName} 切换为${percentageModes[model.slug] ? "token 数" : "百分比"}`}
                      title="点击切换 tokens / %；模型未提供默认阈值时使用上下文的 90%"
                      onClick={() => toggleCompactMode(model)}>
                      {percentageModes[model.slug] ? "%" : "tokens"}
                    </Button>
                  </TextField.Slot>
                </TextField.Root>
                <Select.Root value={reasoningEfforts[model.slug] ?? "default"} disabled={saving || model.reasoningEfforts.length === 0}
                  onValueChange={value => setReasoningEfforts(current => {
                    const next = { ...current };
                    if (value === "default") delete next[model.slug];
                    else next[model.slug] = value;
                    return next;
                  })}>
                  <Select.Trigger id={`reasoning-${model.slug}`} aria-label={`${model.displayName} 子代理推理强度`} style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="default">{model.multiAgentReasoningEffort ? `默认（${model.multiAgentReasoningEffort}）` : "默认（未指定）"}</Select.Item>
                    {model.reasoningEfforts.map(effort => <Select.Item key={effort} value={effort}>{effort}</Select.Item>)}
                  </Select.Content>
                </Select.Root>
              </Box>
              {percentageModes[model.slug] && <Text as="p" id={`compact-hint-${model.slug}`} size="1" color="gray" mt="1" align="right">
                {percentageHint(model, values[model.slug], compactValues[model.slug])}
              </Text>}
            </Box>)}
          </Box>}
        </Box>
        {error && <Text as="p" size="2" color="red" role="alert" mt="3">{error}</Text>}
        <Flex justify="between" gap="3" mt="2" style={{ flexShrink: 0 }}>
          <Button type="button" variant="ghost" disabled={!settings || saving} onClick={() => { setValues({}); setCompactValues({}); setPercentageModes({}); setReasoningEfforts({}); }}>全部使用默认值</Button>
          <Flex gap="3">
            <Dialog.Close><Button type="button" variant="soft" disabled={saving}>取消</Button></Dialog.Close>
            <Button type="submit" disabled={!settings || saving} loading={saving}>保存</Button>
          </Flex>
        </Flex>
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}
