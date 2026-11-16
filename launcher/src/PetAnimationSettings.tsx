import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, Flex, Heading, Text } from "@radix-ui/themes";

type PetPreview = { spritesheetUrl: string; columns: number; rows: number; frame: number; aspectRatio: number };
type PetAnimation = { petId: string; name: string; states: string[]; hasLookFrames: boolean; preview: PetPreview; builtinLumi: boolean };
type PetSelection = { petId: string | null };
const lumiPreview: PetPreview = {
  spritesheetUrl: new URL("../../inject/pets/lumi/spritesheet.webp", import.meta.url).href,
  columns: 8, rows: 11, frame: 0, aspectRatio: 192 / 208,
};

function Preview({ name, preview }: { name: string; preview: PetPreview }) {
  const column = preview.frame % preview.columns;
  const row = Math.floor(preview.frame / preview.columns);
  return <div className="pet-preview-stage"><div className="pet-preview" role="img" aria-label={name} style={{
    width: Math.min(132, 160 * preview.aspectRatio), aspectRatio: preview.aspectRatio,
    backgroundImage: `url(${JSON.stringify(preview.spritesheetUrl)})`,
    backgroundSize: `${preview.columns * 100}% ${preview.rows * 100}%`,
    backgroundPosition: `${preview.columns > 1 ? column / (preview.columns - 1) * 100 : 0}% ${preview.rows > 1 ? row / (preview.rows - 1) * 100 : 0}%`,
  }} /></div>;
}

export function PetAnimationSettings({ disabled = false, connected = false, refreshKey = 0 }: { disabled?: boolean; connected?: boolean; refreshKey?: number }) {
  const [animations, setAnimations] = useState<PetAnimation[] | null>(null);
  const [selection, setSelection] = useState<PetSelection | null>(null);
  const [selectionRefresh, setSelectionRefresh] = useState(0);
  const [readingSelection, setReadingSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.__TAURI__.core.invoke<PetAnimation[]>("list_pet_animations").then(result => {
      if (!cancelled) setAnimations(result);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const refresh = () => setSelectionRefresh(current => current + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSelection(null);
    setReadingSelection(connected);
    if (connected) window.__TAURI__.core.invoke<PetSelection>("read_pet_selection").then(result => {
      if (!cancelled) setSelection(result);
    }).catch(cause => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setReadingSelection(false); });
    return () => { cancelled = true; };
  }, [connected, refreshKey, selectionRefresh]);

  async function updateAnimations(command: "import_pet_animation" | "remove_pet_animation", petId?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await window.__TAURI__.core.invoke<PetAnimation[] | null>(command, petId ? { petId } : undefined);
      if (result !== null) setAnimations(result);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function selectLumi(command: "use_builtin_lumi" | "cancel_builtin_lumi") {
    setBusy(true);
    setError("");
    try { setSelection(await window.__TAURI__.core.invoke<PetSelection>(command)); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  const canonicalOverride = animations?.find(animation => animation.petId === "panel-lumi");
  const usingLumi = selection?.petId === "panel-lumi" || animations?.some(animation => animation.builtinLumi && animation.petId === selection?.petId);
  const otherAnimations = animations?.filter(animation => !animation.builtinLumi && animation.petId !== "panel-lumi");
  return <section aria-label="宠物资源">
    <Flex className="pet-page-toolbar" justify="between" align="center" gap="4" mb="4">
      <Text as="p" size="2" color="gray">内置宠物可直接使用；导入资源为已有宠物提供动画。</Text>
      <Button variant="soft" disabled={disabled || busy} onClick={() => void updateAnimations("import_pet_animation")}>导入动画资源</Button>
    </Flex>
    {!connected && <Text as="p" size="1" color="gray" mb="4">连接 Codex 后可查看使用状态并选择 Lumi。</Text>}
    {error && <Text as="p" size="1" color="red" role="alert" mb="4">{error}</Text>}
    <div className="pet-card-grid">
      <Card className="pet-card" aria-label="内置 Lumi">
        <Preview name="Lumi" preview={canonicalOverride?.preview ?? lumiPreview} />
        <Flex justify="between" align="center" gap="2" wrap="wrap">
          <Heading as="h3" size="3">Lumi</Heading>
          {usingLumi && <Badge color="green">正在使用</Badge>}
        </Flex>
        <Box className="pet-card-copy">
          <Text as="p" size="1" color="gray">内置宠物 · {canonicalOverride?.states.length ?? 9} 个动作{(canonicalOverride?.hasLookFrames ?? true) ? " · 16 个视线方向" : ""}</Text>
          <Text as="p" size="1" color="gray" mt="2">{canonicalOverride ? "已应用导入动画，可恢复内置资源。" : "悬停播放比心舞蹈，主窗口与浮窗共用。"}</Text>
          {connected && !selection && <Text as="p" size="1" color="gray" mt="2">{readingSelection ? "正在读取使用状态…" : "使用状态未知"}</Text>}
        </Box>
        <Flex className="pet-card-action" gap="2" wrap="wrap">
          <Button variant="soft" disabled={disabled || busy || !connected || !selection || !animations} onClick={() => void selectLumi(usingLumi ? "cancel_builtin_lumi" : "use_builtin_lumi")}>{usingLumi ? "取消使用" : "使用 Lumi"}</Button>
          {canonicalOverride && <Button variant="soft" color="gray" disabled={disabled || busy} onClick={() => void updateAnimations("remove_pet_animation", "panel-lumi")}>恢复内置动画</Button>}
        </Flex>
      </Card>
      {otherAnimations?.map(animation => <Card className="pet-card" key={animation.petId} aria-label={`导入动画 ${animation.name}`}>
        <Preview name={animation.name} preview={animation.preview} />
        <Flex justify="between" align="center" gap="2" wrap="wrap">
          <Heading as="h3" size="3">{animation.name}</Heading>
          <Badge color={selection?.petId === animation.petId ? "green" : "gray"}>{selection?.petId === animation.petId ? "正在使用" : "已导入"}</Badge>
        </Flex>
        <Box className="pet-card-copy">
          <Text as="p" size="1" color="gray">导入动画 · {animation.states.length} 个动作{animation.hasLookFrames ? " · 16 个视线方向" : ""}</Text>
          <Text as="p" size="1" color="gray" mt="2">{animation.petId}</Text>
        </Box>
        <Button className="pet-card-action" variant="soft" color="gray" disabled={disabled || busy} aria-label={`移除 ${animation.name} 的动画`} onClick={() => void updateAnimations("remove_pet_animation", animation.petId)}>移除动画</Button>
      </Card>)}
    </div>
    {animations?.length === 0 && <Text as="p" size="1" color="gray" mt="4">尚未导入自定义动画；内置 Lumi 可直接使用。</Text>}
  </section>;
}
