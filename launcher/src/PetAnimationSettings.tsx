import { useEffect, useState } from "react";
import { Box, Button, Flex, Heading, Separator, Text } from "@radix-ui/themes";

type PetAnimation = { petId: string; name: string; states: string[]; hasLookFrames: boolean };

export function PetAnimationSettings({ disabled = false, connected = false }: { disabled?: boolean; connected?: boolean }) {
  const [animations, setAnimations] = useState<PetAnimation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.__TAURI__.core.invoke<PetAnimation[]>("list_pet_animations").then(result => {
      if (!cancelled) setAnimations(result);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, []);

  async function update(command: "import_pet_animation" | "remove_pet_animation" | "use_builtin_lumi", petId?: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await window.__TAURI__.core.invoke<PetAnimation[] | null>(command, petId ? { petId } : undefined);
      if (result !== null) setAnimations(result);
      if (command === "use_builtin_lumi") setMessage("已切换到 Lumi");
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return <section className="preference-section" aria-labelledby="petAnimationsTitle">
    <Heading as="h2" size="2" id="petAnimationsTitle" mb="2">宠物动画</Heading>
    <div className="preference-rows">
      <Flex className="preference-row" align="center" justify="between" gap="4">
        <Flex align="center" gap="3">
          <Box role="img" aria-label="Lumi" style={{ width: 72, height: 78, flexShrink: 0, backgroundImage: `url(${new URL("../../inject/pets/lumi/spritesheet.webp", import.meta.url).href})`, backgroundSize: "800% 1100%", backgroundRepeat: "no-repeat" }} />
          <Box><Text as="div" size="2" weight="medium">Lumi</Text><Text as="p" size="1" color="gray" mt="1">内置宠物 · 9 个动作 · 16 个视线方向</Text><Text as="p" size="1" color="gray" mt="1">{connected ? "悬停播放比心舞蹈，主窗口与浮窗共用。" : "连接 Codex 后即可使用，无需导入。"}</Text></Box>
        </Flex>
        <Button variant="soft" disabled={disabled || busy || !connected} onClick={() => void update("use_builtin_lumi")}>使用 Lumi</Button>
      </Flex>
      {message && <Text as="p" size="1" color="gray" role="status">{message}</Text>}
      <Separator size="4" />
      <Flex className="preference-row" align="center" justify="between" gap="4">
        <Box><Text as="div" size="2" weight="medium">自定义动画资源</Text><Text as="p" size="1" color="gray" mt="1">选择动画清单 JSON，图集与清单放在同一文件夹；导入后自动生效。</Text></Box>
        <Button variant="soft" disabled={disabled || busy} onClick={() => void update("import_pet_animation")}>{busy ? "正在处理…" : "导入动画资源"}</Button>
      </Flex>
      {animations?.map(animation => <Box key={animation.petId}>
        <Separator size="4" />
        <Flex className="preference-row" align="center" justify="between" gap="4">
          <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <Text as="div" size="2" weight="medium">{animation.name}</Text>
            <Text as="p" size="1" color="gray" mt="1">{animation.states.length} 个动作{animation.hasLookFrames ? " · 16 个视线方向" : ""}</Text>
            <Text as="p" size="1" color="gray" mt="1">{animation.petId}</Text>
          </Box>
          <Button variant="soft" color="gray" disabled={disabled || busy} aria-label={`移除 ${animation.name} 的动画`} onClick={() => void update("remove_pet_animation", animation.petId)}>移除</Button>
        </Flex>
      </Box>)}
      {animations?.length === 0 && <Text as="p" size="1" color="gray">尚未导入自定义动画；内置 Lumi 可直接使用。</Text>}
      {error && <Text as="p" size="1" color="red" role="alert">{error}</Text>}
    </div>
  </section>;
}
