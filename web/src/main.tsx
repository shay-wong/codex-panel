import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializePanelStorage } from "./storage";
import { migrateLegacyPanelStorage } from "./storageMigration";
import "./styles.css";

async function main() {
  try {
    migrateLegacyPanelStorage(window.localStorage);
  } catch {
    // Storage may be unavailable in locked-down embedded contexts.
  }
  await initializePanelStorage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
