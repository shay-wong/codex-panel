const LEGACY_STORAGE_KEYS = [
  ["taskboard.theme", "panel.theme"],
  ["taskboard.lastProjectId", "panel.lastProjectId"],
  ["taskboard.favoriteProjectIds", "panel.favoriteProjectIds"],
  ["taskboard.deviceWorkspacePaths.v1", "panel.deviceWorkspacePaths.v1"],
  ["taskboard.showEmptyColumns.v1", "panel.showEmptyColumns.v1"],
  ["taskboard.columnVisibility.v1", "panel.columnVisibility.v1"],
  ["taskboard.projectAutomations.v1", "panel.projectAutomations.v1"],
  ["taskboard.aiChat.lastThreadId", "panel.aiChat.lastThreadId"],
  ["taskboard.aiChat.panelGeometry", "panel.aiChat.panelGeometry"],
] as const;

const LEGACY_STORAGE_PREFIXES = [
  ["taskboard.comment-draft.", "panel.comment-draft."],
  ["taskboard.workflow.workspace.", "panel.workflow.workspace."],
] as const;

function migrateKey(storage: Storage, legacyKey: string, panelKey: string): void {
  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue === null) return;
  if (storage.getItem(panelKey) === null) storage.setItem(panelKey, legacyValue);
  storage.removeItem(legacyKey);
}

export function migrateLegacyPanelStorage(storage: Storage): void {
  for (const [legacyKey, panelKey] of LEGACY_STORAGE_KEYS) {
    migrateKey(storage, legacyKey, panelKey);
  }

  const prefixedKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null);
  for (const legacyKey of prefixedKeys) {
    const migration = LEGACY_STORAGE_PREFIXES.find(([prefix]) => legacyKey.startsWith(prefix));
    if (!migration) continue;
    const [legacyPrefix, panelPrefix] = migration;
    migrateKey(storage, legacyKey, `${panelPrefix}${legacyKey.slice(legacyPrefix.length)}`);
  }
}
