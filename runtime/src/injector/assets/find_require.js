async function findCodexRspackRequire() {
  const existing = globalThis.__codexPanelRspack__?.require ?? globalThis.__codexPanelUpdateRequire__;
  if (existing?.m) return existing;
  for (const script of document.querySelectorAll('script[type="module"][src]')) {
    const module = await import(script.src);
    if (!("__webpack_require__" in module)) continue;
    const load = module.__webpack_require__;
    if (typeof load !== "function" || !load.m) throw Error("Codex 原生模块注册表不可用");
    globalThis.__codexPanelUpdateRequire__ = load;
    return load;
  }
  return null;
}
