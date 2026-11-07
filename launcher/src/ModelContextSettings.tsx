import { useEffect, useState, type FormEvent } from "react";
import { Badge, Box, Button, Dialog, Flex, Select, Tabs, Text, TextField } from "@radix-ui/themes";

type ModelContextSettings = {
  models: Array<{ slug: string; displayName: string; contextWindow: number | null; autoCompactTokenLimit: number | null; multiAgentReasoningEffort: string | null; reasoningEfforts: string[] }>;
  contextWindows: Record<string, number>;
  autoCompactTokenLimits: Record<string, number | string>;
  multiAgentReasoningEfforts: Record<string, string>;
  defaultSubagentModel: string | null;
  defaultSubagentReasoningEffort: string | null;
  agents: Array<{ name: string; filePath: string; model: string | null; reasoningEffort: string | null }>;
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

function reasoningOptionsFor(models: ModelContextSettings["models"], modelSlug: string) {
  const candidates = modelSlug ? models.filter(model => model.slug === modelSlug) : models;
  return [...new Set(candidates.flatMap(model => model.reasoningEfforts))];
}

export function ModelContextSettings({ open, onOpenChange, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
}) {
  const [settings, setSettings] = useState<ModelContextSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [compactValues, setCompactValues] = useState<Record<string, string>>({});
  const [percentageModes, setPercentageModes] = useState<Record<string, boolean>>({});
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, string>>({});
  const [subagentModel, setSubagentModel] = useState("");
  const [subagentReasoningEffort, setSubagentReasoningEffort] = useState("");
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [agentReasoningEfforts, setAgentReasoningEfforts] = useState<Record<string, string>>({});
  const [tab, setTab] = useState("models");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettings(null);
    setError("");
    setTab("models");
    window.__TAURI__.core.invoke<ModelContextSettings>("read_model_context_settings").then(result => {
      if (cancelled) return;
      setSettings({ ...result, agents: result.agents ?? [] });
      setCompactValues(Object.fromEntries(Object.entries(result.autoCompactTokenLimits).map(([slug, size]) => [slug, String(size).replace(/%$/, "")])));
      setPercentageModes(Object.fromEntries(Object.entries(result.autoCompactTokenLimits).map(([slug, size]) => [slug, typeof size === "string"])));
      setValues(Object.fromEntries(Object.entries(result.contextWindows).map(([slug, size]) => [slug, String(size)])));
      setReasoningEfforts(result.multiAgentReasoningEfforts);
      setSubagentModel(result.defaultSubagentModel ?? "");
      setSubagentReasoningEffort(result.defaultSubagentReasoningEffort ?? "");
      setAgentModels(Object.fromEntries((result.agents ?? []).map(agent => [agent.name, agent.model ?? ""])));
      setAgentReasoningEfforts(Object.fromEntries((result.agents ?? []).map(agent => [agent.name, agent.reasoningEffort ?? ""])));
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
        defaultSubagentModel: subagentModel, defaultSubagentReasoningEffort: subagentReasoningEffort,
        agentModels, agentReasoningEfforts,
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

  const defaultReasoningOptions = settings ? reasoningOptionsFor(settings.models, subagentModel) : [];

  return <Dialog.Root open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <Dialog.Content className="model-context-dialog" maxWidth="720px" size="2" style={{ display: "flex", flexDirection: "column", height: "min(680px, calc(100dvh - 24px))", overflow: "hidden" }}>
      <Dialog.Title mb="1">模型上下文与子代理</Dialog.Title>
      <Dialog.Description size="1" color="gray">
        留空或选默认恢复。Sol 原生旧目录默认修正为 500000，保存后重启 Codex 生效。
      </Dialog.Description>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <Tabs.Root value={tab} onValueChange={setTab} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <Tabs.List mt="2" style={{ flexShrink: 0 }}>
            <Tabs.Trigger value="models">模型配置</Tabs.Trigger>
            <Tabs.Trigger value="agents">子代理</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="models" style={{ display: tab === "models" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
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
          </Tabs.Content>
          <Tabs.Content value="agents" style={{ display: tab === "agents" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
            {!settings && !error && <Text as="p" size="2" role="status" mt="4">正在读取子代理配置…</Text>}
            {settings && <>
              <Box mt="3" style={{ flexShrink: 0 }}>
                <Flex align="end" gap="3" mb="2">
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text as="label" htmlFor="defaultSubagentModel" size="2" weight="medium">子代理默认模型</Text>
                    <Box mt="1">
                      <Select.Root value={subagentModel || "__default__"} disabled={saving}
                        onValueChange={value => setSubagentModel(value === "__default__" ? "" : value)}>
                        <Select.Trigger id="defaultSubagentModel" aria-label="子代理默认模型" aria-describedby="subagentDefaultsHint" style={{ width: "100%", minWidth: 0 }} />
                        <Select.Content position="popper">
                          <Select.Item value="__default__">默认（跟随父代理）</Select.Item>
                          {subagentModel && !settings.models.some(model => model.slug === subagentModel)
                            && <Select.Item value={subagentModel}>{subagentModel}</Select.Item>}
                          {settings.models.map(model => <Select.Item key={model.slug} value={model.slug}>{model.displayName}</Select.Item>)}
                        </Select.Content>
                      </Select.Root>
                    </Box>
                  </Box>
                  <Box style={{ width: 176, flexShrink: 0 }}>
                    <Text as="label" htmlFor="defaultSubagentReasoningEffort" size="2" weight="medium">默认推理强度</Text>
                    <Box mt="1">
                      <Select.Root value={subagentReasoningEffort || "__default__"} disabled={saving}
                        onValueChange={value => setSubagentReasoningEffort(value === "__default__" ? "" : value)}>
                        <Select.Trigger id="defaultSubagentReasoningEffort" aria-label="子代理默认推理强度" aria-describedby="subagentDefaultsHint" style={{ width: "100%" }} />
                        <Select.Content position="popper">
                          <Select.Item value="__default__">默认（自动继承）</Select.Item>
                          {subagentReasoningEffort && !defaultReasoningOptions.includes(subagentReasoningEffort)
                            && <Select.Item value={subagentReasoningEffort}>{subagentReasoningEffort}</Select.Item>}
                          {defaultReasoningOptions.map(effort => <Select.Item key={effort} value={effort}>{effort}</Select.Item>)}
                        </Select.Content>
                      </Select.Root>
                    </Box>
                  </Box>
                </Flex>
                <Box id="subagentDefaultsHint" mb="3">
                  <Text as="p" size="1" color="gray">角色的独立设置优先；选择“继承默认”移除该项覆盖。</Text>
                  <Text as="p" size="1" color="gray" mt="1">全局默认模型留空时跟随父代理；指定模型但未指定强度时，使用该模型默认强度。</Text>
                </Box>
              </Box>
              <Box pr="1" style={{ minHeight: 0, flex: 1, overflowY: "auto", scrollbarWidth: "thin", overscrollBehavior: "contain" }}>
                {settings.agents.length === 0
                  ? <Text as="p" size="2" color="gray" mt="3">未找到自定义子代理配置。</Text>
                  : <Box style={{ minWidth: 540 }}>
                    <Box mb="2" style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) minmax(220px, 1.4fr) 156px", gap: 12 }}>
                      <Text size="1" color="gray">子代理</Text>
                      <Text size="1" color="gray">使用模型</Text>
                      <Text size="1" color="gray">推理强度</Text>
                    </Box>
                    {settings.agents.map(agent => {
                      const effortOptions = reasoningOptionsFor(settings.models, agentModels[agent.name] ?? "");
                      const selectedEffort = agentReasoningEfforts[agent.name] ?? "";
                      return <Box key={agent.name} py="2" style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) minmax(220px, 1.4fr) 156px", gap: 12, alignItems: "center" }}>
                        <Box title={agent.filePath} style={{ minWidth: 0 }}>
                          <Text as="p" size="2" weight="medium" style={{ overflowWrap: "anywhere" }}>{agent.name}</Text>
                        </Box>
                        <Select.Root value={agentModels[agent.name] || "__default__"} disabled={saving}
                          onValueChange={value => setAgentModels(current => ({ ...current, [agent.name]: value === "__default__" ? "" : value }))}>
                          <Select.Trigger aria-label={`${agent.name} 使用模型`} style={{ width: "100%", minWidth: 0 }} />
                          <Select.Content position="popper">
                            <Select.Item value="__default__">继承默认</Select.Item>
                            {agentModels[agent.name] && !settings.models.some(model => model.slug === agentModels[agent.name])
                              && <Select.Item value={agentModels[agent.name]}>{agentModels[agent.name]}</Select.Item>}
                            {settings.models.map(model => <Select.Item key={model.slug} value={model.slug}>{model.displayName}</Select.Item>)}
                          </Select.Content>
                        </Select.Root>
                        <Select.Root value={selectedEffort || "__default__"} disabled={saving}
                          onValueChange={value => setAgentReasoningEfforts(current => ({ ...current, [agent.name]: value === "__default__" ? "" : value }))}>
                          <Select.Trigger aria-label={`${agent.name} 推理强度`} style={{ width: "100%" }} />
                          <Select.Content position="popper">
                            <Select.Item value="__default__">继承默认</Select.Item>
                            {selectedEffort && !effortOptions.includes(selectedEffort)
                              && <Select.Item value={selectedEffort}>{selectedEffort}</Select.Item>}
                            {effortOptions.map(effort => <Select.Item key={effort} value={effort}>{effort}</Select.Item>)}
                          </Select.Content>
                        </Select.Root>
                      </Box>;
                    })}
                  </Box>}
              </Box>
            </>}
          </Tabs.Content>
        </Tabs.Root>
        {error && <Text as="p" size="2" color="red" role="alert" mt="3">{error}</Text>}
        <Flex justify="between" gap="3" mt="2" style={{ flexShrink: 0 }}>
          <Button type="button" variant="ghost" disabled={!settings || saving} onClick={() => {
            setValues({}); setCompactValues({}); setPercentageModes({}); setReasoningEfforts({}); setSubagentModel(""); setSubagentReasoningEffort("");
            setAgentModels(Object.fromEntries((settings?.agents ?? []).map(agent => [agent.name, ""])));
            setAgentReasoningEfforts(Object.fromEntries((settings?.agents ?? []).map(agent => [agent.name, ""])));
          }}>全部使用默认值</Button>
          <Flex gap="3">
            <Dialog.Close><Button type="button" variant="soft" disabled={saving}>取消</Button></Dialog.Close>
            <Button type="submit" disabled={!settings || saving} loading={saving}>保存</Button>
          </Flex>
        </Flex>
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}
