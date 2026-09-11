import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import App from "./App";
import "./launcher.css";

function Launcher() {
  const [appearance, setAppearance] = useState<"dark" | "light">(() => (
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  ));
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setAppearance(media.matches ? "dark" : "light");
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return <Theme appearance={appearance} accentColor="gray" grayColor="gray" radius="medium" scaling="95%"><App /></Theme>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Launcher /></StrictMode>);
