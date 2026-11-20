// Resolve native ESM adapters through syntax and bindings, independent of bundle names.
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { sourceAst, property, propertyName, propertyValue, unwrap, isFunction, applyEdits } from "./codex-source-ast.mjs";

export function esmFunction(ast, node) {
  for (let current = node; current; current = ast.parent(current)) if (isFunction(current)) return current;
  return null;
}

const ownedNodeCache = new WeakMap();

export function esmOwnNodes(ast, fn, predicate) {
  let groups = ownedNodeCache.get(ast);
  if (!groups) {
    groups = new Map();
    for (const node of ast.nodes) {
      const owner = esmFunction(ast, node);
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(node);
    }
    ownedNodeCache.set(ast, groups);
  }
  return (groups.get(fn) ?? []).filter(predicate);
}

export function esmSameBinding(ast, left, right) {
  left = unwrap(left); right = unwrap(right);
  if (left?.type !== "Identifier" || right?.type !== "Identifier") return false;
  const binding = ast.binding(left);
  return binding ? binding === ast.binding(right) : left.name === right.name;
}

const literal = (node, value) => unwrap(node)?.value === value
  || (unwrap(node)?.type === "TemplateLiteral" && unwrap(node).expressions.length === 0 && unwrap(node).quasis[0].value.cooked === value);
const callNamed = (node, name) => node?.type === "CallExpression" && propertyName(unwrap(node.callee)) === name;
const orTerms = node => node?.type === "LogicalExpression" && node.operator === "||"
  ? [...orTerms(node.left), ...orTerms(node.right)] : [node];

