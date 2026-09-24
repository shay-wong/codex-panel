// Identify the native custom-provider composer by its source structure.
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

// Keep the previously verified build as a fallback for its older source shape.
export const CODEX_PROVIDER_QUOTA_ASSET = "app-primary-aaee46b7f0ce.js";
const identifier = "[A-Za-z_$][\\w$]*";
const escapePattern = value => value.replaceAll("$", "\\$");

function composerSignature(source, sourceUrl) {
  const functions = [...source.matchAll(/function [\w$]+\([^)]*\)\{/g)];
  const composers = functions.map((entry, index) => ({
    entry: entry[0],
    body: source.slice(entry.index, functions[index + 1]?.index),
  })).filter(({body}) => body.includes('"data-codex-composer-root"') && body.includes('`misalignmentPolicyViolation`'));
  if (composers.length === 1) {
    const {entry, body} = composers[0];
    const gates = [...body.matchAll(new RegExp(`(${identifier})=(${identifier})\\|\\|(${identifier})\\|\\|(${identifier})\\|\\|(${identifier})\\|\\|(${identifier})(?=[,;])`, "g"))]
      .filter(match => body.includes(`submitDisabled:${match[1]},`)
        && body.includes(`${match[4]}=`) && body.includes('codexErrorInfo===`misalignmentPolicyViolation`'));
    const readers = [...source.matchAll(/let\{cwd:([\w$]+),hostId:([\w$]+)\}=([\w$]+)\.get\(([\w$]+),([\w$]+)\);if\(\2!==`local`\)return null;let\{data:([\w$]+)\}=\3\.get\(([\w$]+),\{cwd:\1,hostId:\2\}\);return \6==null\|\|\(\3\.get\(([\w$]+),\5\)\?\?\6\.model_provider\?\?`openai`\)!==`openai`/g)];
    const react = body.match(/\(0,([\w$]+)\.useState\)/)?.[1];
    if (gates.length === 1 && readers.length === 1 && react) {
      const gate = gates[0], reader = readers[0];
      const host = body.match(new RegExp(`${escapePattern(gate[6])}=${identifier}\\(${identifier}\\)&&(${identifier})===\x60local\x60`))?.[1];
      const thread = host && body.match(new RegExp(`${escapePattern(host)}=${identifier}\\(${identifier},(${identifier})\\)`))?.[1];
      const stores = thread ? [...new Set([...body.matchAll(new RegExp(`(${identifier})\\.get\\(${identifier},${escapePattern(thread)}\\)`, "g"))].map(match => match[1]))] : [];
      const hostQuota = host && body.includes(`${gate[5]}=`) && new RegExp(`${escapePattern(gate[5])}=${identifier}\\(${identifier},${escapePattern(host)}\\)`).test(body);
      const policy = new RegExp(`${escapePattern(gate[4])}=${identifier}===\x60failed\x60&&${identifier}\\?\\.codexErrorInfo===\x60misalignmentPolicyViolation\x60`).test(body);
      if (hostQuota && policy && thread && stores.length === 1) {
        return {entry, react, gate: gate[0], blockers: gate.slice(2, 5).join("||"), quotas: gate.slice(5, 7).join("||"), host, thread, store: stores[0], target: reader[4], provider: reader[8], config: reader[7]};
      }
    }
  }
  if ((!sourceUrl || new URL(sourceUrl).pathname.endsWith("/" + CODEX_PROVIDER_QUOTA_ASSET)) && source.includes("function m7(e){")) {
    return {entry: "function m7(e){", react: "h7", gate: "cn=ye||$e||ot||nt||Rt", blockers: "ye||$e||ot", quotas: "nt||Rt", host: "et", thread: "Qe", store: "Me", target: "tv", provider: "zl", config: "Hf"};
  }
  return null;
}
const appliedMessage = "Panel custom-provider quota fix: native module executed.";

export function createCodexProviderQuotaRuntime(initialEnabled) {
  let enabled = initialEnabled === true;
  const listeners = new Set();
  return {
    installed: false,
    getSnapshot: () => enabled,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled(value) {
      const next = value === true;
      if (enabled === next) return;
      enabled = next;
      for (const listener of listeners) listener();
    },
  };
}

export function watchCodexProviderQuotaPreferences(preferencesFile, onChange) {
  if (!preferencesFile) return null;
  return watch(path.dirname(preferencesFile), (_, filename) => {
    if (filename === path.basename(preferencesFile)) onChange();
  });
}

export function rewriteCodexProviderQuota(source, sourceUrl) {
  const signature = composerSignature(source, sourceUrl);
  if (!signature) return null;
  const {entry, react, gate, blockers, quotas, host, thread, store, target, provider, config} = signature;
  if (source.split(entry).length !== 2 || source.split(gate).length !== 2) return null;
  const liveEntry = `${entry}const panelQuotaEnabled=(0,${react}.useSyncExternalStore)(globalThis.__codexPanelProviderQuotaV1__.subscribe,globalThis.__codexPanelProviderQuotaV1__.getSnapshot);`;
  const replacement = `${gate.split("=")[0]}=${blockers}||((${quotas})&&!(panelQuotaEnabled&&(()=>{const target=${store}.get(${target},${thread});const provider=${store}.get(${provider},${thread})??${store}.get(${config},target).data?.model_provider;return ${host}===\x60local\x60&&typeof provider===\x60string\x60&&provider!==\x60openai\x60})()))`;
  const patched = source.replace(entry, liveEntry).replace(gate, replacement);
  if (!sourceUrl) return patched;
  // The matched generated chunks use literal relative imports. Keep their
  // targets and import.meta.url unchanged when the module itself moves to a blob.
  return patched
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, sourceUrl).href)}`)
    .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, specifier) => `import(${JSON.stringify(new URL(specifier, sourceUrl).href)})`)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl));
}

export async function prepareCodexProviderQuotaFix(cdp, preferencesFile, report = console.error) {
  if (!preferencesFile) return "";
  try {
    let preferences = {};
    try {
      preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const candidates = [...new Set([
          ...performance.getEntriesByType("resource").map(entry => entry.name),
          ...[...document.querySelectorAll("script[src],link[rel=modulepreload][href]")].map(node => node.src || node.href),
        ].filter(url => /\\/app-primary-[\\w-]+\\.js$/.test(new URL(url, location.href).pathname)))];
        if (candidates.length === 0) candidates.push(new URL(${JSON.stringify(`/assets/${CODEX_PROVIDER_QUOTA_ASSET}`)}, location.href).href);
        for (const url of candidates) {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (response.ok) return { url, source: await response.text() };
          } catch {}
        }
        throw new Error("No supported composer asset could be read");
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
    report(`Panel custom-provider quota module prepared for the next renderer load: ${url}`);
    return `(() => {
      if (window !== window.top) return;
      const runtime = globalThis.__codexPanelProviderQuotaV1__ ??= (${createCodexProviderQuotaRuntime.toString()})(${preferences.customProviderQuotaFix === true});
      runtime.setEnabled(${preferences.customProviderQuotaFix === true});
      if (runtime.installed) return;
      const install = () => {
        if (!document.documentElement) return;
        observer.disconnect();
        const replacement = URL.createObjectURL(new Blob([${JSON.stringify(`${patched}\nglobalThis.__codexPanelProviderQuotaV1__.installed=true;console.info(${JSON.stringify(appliedMessage)});`)}], { type: "text/javascript" }));
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
