async function nativePetSelection(load, action, lumiPetIds = [], targetPetId) {
  if (!['pet-selection', 'use-lumi', 'cancel-lumi', 'use-pet', 'cancel-pet'].includes(action)) throw Error('不支持的宠物操作');
  const runtime = globalThis.__codexPanelRspack__;
  if (!load || runtime?.require !== load) throw Error('请先通过 Panel 连接 Codex');
  if (['use-pet', 'cancel-pet'].includes(action)
    && !globalThis.__codexPanelPetAnimations__?.getSnapshot().some(pack => pack.petId === targetPetId)) {
    throw Error('该宠物尚未导入，请刷新宠物列表');
  }
  const selectedPetId = action === 'use-lumi' ? 'panel-lumi' : targetPetId;
  if (action === 'use-lumi' || action === 'use-pet') {
    const catalog = runtime.prepared.pets && runtime.nativeServices?.petCatalog;
    const pets = catalog && (await runtime.loadModule(catalog.id))[catalog.exportName];
    const available = Array.isArray(pets) && pets.some(pet => pet?.id === selectedPetId);
    if (!available) throw Error(action === 'use-lumi' ? '当前 Codex 尚未载入内置 Lumi，请重启 Codex' : '该资源用于已有宠物，请在 Codex 原生选择器中选择');
  }
  const reference = runtime.nativeServices?.desktopServices;
  if (!reference) throw Error('当前 Codex 未提供可识别的原生宠物设置');
  const nativeModule = await runtime.loadModule(reference.id);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const settings = nativeModule[reference.exportName]?.settings;
    if (settings) {
      let current = await settings.read('selected-avatar-id');
      if (action === 'use-lumi' || action === 'use-pet'
        || action === 'cancel-lumi' && (current.effective === 'panel-lumi' || lumiPetIds.includes(current.effective))
        || action === 'cancel-pet' && current.effective === targetPetId) {
        await settings.write('selected-avatar-id', action === 'use-lumi' || action === 'use-pet' ? selectedPetId : null);
        current = await settings.read('selected-avatar-id');
      }
      if (current.effective !== null && typeof current.effective !== 'string') throw Error('Codex 未返回有效的宠物选择');
      return { petId: current.effective };
    }
    if (Date.now() >= deadline) throw Error('Codex 原生宠物设置尚未就绪');
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
}
