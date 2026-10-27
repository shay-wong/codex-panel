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
    const gates = [...body.matchAll(new RegExp(`(${identifier})=(${identifier})\\|\\|(${identifier})\\|\\|((?:${identifier}&&${identifier}\\|\\|${identifier}\\|\\|)?)(${identifier})(\\|\\|${identifier}\\?\\.isLoading===!0)?\\|\\|(${identifier})\\|\\|(${identifier})(?=[,;])`, "g"))]
      .filter(match => body.includes(`submitDisabled:${match[1]},`)
        && body.includes(`${match[5]}=`) && body.includes('codexErrorInfo===`misalignmentPolicyViolation`'));
    const readers = [...source.matchAll(/let\{cwd:([\w$]+),hostId:([\w$]+)\}=([\w$]+)\.get\(([\w$]+),([\w$]+)\);if\(\2!==`local`\)return null;let\{data:([\w$]+)\}=\3\.get\(([\w$]+),\{cwd:\1,hostId:\2\}\);return \6==null\|\|\(\3\.get\(([\w$]+),\5\)\?\?\6\.model_provider\?\?`openai`\)!==`openai`/g)];
    const react = body.match(/\(0,([\w$]+)\.useState\)/)?.[1];
    if (gates.length === 1 && readers.length === 1 && react) {
      const gate = gates[0], reader = readers[0];
      const host = body.match(new RegExp(`${escapePattern(gate[8])}=${identifier}\\(${identifier}\\)&&(${identifier})===\x60local\x60`))?.[1];
      const thread = host && body.match(new RegExp(`${escapePattern(host)}=${identifier}\\(${identifier},(${identifier})\\)`))?.[1];
      const stores = thread ? [...new Set([...body.matchAll(new RegExp(`(${identifier})\\.get\\(${identifier},${escapePattern(thread)}\\)`, "g"))].map(match => match[1]))] : [];
      const hostQuota = host && body.includes(`${gate[7]}=`) && new RegExp(`${escapePattern(gate[7])}=${identifier}\\(${identifier},${escapePattern(host)}\\)`).test(body);
      const policy = new RegExp(`${escapePattern(gate[5])}=${identifier}===\x60failed\x60&&${identifier}\\?\\.codexErrorInfo===\x60misalignmentPolicyViolation\x60`).test(body);
      if (hostQuota && policy && thread && stores.length === 1) {
        const blockers = `${gate[2]}||${gate[3]}||${gate[4]}${gate[5]}${gate[6] ?? ""}`;
        return {entry, react, gate: gate[0], blockers, quotas: gate.slice(7, 9).join("||"), host, thread, store: stores[0], target: reader[4], provider: reader[8], config: reader[7]};
      }
    }
  }
  if ((!sourceUrl || new URL(sourceUrl).pathname.endsWith("/" + CODEX_PROVIDER_QUOTA_ASSET)) && source.includes("function m7(e){")) {
    return {entry: "function m7(e){", react: "h7", gate: "cn=ye||$e||ot||nt||Rt", blockers: "ye||$e||ot", quotas: "nt||Rt", host: "et", thread: "Qe", store: "Me", target: "tv", provider: "zl", config: "Hf"};
  }
  return null;
}
// 新版将发送门控拆到独立模块；provider atom 仍从原生 primary 的读取器解析。
function splitComposerSignature(source, providerSource, sourceUrl) {
  if (!/\/codex-composer-adapter-[\w-]+\.js$/.test(new URL(sourceUrl).pathname)) return null;
  const readers = [...providerSource.matchAll(/let\{cwd:([\w$]+),hostId:([\w$]+)\}=([\w$]+)\.get\(([\w$]+),([\w$]+)\);if\(\2!==`local`\)return null;let\{data:([\w$]+)\}=\3\.get\(([\w$]+),\{cwd:\1,hostId:\2\}\);return \6==null\|\|\(\3\.get\(([\w$]+),\5\)\?\?\6\.model_provider\?\?`openai`\)!==`openai`/g)];
  const gates = [...source.matchAll(new RegExp(`let (${identifier})=([^;]+?)\\|\\|(${identifier})\\|\\|(${identifier}),`, "g"))]
    .filter(match => source.includes(`submitDisabled:${match[1]},`) && match[2].includes("?.isLoading===!0"));
  if (readers.length !== 1 || gates.length !== 1) return null;
  const reader = readers[0], gate = gates[0];
  const workQuota = source.match(new RegExp(`${escapePattern(gate[4])}=(${identifier})\\((${identifier})===\x60local\x60&&${identifier}\\)`));
  if (!workQuota) return null;
  const host = workQuota[2];
  const context = source.match(new RegExp(`${escapePattern(host)}=(${identifier})\\(${identifier},(${identifier})\\)`));
  if (!context || !new RegExp(`${escapePattern(gate[3])}=${escapePattern(context[1])}\\(${identifier},${escapePattern(host)}\\)`).test(source)) return null;
  const policy = source.match(new RegExp(`(${identifier})=${identifier}===\x60failed\x60&&${identifier}\\?\\.codexErrorInfo===\x60misalignmentPolicyViolation\x60`));
  if (!policy || !gate[2].split("||").includes(policy[1])) return null;
  const functions = [...source.matchAll(/function [\w$]+\([^)]*\)\{/g)];
  const containing = functions.findLast(entry => entry.index < gate.index);
  const body = source.slice(containing?.index, gate.index);
  const react = body.match(/\(0,([\w$]+)\.useState\)/)?.[1];
  if (!react) return null;
  const imports = [...providerSource.matchAll(/import\{([^}]+)\}from["`]([^"`]+)["`]/g)];
  const atoms = [reader[4], reader[7], reader[8]].map(local => {
    for (const entry of imports) {
      const match = entry[1].match(new RegExp(`(?:^|,)(${identifier}) as ${escapePattern(local)}(?:,|$)`));
      if (match) return { name: match[1], url: new URL(entry[2], sourceUrl).href };
    }
  });
  if (atoms.some(atom => !atom) || new Set(atoms.map(atom => atom.url)).size !== 1) return null;
  return { gate, host, hook: context[1], thread: context[2], react, atoms };
}

