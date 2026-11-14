import { useEffect, useState } from "react";
import { Box, Button, Flex, Heading, Separator, Text } from "@radix-ui/themes";

type PetAnimation = { petId: string; name: string; states: string[]; hasLookFrames: boolean };

export function PetAnimationSettings({ disabled = false }: { disabled?: boolean }) {
  const [animations, setAnimations] = useState<PetAnimation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.__TAURI__.core.invoke<PetAnimation[]>("list_pet_animations").then(result => {
      if (!cancelled) setAnimations(result);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, []);

  async function update(command: "import_pet_animation" | "remove_pet_animation", petId?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await window.__TAURI__.core.invoke<PetAnimation[] | null>(command, petId ? { petId } : undefined);
      if (result !== null) setAnimations(result);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return <section className="preference-section" aria-labelledby="petAnimationsTitle">
    <Heading as="h2" size="2" id="petAnimationsTitle" mb="2">宠物动画</Heading>
    <div className="preference-rows">
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
      {animations?.length === 0 && <Text as="p" size="1" color="gray">尚未导入动画，当前使用宠物自带动作。</Text>}
      {error && <Text as="p" size="1" color="red" role="alert">{error}</Text>}
    </div>
  </section>;
}
