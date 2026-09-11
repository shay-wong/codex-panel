import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getTaskboardI18n, resolveTaskboardLanguage, TaskboardLanguageProvider } from "./i18n";
import "./styles.css";

async function main() {
  const query = new URLSearchParams(window.location.search);
  if (query.get("view") === "workflow-settings") {
    const [{ WorkflowSettingsDialog }, { setApiText }] = await Promise.all([
      import("./components/WorkflowSettingsDialog"),
      import("./api"),
    ]);
    const language = resolveTaskboardLanguage(query.get("language") ?? navigator.language);
    document.documentElement.classList.add("workflow-settings-page");
    document.documentElement.lang = getTaskboardI18n(language).locale;
    setApiText(getTaskboardI18n(language).text);
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <TaskboardLanguageProvider language={language}>
          <WorkflowSettingsDialog projectId="local" onClose={() => {
            if (window.parent !== window) window.parent.postMessage({ type: "panel:workflow-settings-close" }, "*");
          }} />
        </TaskboardLanguageProvider>
      </StrictMode>,
    );
    return;
  }

  const [{ App }, { initializePanelStorage }, { migrateLegacyPanelStorage }] = await Promise.all([
    import("./App"),
    import("./storage"),
    import("./storageMigration"),
  ]);
  try {
    migrateLegacyPanelStorage(window.localStorage);
  } catch {
    // Storage may be unavailable in locked-down embedded contexts.
  }
  await initializePanelStorage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TaskboardLanguageProvider language={resolveTaskboardLanguage(navigator.language)}>
        <App />
      </TaskboardLanguageProvider>
    </StrictMode>,
  );
}

void main();