const appliedMessage = "Panel custom-provider quota fix: native module executed.";

export function createCodexProviderQuotaRuntime(initialEnabled) {
  let enabled = initialEnabled === true;
  const listeners = new Set();
  return {
    installed: false,
    prepared: false,
    applied: false,
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

export function rewriteCodexProviderQuota(source, sourceUrl, providerSource = source) {
  const split = sourceUrl && splitComposerSignature(source, providerSource, sourceUrl);
  if (split) {
    const { gate, host, hook, thread, react, atoms } = split;
    const names = ["panelQuotaTargetAtom", "panelQuotaConfigAtom", "panelQuotaProviderAtom"];
    const importLine = `import {${atoms.map((atom, index) => `${atom.name} as ${names[index]}`).join(",")}} from ${JSON.stringify(atoms[0].url)};`;
    const read = `const panelQuotaEnabled=(0,${react}.useSyncExternalStore)(globalThis.__codexPanelProviderQuotaV1__.subscribe,globalThis.__codexPanelProviderQuotaV1__.getSnapshot);const panelQuotaTarget=${hook}(panelQuotaTargetAtom,${thread});const panelQuotaThreadProvider=${hook}(panelQuotaProviderAtom,${thread});const panelQuotaConfig=${hook}(panelQuotaConfigAtom,panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;`;
    const custom = `panelQuotaEnabled&&${host}==="local"&&typeof panelQuotaProvider==="string"&&panelQuotaProvider!==""&&panelQuotaProvider!=="openai"`;
    source = importLine + source.replace(gate[0], `${read}let ${gate[1]}=${gate[2]}||((${gate[3]}||${gate[4]})&&!(${custom})),`);
    return absoluteModuleImports(source, sourceUrl);
  }
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
  return absoluteModuleImports(patched, sourceUrl);
}

function absoluteModuleImports(source, sourceUrl) {
  return source
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, sourceUrl).href)}`)
    .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, specifier) => `import(${JSON.stringify(new URL(specifier, sourceUrl).href)})`)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl));
}

export async function prepareCodexProviderQuotaFix(cdp, preferencesFile, report = console.error, modules = [], dotEntryPrepared = false, ultrafastPrepared = modules.length === 2) {
  if (!preferencesFile) return "";
  try {
    let preferences = {};
    try {
      preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let replacements = modules;
    let quotaPrepared = false;
    let quotaModuleUrl = null;
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const candidates = [...new Set([
            ...performance.getEntriesByType("resource").map(entry => entry.name),
            // 适配后的模块通过 blob 加载，资源列表可能不再包含原 URL；从已安装的映射找回当前模块。
            ...[...document.querySelectorAll('script[type="importmap"]')].flatMap(node => {
              try { return Object.keys(JSON.parse(node.textContent).imports ?? {}); }
              catch { return []; }
            }),
            ...[...document.querySelectorAll("script[src],link[rel=modulepreload][href]")].map(node => node.src || node.href),
          ].filter(url => /\\/app-primary-[\\w-]+\\.js$/.test(new URL(url, location.href).pathname)))];
          if (candidates.length === 0) candidates.push(new URL(${JSON.stringify(`/assets/${CODEX_PROVIDER_QUOTA_ASSET}`)}, location.href).href);
          for (const url of candidates) {
            try {
              const response = await fetch(url, { cache: "no-store" });
              if (response.ok) {
                const source = await response.text();
                const adapterPath = source.match(/["'\x60](\\.\\/codex-composer-adapter-[\\w-]+\\.js)["'\x60]/)?.[1];
                if (adapterPath) {
                  const adapterUrl = new URL(adapterPath, url).href;
                  const adapter = await fetch(adapterUrl, { cache: "no-store" });
                  if (!adapter.ok) throw new Error("Native composer adapter unreadable");
                  return { url: adapterUrl, source: await adapter.text(), providerSource: source };
                }
                return { url, source };
              }
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
      const { url, source, providerSource } = result.result.value;
      const patched = rewriteCodexProviderQuota(modules.find(module => module.url === url)?.source ?? source, url, providerSource);
      if (patched === null) throw new Error("unsupported composer source");
      cdp.on("Runtime.consoleAPICalled", ({ args }) => {
        if (args?.[0]?.value === appliedMessage) report(appliedMessage);
      });
      report(`Panel custom-provider quota module prepared for the next renderer load: ${url}`);
      replacements = [...modules.filter(module => module.url !== url), {url, source: patched}];
      quotaPrepared = true;
      quotaModuleUrl = url;
    } catch (error) {
      // 新版输入框不匹配时，Dot 等独立模块仍可安装，不能被额度适配连带禁用。
      if (modules.length === 0) throw error;
      report(`Panel custom-provider quota fix unavailable: ${error.message}`);
    }
    return `(() => {
      if (window !== window.top) return;
      window.__codexPanelQuotaBootstrapPrepared__ = ${quotaPrepared};
      window.__codexPanelUltrafastBootstrapPrepared__ = ${ultrafastPrepared};
      window.__codexPanelDotBootstrapPrepared__ = ${dotEntryPrepared};
      const runtime = globalThis.__codexPanelProviderQuotaV1__ ??= (${createCodexProviderQuotaRuntime.toString()})(${preferences.customProviderQuotaFix === true});
      runtime.setEnabled(${preferences.customProviderQuotaFix === true});
      const ultrafast = globalThis.__codexPanelProviderUltrafastV1__ ??= (${createCodexProviderQuotaRuntime.toString()})(${preferences.customProviderUltrafast === true});
      ultrafast.setEnabled(${preferences.customProviderUltrafast === true});
      const dot = globalThis.__codexPanelDotEntryV1__ ??= (${createCodexProviderQuotaRuntime.toString()})(${preferences.showCustomProviderDot === true});
      dot.setEnabled(${preferences.showCustomProviderDot === true});
      // 首页可能延迟加载输入框模块；映射准备成功后无需重复安装。
      if (runtime.installed || runtime.prepared) return;
      const install = () => {
        if (!document.documentElement) return;
        observer.disconnect();
        const imports = Object.fromEntries(${JSON.stringify(replacements)}.map(({url, source}) => [url,
          URL.createObjectURL(new Blob([source + ${JSON.stringify("\nglobalThis.__codexPanelProviderQuotaV1__.installed=true;")} + (url === ${JSON.stringify(quotaModuleUrl)} ? ${JSON.stringify(`globalThis.__codexPanelProviderQuotaV1__.applied=true;console.info(${JSON.stringify(appliedMessage)});`)} : "")], { type: "text/javascript" }))]));
        const map = document.createElement("script");
        map.type = "importmap";
        map.textContent = JSON.stringify({ imports });
        document.documentElement.prepend(map);
        runtime.prepared = true;
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
