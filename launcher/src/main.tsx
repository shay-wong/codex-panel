import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import App from "./App";
import "./launcher.css";

function Launcher() {
  const [followSystem, setFollowSystem] = useState(() => window.localStorage.getItem("codex-panel.follow-system-appearance") !== "false");
  const [systemAppearance, setSystemAppearance] = useState<"dark" | "light">(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemAppearance(media.matches ? "dark" : "light");
    const preferenceChanged = (event: Event) => setFollowSystem((event as CustomEvent<boolean>).detail);
    media.addEventListener("change", changed);
    window.addEventListener("codex-panel-appearance-preference", preferenceChanged);
    return () => { media.removeEventListener("change", changed); window.removeEventListener("codex-panel-appearance-preference", preferenceChanged); };
  }, []);
  const appearance = followSystem ? systemAppearance : "light";
  return <Theme appearance={appearance} accentColor="gray" grayColor="gray" radius="medium" scaling="95%"><App /></Theme>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Launcher /></StrictMode>);
