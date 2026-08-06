import os from "node:os";
import path from "node:path";

export function resolvePanelSupportRoot(options = {}) {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const configuredRoot = environment.CODEX_PANEL_HOME?.trim();

  if (configuredRoot) return path.resolve(configuredRoot);
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Codex Panel");
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim()
      || path.join(homeDirectory, "AppData", "Local");
    return path.join(path.resolve(localAppData), "Codex Panel");
  }

  const dataHome = environment.XDG_DATA_HOME?.trim()
    ? path.resolve(environment.XDG_DATA_HOME)
    : path.join(homeDirectory, ".local", "share");
  return path.join(dataHome, "codex-panel");
}

export function resolvePanelDataDirectory(options = {}) {
  const environment = options.environment ?? process.env;
  const configuredDirectory = environment.CODEX_PANEL_DATA_DIR?.trim()
    || environment.CODEX_TASKBOARD_DATA_DIR?.trim();

  return configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(resolvePanelSupportRoot(options), "data");
}
