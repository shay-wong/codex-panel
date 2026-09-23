// ChatGPT 26.917.51856: adapt only this build's local custom-provider composer.
import { readFile } from "node:fs/promises";

export const CODEX_PROVIDER_QUOTA_ASSET = "app-primary-aaee46b7f0ce.js";
const accountQuotaGate = "cn=ye||$e||ot||nt||Rt";
const providerQuotaGate = "cn=ye||$e||ot||((nt||Rt)&&!(()=>{const target=Me.get(tv,Qe);const provider=Me.get(zl,Qe)??Me.get(Hf,target).data?.model_provider;return et===`local`&&typeof provider===`string`&&provider!==`openai`})())";
const appliedMessage = "Panel custom-provider quota fix: native module executed.";

export function rewriteCodexProviderQuota(source, sourceUrl) {
  if (!source.includes(providerQuotaGate) && source.split(accountQuotaGate).length !== 2) return null;
  const patched = source.replace(accountQuotaGate, providerQuotaGate);
  if (!sourceUrl) return patched;
  // This pinned generated chunk has only literal relative imports. Keep their
  // targets and import.meta.url unchanged when the module itself moves to a blob.
  return patched
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, sourceUrl).href)}`)
    .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, specifier) => `import(${JSON.stringify(new URL(specifier, sourceUrl).href)})`)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl));
}

export async function prepareCodexProviderQuotaFix(cdp, preferencesFile, report = console.error) {
  if (!preferencesFile) return "";
  try {
    const preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
    if (preferences.customProviderQuotaFix !== true) return "";
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const url = new URL(${JSON.stringify(`/assets/${CODEX_PROVIDER_QUOTA_ASSET}`)}, location.href).href;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("Composer script HTTP " + response.status);
        return { url, source: await response.text() };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails || typeof result.result?.value?.source !== "string") {
      throw new Error("native composer source could not be read");
    }
    const { url, source } = result.result.value;
    const patched = rewriteCodexProviderQuota(source, url);
    if (patched === null) throw new Error("unsupported composer source");
    cdp.on("Runtime.consoleAPICalled", ({ args }) => {
      if (args?.[0]?.value === appliedMessage) report(appliedMessage);
    });
    report("Panel custom-provider quota module prepared for the next renderer load.");
    return `(() => {
      if (window !== window.top) return;
      const install = () => {
        if (!document.documentElement) return;
        observer.disconnect();
        const replacement = URL.createObjectURL(new Blob([${JSON.stringify(`${patched}\nconsole.info(${JSON.stringify(appliedMessage)});`)}], { type: "text/javascript" }));
        const map = document.createElement("script");
        map.type = "importmap";
        map.textContent = JSON.stringify({ imports: { [${JSON.stringify(url)}]: replacement } });
        document.documentElement.prepend(map);
      };
      const observer = new MutationObserver(install);
      observer.observe(document, { childList: true });
      install();
    })();`;
  } catch (error) {
    report(`Panel custom-provider quota fix unavailable: ${error.message}`);
    return "";
  }
}
