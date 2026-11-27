import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, Flex, Heading, Switch, Tabs, Text, TextField } from "@radix-ui/themes";

type PetPreview = { spritesheetUrl: string; columns: number; rows: number; frame: number; aspectRatio: number };
type PetAnimation = { petId: string; name: string; states: string[]; hasLookFrames: boolean; preview: PetPreview; builtinLumi: boolean; selectable: boolean };
type PetSelection = { petId: string | null };
type CommunityPet = { id: string; name: string; description?: string; thumbnailUrl?: string; preview?: PetPreview };
type CommunityPetPage = { pets: CommunityPet[]; total: number; totalPages: number };
type CommunityPetRequest = { source: string; query: string; page: number };
const communitySources = [
  { id: "petdex", name: "Petdex" },
  { id: "gallery", name: "Codex Pets Gallery" },
];
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

function CommunityPets({ animations, disabled, onInstall }: {
  animations: PetAnimation[] | null;
  disabled: boolean;
  onInstall: (source: string, petId: string) => Promise<void>;
}) {
  const [request, setRequest] = useState<CommunityPetRequest>({ source: communitySources[0].id, query: "", page: 1 });
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CommunityPetPage | { error: string } | null>(null);
  const [installing, setInstalling] = useState("");
  const [installError, setInstallError] = useState("");
  const [installedName, setInstalledName] = useState("");

  useEffect(() => {
    // 切换平台或翻页后，较晚返回的旧目录不能覆盖当前页。
    let cancelled = false;
    window.__TAURI__.core.invoke<CommunityPetPage>("list_community_pets", request).then(result => {
      if (!cancelled) setCatalog(result);
    }).catch(cause => {
      if (!cancelled) setCatalog({ error: String(cause) });
    });
    return () => { cancelled = true; };
  }, [request]);

  function loadPage(next: CommunityPetRequest) {
    setCatalog(null);
    setRequest({ ...next });
  }

  async function installPet(pet: CommunityPet, installedId: string) {
    setInstalling(installedId);
    setInstallError("");
    setInstalledName("");
    try {
      await onInstall(request.source, pet.id);
      setInstalledName(pet.name);
    } catch (cause) {
      setInstallError(`安装 ${pet.name} 失败。${String(cause)}`);
    } finally {
      setInstalling("");
    }
  }

  const page = catalog && "pets" in catalog ? catalog : null;
  return <section aria-label="在线宠物目录">
    <Flex asChild align="end" gap="3" wrap="wrap" mb="4">
      <search role="search" aria-label="筛选在线宠物">
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor="petCatalogSource" size="1">下载平台</Text>
        <select id="petCatalogSource" className="pet-catalog-source" value={request.source}
          onChange={event => loadPage({ ...request, source: event.target.value, page: 1 })}>
          {communitySources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        </Flex>
        <Flex className="pet-catalog-search" asChild align="end" gap="2">
          <form onSubmit={event => {
            event.preventDefault();
            loadPage({ ...request, query: query.trim(), page: 1 });
          }}>
            <Flex className="pet-catalog-search-field" direction="column" gap="1">
              <Text as="label" htmlFor="petCatalogSearch" size="1">搜索宠物</Text>
              <TextField.Root id="petCatalogSearch" name="q" size="2" type="search" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
            </Flex>
            <Button type="submit" variant="soft">搜索</Button>
          </form>
        </Flex>
      </search>
    </Flex>
    <div role="status">
      {installedName && <Text as="p" size="2" color="green" mb="3">已安装 {installedName}，可在「我的宠物」中使用。</Text>}
    </div>
    {installError && <Text as="p" size="2" color="red" role="alert" mb="3">{installError}</Text>}
    {catalog === null && <Text as="p" size="2" color="gray" role="progressbar" aria-label="正在读取宠物目录">正在读取宠物目录…</Text>}
    {catalog && "error" in catalog && <Flex align="center" gap="3" wrap="wrap">
      <Text as="p" size="2" color="red" role="alert">读取宠物目录失败。{catalog.error}</Text>
      <Button variant="soft" onClick={() => loadPage(request)}>重试</Button>
    </Flex>}
    {page && <>
      <Flex align="center" justify="between" gap="2" wrap="wrap" mb="3">
        <Text as="p" size="2" color="gray">{page.total ? `共 ${page.total} 只宠物` : request.query ? "没有找到匹配的宠物" : "当前平台暂无宠物"}</Text>
        {page.totalPages > 1 && <Flex asChild align="center" gap="2">
          <nav aria-label="宠物目录分页">
            <Button size="1" variant="soft" disabled={request.page === 1} onClick={() => loadPage({ ...request, page: request.page - 1 })}>上一页</Button>
            <Text size="1" color="gray">第 {request.page} / {page.totalPages} 页</Text>
            <Button size="1" variant="soft" disabled={request.page >= page.totalPages} onClick={() => loadPage({ ...request, page: request.page + 1 })}>下一页</Button>
          </nav>
        </Flex>}
      </Flex>
      <div className="pet-card-grid pet-catalog-grid">
        {page.pets.map(pet => {
          const installedId = `community-${request.source}-${pet.id}`;
          const installed = animations?.some(animation => animation.petId === installedId);
          return <Card className="pet-card" asChild key={pet.id}>
            <article>
              {pet.thumbnailUrl ? <div className="pet-preview-stage">
                <img className="pet-catalog-thumbnail" src={pet.thumbnailUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              </div> : pet.preview ? <Preview name={pet.name} preview={pet.preview} /> : <div className="pet-preview-stage">
                <Text size="1" color="gray">暂无预览</Text>
              </div>}
              <Heading as="h3" size="3">{pet.name}</Heading>
              {pet.description && <Text className="pet-catalog-description" as="p" size="1" color="gray">{pet.description}</Text>}
              <Button className="pet-card-action" variant="soft" disabled={disabled || !!installing || installed}
                aria-label={installed ? `已安装 ${pet.name}` : installing === installedId ? `正在安装 ${pet.name}` : `一键安装 ${pet.name}`}
                onClick={() => void installPet(pet, installedId)}>
                {installed ? "已安装" : installing === installedId ? "正在安装…" : "一键安装"}
              </Button>
            </article>
          </Card>;
        })}
      </div>
    </>}
  </section>;
}

export function PetAnimationSettings({ disabled = false, connected = false, refreshKey = 0, soundsEnabled = true, onSoundsChange }: { disabled?: boolean; connected?: boolean; refreshKey?: number; soundsEnabled?: boolean; onSoundsChange?: (enabled: boolean) => void }) {
  const [animations, setAnimations] = useState<PetAnimation[] | null>(null);
  const [selection, setSelection] = useState<PetSelection | null>(null);
  const [selectionRefresh, setSelectionRefresh] = useState(0);
  const [readingSelection, setReadingSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.__TAURI__.core.invoke<PetAnimation[]>("list_pet_animations").then(result => {
      if (!cancelled) setAnimations(current => current ?? result);
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
      if (command === "remove_pet_animation" && petId !== "panel-lumi" && animations?.some(animation => animation.petId === petId && animation.selectable)) {
        if (!connected || !selection) throw new Error("连接 Codex 并读取使用状态后，才能移除宠物。");
        if (selection.petId === petId) setSelection(await window.__TAURI__.core.invoke<PetSelection>("cancel_imported_pet", { petId }));
      }
      const result = await window.__TAURI__.core.invoke<PetAnimation[] | null>(command, petId ? { petId } : undefined);
      if (result !== null) setAnimations(result);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function selectPet(command: "use_builtin_lumi" | "cancel_builtin_lumi" | "use_imported_pet" | "cancel_imported_pet", petId?: string) {
    setBusy(true);
    setError("");
    try { setSelection(await (petId
      ? window.__TAURI__.core.invoke<PetSelection>(command, { petId })
      : window.__TAURI__.core.invoke<PetSelection>(command))); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function installCommunityPet(source: string, petId: string) {
    setBusy(true);
    try {
      setAnimations(await window.__TAURI__.core.invoke<PetAnimation[]>("install_community_pet", { source, petId }));
    } finally {
      setBusy(false);
    }
  }

  const canonicalOverride = animations?.find(animation => animation.petId === "panel-lumi");
  const usingLumi = selection?.petId === "panel-lumi" || animations?.some(animation => animation.builtinLumi && animation.petId === selection?.petId);
  const otherAnimations = animations?.filter(animation => !animation.builtinLumi && animation.petId !== "panel-lumi");
  return <Tabs.Root asChild defaultValue="local" activationMode="manual">
    <section aria-label="宠物资源">
      <Tabs.List className="preference-navigation" aria-label="宠物资源来源">
        <Tabs.Trigger value="local">我的宠物</Tabs.Trigger>
        <Tabs.Trigger value="online">在线宠物</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="local">
        <Flex className="pet-page-toolbar" justify="between" align="center" gap="4" mb="4">
          <Text as="p" size="2" color="gray">内置宠物可直接使用，也可导入新的宠物包。</Text>
          <Button variant="soft" disabled={disabled || busy} onClick={() => void updateAnimations("import_pet_animation")}>导入宠物包</Button>
        </Flex>
        <Flex align="center" gap="3" mb="4">
          <Text as="div" size="2">播放宠物声音</Text>
          <Switch id="petSounds" aria-label="播放宠物声音" checked={soundsEnabled} disabled={disabled || !onSoundsChange} onCheckedChange={onSoundsChange} highContrast size="1" />
        </Flex>
        {!connected && <Text as="p" size="1" color="gray" mb="4">连接 Codex 后可查看使用状态并选择宠物。</Text>}
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
              <Text as="p" size="1" color="gray" mt="2">{canonicalOverride ? "已应用导入动画，可恢复内置资源。" : "悬停播放比心舞蹈与配乐，主窗口与浮窗共用。"}</Text>
              {connected && !selection && <Text as="p" size="1" color="gray" mt="2">{readingSelection ? "正在读取使用状态…" : "使用状态未知"}</Text>}
            </Box>
            <Flex className="pet-card-action" gap="2" wrap="wrap">
              <Button variant="soft" disabled={disabled || busy || !connected || !selection || !animations} onClick={() => void selectPet(usingLumi ? "cancel_builtin_lumi" : "use_builtin_lumi")}>{usingLumi ? "取消使用" : "使用 Lumi"}</Button>
              {canonicalOverride && <Button variant="soft" color="gray" disabled={disabled || busy} onClick={() => void updateAnimations("remove_pet_animation", "panel-lumi")}>恢复内置动画</Button>}
            </Flex>
          </Card>
          {otherAnimations?.map(animation => <Card className="pet-card" key={animation.petId} aria-label={`${animation.selectable ? "导入宠物" : "导入动画"} ${animation.name}`}>
            <Preview name={animation.name} preview={animation.preview} />
            <Flex justify="between" align="center" gap="2" wrap="wrap">
              <Heading as="h3" size="3">{animation.name}</Heading>
              <Badge color={selection?.petId === animation.petId ? "green" : "gray"}>{selection?.petId === animation.petId ? "正在使用" : "已导入"}</Badge>
            </Flex>
            <Box className="pet-card-copy">
              <Text as="p" size="1" color="gray">{animation.selectable ? "导入宠物" : "导入动画"} · {animation.states.length} 个动作{animation.hasLookFrames ? " · 16 个视线方向" : ""}</Text>
              {!animation.selectable && <Text as="p" size="1" color="gray" mt="2">在 Codex 宠物选择器中选择对应宠物即可使用。</Text>}
            </Box>
            <Flex className="pet-card-action" gap="2" wrap="wrap">
              {animation.selectable && <Button variant="soft" disabled={disabled || busy || !connected || !selection} onClick={() => void selectPet(selection?.petId === animation.petId ? "cancel_imported_pet" : "use_imported_pet", animation.petId)}>{selection?.petId === animation.petId ? "取消使用" : `使用 ${animation.name}`}</Button>}
              <Button variant="soft" color="gray" disabled={disabled || busy} aria-label={animation.selectable ? `移除宠物 ${animation.name}` : `移除 ${animation.name} 的动画`} onClick={() => void updateAnimations("remove_pet_animation", animation.petId)}>{animation.selectable ? "移除宠物" : "移除动画"}</Button>
            </Flex>
          </Card>)}
        </div>
        {animations?.length === 0 && <Text as="p" size="1" color="gray" mt="4">尚未导入宠物包；内置 Lumi 可直接使用。</Text>}
      </Tabs.Content>
      <Tabs.Content value="online">
        <CommunityPets animations={animations} disabled={disabled || busy} onInstall={installCommunityPet} />
      </Tabs.Content>
    </section>
  </Tabs.Root>;
}
