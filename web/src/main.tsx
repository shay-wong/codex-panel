import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { migrateLegacyPanelStorage } from "./storageMigration";
import "./styles.css";

try {
  migrateLegacyPanelStorage(window.localStorage);
} catch {
  // Storage may be unavailable in locked-down embedded contexts.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