// Both native consumers expose the provider/config relationship even when their local names change.
export function esmProviderReader(ast, { store = true } = {}) {
  const matches = [];
  for (const fn of ast.all(isFunction)) {
    const providerMembers = esmOwnNodes(ast, fn, node => node.type === "MemberExpression" && propertyName(node) === "model_provider");
    if (!providerMembers.length || !esmOwnNodes(ast, fn, node => literal(node, "openai")).length) continue;
    const calls = esmOwnNodes(ast, fn, node => node.type === "CallExpression");
    if (store) {
      for (const targetDecl of esmOwnNodes(ast, fn, node => node.type === "VariableDeclarator" && node.id.type === "ObjectPattern")) {
        const cwd = propertyValue(targetDecl.id, "cwd"), host = propertyValue(targetDecl.id, "hostId"), targetCall = unwrap(targetDecl.init);
        if (!cwd || !host || !callNamed(targetCall, "get") || targetCall.arguments.length !== 2) continue;
        if (!esmOwnNodes(ast, fn, node => node.type === "BinaryExpression" && ["!==", "!=", "===", "=="].includes(node.operator)
          && ((esmSameBinding(ast, node.left, host) && literal(node.right, "local")) || (esmSameBinding(ast, node.right, host) && literal(node.left, "local")))).length) continue;
        const configCalls = calls.filter(call => callNamed(call, "get") && esmSameBinding(ast, call.callee.object, targetCall.callee.object)
          && esmSameBinding(ast, propertyValue(call.arguments[1], "cwd"), cwd) && esmSameBinding(ast, propertyValue(call.arguments[1], "hostId"), host));
        const providers = calls.filter(call => call !== targetCall && callNamed(call, "get")
          && esmSameBinding(ast, call.callee.object, targetCall.callee.object) && esmSameBinding(ast, call.arguments[1], targetCall.arguments[1]));
        if (configCalls.length === 1 && providers.length === 1) matches.push({
          fn, target: targetCall.arguments[0], config: configCalls[0].arguments[0], provider: providers[0].arguments[0],
        });
      }
    } else {
      for (const member of providerMembers) {
        const data = ast.value(member.object);
        if (data?.type !== "MemberExpression" || propertyName(data) !== "data") continue;
        const config = unwrap(data.object);
        if (config?.type !== "CallExpression" || !property(config.arguments[1], "cwd") || !property(config.arguments[1], "hostId")) continue;
        const providers = calls.filter(call => call !== config && esmSameBinding(ast, call.callee, config.callee)
          && call.arguments.length === 2 && !property(call.arguments[1], "cwd"));
        if (providers.length === 1) matches.push({ fn, config: config.arguments[0], provider: providers[0].arguments[0] });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function composerSignature(ast) {
  const candidates = [];
  for (const prop of ast.all(node => node.type === "Property" && propertyName(node) === "submitDisabled")) {
    const ref = unwrap(prop.value), binding = ref?.type === "Identifier" ? ast.binding(ref) : null;
    const fn = esmFunction(ast, prop), init = binding?.init;
    if (!fn || init?.type !== "LogicalExpression" || init.operator !== "||") continue;
    const terms = orTerms(init);
    if (!terms.some(term => {
      const value = ast.value(term);
      return value && ast.find(node => node.type === "MemberExpression" && propertyName(node) === "codexErrorInfo", value)
        && ast.find(node => literal(node, "misalignmentPolicyViolation"), value);
    })) continue;
    const localQuotas = terms.map(term => ({term, value: ast.value(term)})).filter(({value}) => value && ast.all(node =>
      node.type === "BinaryExpression" && ["===", "=="].includes(node.operator)
      && (literal(node.left, "local") || literal(node.right, "local")), value).length);
    for (const {term: work, value} of localQuotas) {
      const local = ast.find(node => node.type === "BinaryExpression" && ["===", "=="].includes(node.operator)
        && (literal(node.left, "local") || literal(node.right, "local")), value);
      const host = literal(local.left, "local") ? local.right : local.left, hostCall = ast.value(host);
      if (hostCall?.type !== "CallExpression" || hostCall.arguments.length !== 2 || !ast.find(node => node.type === "CallExpression", value)) continue;
      const quotas = terms.filter(term => {
        const call = ast.value(term);
        return term !== work && call?.type === "CallExpression" && call.arguments.length === 2
          && esmSameBinding(ast, call.callee, hostCall.callee) && esmSameBinding(ast, call.arguments[1], host);
      });
      const hooks = esmOwnNodes(ast, fn, node => callNamed(node, "useState") || callNamed(node, "useSyncExternalStore"));
      const react = hooks[0] && unwrap(hooks[0].callee).object;
      if (quotas.length === 1 && react) candidates.push({fn, binding, init, terms, quota: quotas[0], work, host, hostCall, react});
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function importedAtom(ast, node, sourceUrl) {
  const binding = ast.binding(node), declaration = binding?.declaration;
  if (declaration?.type !== "ImportSpecifier") return null;
  const imported = declaration.imported.name ?? declaration.imported.value;
  const statement = ast.parent(declaration);
  if (statement?.type !== "ImportDeclaration") return null;
  return {name: imported, url: new URL(statement.source.value, sourceUrl).href};
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

export function rewriteCodexProviderQuota(source, sourceUrl, providerSource = source, providerUrl = sourceUrl) {
  try {
    const ast = sourceAst(source), signature = composerSignature(ast);
    const providerAst = providerSource === source ? ast : sourceAst(providerSource);
    const reader = esmProviderReader(providerAst);
    if (!signature || !reader) return null;
    const {fn, init, terms, quota, work, host, hostCall, react} = signature;
    const thread = hostCall.arguments[1];
    const runtime = "globalThis.__codexPanelProviderQuotaV1__";
    const enabled = `const panelQuotaEnabled=(0,${ast.text(react)}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);`;
    const blockers = terms.filter(term => term !== quota && term !== work).map(term => ast.text(term));
    const quotas = `${ast.text(quota)}||${ast.text(work)}`;
    let imports = "", read, provider, beforeGate = "";
    if (providerSource === source) {
      const stores = esmOwnNodes(ast, fn, node => callNamed(node, "get") && esmSameBinding(ast, node.arguments[1], thread))
        .map(call => call.callee.object);
      const store = stores[0];
      if (!store || stores.some(candidate => !esmSameBinding(ast, store, candidate))) return null;
      read = `const panelQuotaTarget=${ast.text(store)}.get(${ast.text(reader.target)},${ast.text(thread)});const panelQuotaProvider=${ast.text(store)}.get(${ast.text(reader.provider)},${ast.text(thread)})??${ast.text(store)}.get(${ast.text(reader.config)},panelQuotaTarget).data?.model_provider;`;
      provider = `(()=>{${read}return ${ast.text(host)}==="local"&&typeof panelQuotaProvider==="string"&&panelQuotaProvider!==""&&panelQuotaProvider!=="openai"})()`;
    } else {
      const atoms = [reader.target, reader.config, reader.provider].map(node => importedAtom(providerAst, node, providerUrl));
      if (atoms.some(atom => !atom) || new Set(atoms.map(atom => atom.url)).size !== 1) return null;
      const names = ["panelQuotaTargetAtom", "panelQuotaConfigAtom", "panelQuotaProviderAtom"];
      imports = `import {${atoms.map((atom, index) => `${atom.name} as ${names[index]}`).join(",")}} from ${JSON.stringify(atoms[0].url)};`;
      read = `const panelQuotaTarget=${ast.text(hostCall.callee)}(panelQuotaTargetAtom,${ast.text(thread)});const panelQuotaThreadProvider=${ast.text(hostCall.callee)}(panelQuotaProviderAtom,${ast.text(thread)});const panelQuotaConfig=${ast.text(hostCall.callee)}(panelQuotaConfigAtom,panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;`;
      beforeGate = read;
      provider = `${ast.text(host)}==="local"&&typeof panelQuotaProvider==="string"&&panelQuotaProvider!==""&&panelQuotaProvider!=="openai"`;
    }
    const gate = [...blockers, `((${quotas})&&!(panelQuotaEnabled&&${provider}))`].join("||");
    const patched = imports + applyEdits(source, [
      {start: fn.body.start + 1, end: fn.body.start + 1, text: enabled},
      // Native query hooks must execute even when another submit blocker is already true.
      {start: init.start, end: init.end, text: beforeGate ? `(()=>{${beforeGate}return ${gate}})()` : gate},
    ]);
    return sourceUrl ? absoluteModuleImports(patched, sourceUrl) : patched;
  } catch { return null; }
}

export function absoluteModuleImports(source, sourceUrl) {
  if (!sourceUrl) return source;
  const ast = sourceAst(source), edits = [];
  for (const node of ast.nodes) {
    const specifier = node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration"
      ? node.source : node.type === "ImportExpression" ? node.source : null;
    const value = specifier?.value ?? (specifier?.type === "TemplateLiteral" && specifier.expressions.length === 0 ? specifier.quasis[0].value.cooked : null);
    if (typeof value === "string" && value.startsWith(".")) edits.push({start: specifier.start, end: specifier.end, text: JSON.stringify(new URL(value, sourceUrl).href)});
    if (node.type === "MemberExpression" && propertyName(node) === "url" && node.object.type === "MetaProperty"
      && node.object.meta.name === "import" && node.object.property.name === "meta") edits.push({start: node.start, end: node.end, text: JSON.stringify(sourceUrl)});
  }
  return applyEdits(source, edits);
}

export async function readNativeSourceEntries(cdp, expression, key = "url") {
  const result = await cdp.send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: false});
  if (result.exceptionDetails) throw Error("native source entries unreadable");
  let loaded = result.result?.value;
  const objectId = result.result?.objectId;
  if (!Array.isArray(loaded) && objectId) {
    loaded = [];
    try {
      const metadata = await cdp.send("Runtime.callFunctionOn", {objectId,
        functionDeclaration:"function(key){return this.map(item=>({key:item[key],length:item.source.length}))}",
        arguments:[{value:key}], returnByValue:true});
      if (metadata.exceptionDetails || !Array.isArray(metadata.result?.value)) throw Error("native source metadata unreadable");
      for (let index = 0; index < metadata.result.value.length; index++) {
        const item = metadata.result.value[index];
        if (typeof item.key !== "string" || !Number.isSafeInteger(item.length) || item.length < 0) throw Error("native source metadata unreadable");
        let source = "";
        for (let start = 0; start < item.length; start += 500_000) {
          const chunk = await cdp.send("Runtime.callFunctionOn", {objectId,
            functionDeclaration:"function(index,start){return this[index].source.slice(start,start+500000)}",
            arguments:[{value:index},{value:start}],returnByValue:true});
          if (chunk.exceptionDetails || typeof chunk.result?.value !== "string" || chunk.result.value.length !== Math.min(500_000,item.length-start)) throw Error("native source chunk unreadable");
          source += chunk.result.value;
        }
        loaded.push({[key]:item.key,source});
      }
    } finally { await cdp.send("Runtime.releaseObject", {objectId}); }
  }
  return loaded;
}

// Fetch only discovered ESM URLs. Parsing imports on the host also handles renamed entry chunks.
export async function readCodexEsmModules(cdp, modules = [], complete = () => false) {
  const known = new Map(modules.map(module => [module.url, module]));
  if (complete([...known.values()])) return [...known.values()];
  const attempted = new Set(known.keys());
  let requested = null;
  for (;;) {
    const loaded = await readNativeSourceEntries(cdp, `(async()=>{
        const explicit=${JSON.stringify(requested)},ignored=new Set(${JSON.stringify([...known.keys()])});
        const candidates=explicit??[...performance.getEntriesByType("resource").map(entry=>entry.name),
          ...[...document.querySelectorAll('script[type="importmap"]')].flatMap(node=>{try{return Object.keys(JSON.parse(node.textContent).imports??{})}catch{return []}}),
          ...[...document.querySelectorAll('script[src],link[rel="modulepreload"][href]')].map(node=>node.src||node.href)];
        const urls=[...new Set(candidates.filter(Boolean).map(url=>new URL(url,location.href).href))].filter(url=>{const parsed=new URL(url);return !ignored.has(url)&&!["blob:","data:"].includes(parsed.protocol)&&parsed.pathname.endsWith(".js")});
        return (await Promise.all(urls.map(async url=>{try{const response=await fetch(url,{cache:"no-store"});return response.ok?{url,source:await response.text()}:null}catch{return null}}))).filter(Boolean);
      })()`);
    if (!Array.isArray(loaded)) throw Error("native ESM modules unreadable");
    for (const module of loaded) {
      attempted.add(module.url);
      if (!known.has(module.url)) known.set(module.url, module);
    }
    if (complete([...known.values()])) return [...known.values()];
    const dependencies = [];
    for (const module of known.values()) {
      let ast;
      try { ast = sourceAst(module.source); } catch { continue; }
      for (const node of ast.nodes) {
        const specifier = ["ImportDeclaration","ExportNamedDeclaration","ExportAllDeclaration","ImportExpression"].includes(node.type) ? node.source : null;
        const value = specifier?.value ?? (specifier?.type === "TemplateLiteral" && specifier.expressions.length === 0 ? specifier.quasis[0].value.cooked : null);
        if (typeof value !== "string" || !value.startsWith(".")) continue;
        const url = new URL(value, module.url).href;
        if (!attempted.has(url)) {attempted.add(url);dependencies.push(url);}
      }
    }
    if (!dependencies.length) return [...known.values()];
    requested = dependencies;
  }
}

export async function prepareCodexProviderQuotaFix(cdp, preferencesFile, report = console.error, modules = [], dotEntryPrepared = false, ultrafastPrepared = modules.length > 0, onPrepared) {
  if (!preferencesFile) return "";
  try {
    let preferences = {};
    try { preferences = JSON.parse(await readFile(preferencesFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let replacements = modules;
    let quotaPrepared = false;
    let quotaModuleUrl = null;
    try {
      const prepare = entries => {
        const prepared = [];
        for (const module of entries) {
          if (!module.source.includes("submitDisabled")) continue;
          const direct = rewriteCodexProviderQuota(module.source, module.url);
          if (direct) { prepared.push({url:module.url,source:direct}); continue; }
          for (const provider of entries.filter(candidate => candidate !== module && candidate.source.includes("model_provider"))) {
            const source = rewriteCodexProviderQuota(module.source, module.url, provider.source, provider.url);
            if (source && !prepared.some(candidate => candidate.url === module.url && candidate.source === source)) prepared.push({url:module.url,source});
          }
        }
        return prepared;
      };
      const candidates = await readCodexEsmModules(cdp, modules, entries => prepare(entries).length === 1);
      const prepared = prepare(candidates);
      if (prepared.length !== 1) throw Error("unsupported or ambiguous native composer source");
      const patched = prepared[0];
      cdp.on("Runtime.consoleAPICalled", ({args}) => {if(args?.[0]?.value===appliedMessage)report(appliedMessage);});
      report(`Panel custom-provider quota module prepared for the next renderer load: ${patched.url}`);
      replacements = [...modules.filter(module => module.url !== patched.url), patched];
      quotaPrepared = true;
      quotaModuleUrl = patched.url;
    } catch (error) {
      // An independent module remains installable if the composer structure changed.
      if (modules.length === 0) throw error;
      report(`Panel custom-provider quota fix unavailable: ${error.message}`);
    }
    onPrepared?.(quotaPrepared);
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
