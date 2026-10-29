import { useEffect, useState, type FormEvent } from "react";
import { Box, Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";

type ModelContextSettings = {
  models: Array<{ slug: string; displayName: string; contextWindow: number | null }>;
  contextWindows: Record<string, number>;
};

export function ModelContextSettings({ open, onOpenChange, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
}) {
  const [settings, setSettings] = useState<ModelContextSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
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
      setValues(Object.fromEntries(Object.entries(result.contextWindows).map(([slug, size]) => [slug, String(size)])));
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
      await window.__TAURI__.core.invoke("set_model_context_windows", { contextWindows });
      onSaved();
      onOpenChange(false);
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  }

  return <Dialog.Root open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <Dialog.Content maxWidth="560px">
      <Dialog.Title>模型上下文大小</Dialog.Title>
      <Dialog.Description size="2" color="gray">
        按模型设置 context token 数，留空使用目录默认值。保存后需重启 Codex；请使用模型服务支持的大小。
      </Dialog.Description>
      <form onSubmit={save}>
        <Box mt="4" style={{ maxHeight: "55vh", overflowY: "auto" }}>
          {!settings && !error && <Text as="p" size="2" role="status">正在读取模型目录…</Text>}
          {settings?.models.map(model => <Flex key={model.slug} align="center" justify="between" gap="4" py="2">
            <Box style={{ minWidth: 0 }}>
              <Text as="label" htmlFor={`context-${model.slug}`} size="2" weight="medium">{model.displayName}</Text>
              <Text as="p" size="1" color="gray" style={{ overflowWrap: "anywhere" }}>{model.slug}</Text>
            </Box>
            <TextField.Root
              id={`context-${model.slug}`} type="number" min="1" step="1"
              aria-label={`${model.displayName} context tokens`}
              value={values[model.slug] ?? ""}
              placeholder={model.contextWindow === null ? "默认" : String(model.contextWindow)}
              disabled={saving}
              onChange={event => setValues(current => ({ ...current, [model.slug]: event.target.value }))}
              style={{ width: 160, flexShrink: 0 }}
            />
          </Flex>)}
        </Box>
        {error && <Text as="p" size="2" color="red" role="alert" mt="3">{error}</Text>}
        <Flex justify="between" gap="3" mt="4">
          <Button type="button" variant="ghost" disabled={!settings || saving} onClick={() => setValues({})}>全部使用默认值</Button>
          <Flex gap="3">
            <Dialog.Close><Button type="button" variant="soft" disabled={saving}>取消</Button></Dialog.Close>
            <Button type="submit" disabled={!settings || saving} loading={saving}>保存</Button>
          </Flex>
        </Flex>
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}
