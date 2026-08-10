export function withoutPanelLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !name.startsWith("CODEX_PANEL_")
    && !name.startsWith("CODEX_TASKBOARD_")
  )));
}
