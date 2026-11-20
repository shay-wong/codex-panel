import { sourceAst, isFunction, propertyName, propertyValue, returnValue, unwrap } from "./codex-source-ast.mjs";
import { rspackSourceContext, normalizeRspackFactory } from "./codex-rspack-source.mjs";
import { esmOwnNodes, esmSameBinding, readCodexEsmModules, readNativeSourceEntries } from "./codex-provider-quota.mjs";

const updateModules = new WeakMap();

// Rspack exposes its registry as an export of the page's declared module entry.
export async function findCodexRspackRequire() {
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

export async function readRuntimeFactories(cdp, term) {
  const terms = term == null ? [] : Array.isArray(term) ? term : [term];
  const entries = await readNativeSourceEntries(cdp, `(async()=>{
    const load=await (${findCodexRspackRequire})();
    if(!load)return null;
    const terms=${JSON.stringify(terms)};
    return Object.entries(load.m).flatMap(([id,factory])=>{
      if(typeof factory!=="function")return [];
      const source=String(factory.__codexPanelOriginalFactory__??factory);
      return !terms.length||terms.some(term=>source.includes(term))?[{id,source}]:[];
    });
  })()`, "id");
  if (entries == null) return null;
  if (!Array.isArray(entries) || entries.some(entry => typeof entry.id !== "string" || typeof entry.source !== "string")) throw Error("Codex 原生模块注册表不可用");
  return new Map(entries.map(entry => [entry.id, {id:entry.id, source:normalizeRspackFactory(entry.source)}]));
}

function functionCalls(context, ast, fn, visited = new Set()) {
  const resolved = context.resolve(ast, fn);
  if (!isFunction(resolved.node) || visited.has(resolved.node)) return [];
  visited.add(resolved.node);
  const result = [resolved];
  for (const call of resolved.ast.all(node => node.type === "CallExpression", resolved.node.body)) {
    result.push(...functionCalls(context, resolved.ast, unwrap(call.callee), visited));
  }
  return result;
}

const functionName = (ast, fn) => propertyName(ast.parent(fn)) ?? fn.id?.name;
const sameValue = (context, leftAst, left, rightAst, right) => {
  const a = context.resolve(leftAst, left), b = context.resolve(rightAst, right);
  return a.ast === b.ast && (a.node === b.node || a.ast.binding(a.node) && a.ast.binding(a.node) === b.ast.binding(b.node));
};

function subscriptionSignature(context, ast, fn, changes) {
  ({ast, node:fn} = context.resolve(ast, fn));
  if (!isFunction(fn) || fn.params.length !== 1) return null;
  const callback = fn.params[0];
  const ownCalls = esmOwnNodes(ast, fn, node => node.type === "CallExpression");
  const adds = ownCalls.filter(call => propertyName(unwrap(call.callee)) === "add" && esmSameBinding(ast, call.arguments[0], callback));
  const cleanup = context.resolve(ast, returnValue(fn));
  if (adds.length !== 1 || !isFunction(cleanup.node)) return null;
  const removes = cleanup.ast.all(node => node.type === "CallExpression" && propertyName(unwrap(node.callee)) === "delete"
    && sameValue(context, ast, adds[0].callee.object, cleanup.ast, node.callee.object)
    && sameValue(context, ast, callback, cleanup.ast, node.arguments[0]), cleanup.node.body);
  if (removes.length !== 1) return null;
  const snapshots = ownCalls.filter(call => esmSameBinding(ast, unwrap(call.callee), callback) && call.arguments.length === 1);
  if (snapshots.length !== 1) return null;
  const state = snapshots[0].arguments[0], value = context.resolve(ast, state);
  const updateShape = ["isUpdateReady", "lifecycleState", "downloadedUpdateAppBrand"].every(name => propertyValue(value.node, name));
  if (!updateShape && !changes.some(change => sameValue(context, ast, state, change.ast, change.node))) return null;
  return {ast, fn};
}

function locateUpdateBindings(modules, context, moduleAst) {
  const related = new Set(), changes = [];
  for (const module of modules) {
    if (!(module.contains?.("stateChanged") ?? module.source.includes("stateChanged"))) continue;
    const ast = moduleAst(module);
    for (const fn of ast.all(node => isFunction(node) && functionName(ast, node) === "stateChanged")) {
      const owner = ast.parent(ast.parent(fn));
      const members = Array.isArray(owner?.body) ? owner.body : owner?.properties ?? [];
      const updater = members.some(member => propertyName(member) === "getRestartBlockers");
      for (const entry of functionCalls(context, ast, fn)) {
        related.add(entry.ast);
        if (updater) for (const assignment of entry.ast.all(node => node.type === "AssignmentExpression", entry.node.body)) changes.push({ast:entry.ast,node:assignment.left});
      }
    }
  }
  const subscriptions = new Map();
  for (const ast of related) {
    for (const [name, value] of ast.exports()) {
      const signature = subscriptionSignature(context, ast, value, changes);
      if (signature) subscriptions.set(signature.fn, context.exportOf(signature.ast, signature.fn) ?? context.exportOf(ast, value) ?? {id:context.id(ast),exportName:name});
    }
  }
  const channels = new Map(), channelModules = new Set(modules.filter(module => module.contains?.("appBetaPreferencesByAccountId") ?? module.source.includes("appBetaPreferencesByAccountId")));
  let pending = [...channelModules];
  while (pending.length) {
    for (const module of pending) {
      const ast = moduleAst(module);
      for (const [name, value] of ast.exports()) {
        const resolved = context.resolve(ast, value);
        if (resolved.node?.type !== "CallExpression") continue;
        for (const argument of resolved.node.arguments) {
          const callbacks = functionCalls(context, resolved.ast, argument);
          const uses = property => callbacks.some(entry => entry.ast.all(node => ["MemberExpression", "Property"].includes(node.type) && propertyName(node) === property, entry.node.body).length);
          if (["appBetaPreferencesByAccountId", "enabled", "isLoading"].every(uses)) channels.set(resolved.node,
            context.exportOf(resolved.ast, resolved.node) ?? context.exportOf(ast, value) ?? {id:context.id(ast),exportName:name});
        }
      }
    }
    if (channels.size) break;
    const targets = new Set(pending.map(module => module.id ?? module.url));
    pending = modules.filter(module => {
      if (channelModules.has(module) || module.id && ![...targets].some(id => module.contains?.(id) ?? module.source.includes(id))) return false;
      const ast = moduleAst(module);
      const imports = ast.factory ? ast.all(node => node.type === "CallExpression"
        && ast.binding(unwrap(node.callee)) === ast.binding(ast.factory.params[2]) && node.arguments[0]?.type === "Literal")
        .map(node => String(node.arguments[0].value))
        : ast.root.body.filter(node => ["ImportDeclaration","ExportNamedDeclaration","ExportAllDeclaration"].includes(node.type) && node.source)
          .map(node => new URL(node.source.value,module.url).href);
      return imports.some(id => targets.has(id));
    });
    pending.forEach(module => channelModules.add(module));
  }
  const descriptor = matches => matches.size === 1 ? (({id,exportName})=>({id,name:exportName}))([...matches.values()][0]) : null;
  return {subscription:descriptor(subscriptions), channel:descriptor(channels)};
}

export function buildCodexUpdateBindings(factories) {
  const context = rspackSourceContext(factories);
  return locateUpdateBindings([...factories.values()], context, module => context.moduleAst(module.id));
}

function esmUpdateContext(modules) {
  const sources = new Map(modules.map(module => [module.url,module])), asts = new Map(), urls = new WeakMap();
  const moduleAst = url => {
    if (!sources.has(url)) return null;
    if (!asts.has(url)) { const ast=sourceAst(sources.get(url).source);asts.set(url,ast);urls.set(ast,url); }
    return asts.get(url);
  };
  const exported = (ast, name) => {
    for (const node of ast.root.body) {
      if (node.type !== "ExportNamedDeclaration" || !node.source) continue;
      const specifier = node.specifiers.find(item => propertyName(item.exported) === name);
      if (specifier) {
        const target = moduleAst(new URL(node.source.value,urls.get(ast)).href);
        return target ? exported(target,propertyName(specifier.local)) : null;
      }
    }
    const value=ast.exports().get(name);
    return value ? {ast,node:value} : null;
  };
  const context = {
    id: ast => urls.get(ast),
    resolve(ast, node) {
      const visited=new Set();
      while (node && !visited.has(node)) {
        visited.add(node);
        const value=ast.value(node);
        if(value!==node){node=value;continue;}
        const object=node.type==="MemberExpression"?node.object:node;
        const binding=ast.binding(object), declaration=binding?.declaration;
        if (!["ImportSpecifier","ImportDefaultSpecifier","ImportNamespaceSpecifier"].includes(declaration?.type)) break;
        const statement=ast.parent(declaration), target=moduleAst(new URL(statement.source.value,urls.get(ast)).href);
        const name=declaration.type==="ImportNamespaceSpecifier"?propertyName(node):declaration.type==="ImportDefaultSpecifier"?"default":propertyName(declaration.imported);
        const next=target&&exported(target,name);
        if(!next)break;
        ({ast,node}=next);
      }
      return {ast,node};
    },
    exportOf(ast,node) {
      const name=ast.exportName(node);
      return name==null?null:{id:urls.get(ast),exportName:name};
    },
  };
  return {context,moduleAst:module=>moduleAst(module.url)};
}

// Resolve the cached native subscription without invoking a check or download.
export function updateSubscriptionExport(source) {
  const module={url:"file:///native-update.js",source}, {context,moduleAst}=esmUpdateContext([module]);
  const binding=locateUpdateBindings([module],context,moduleAst).subscription;
  if (!binding) throw Error("无法识别 Codex 原生更新状态接口");
  return binding.name;
}

async function readNativeUpdateValue(kind, binding) {
  const load=await findCodexRspackRequire();
  if (load) {
    const cached=globalThis.__codexPanelNativeUpdate__;
    binding=globalThis.__codexPanelRspack__?.nativeUpdate?.[kind]??(cached?.load===load?cached[kind]:null)??binding;
    if (!binding?.id) return {needsNativeUpdateBinding:true,rspack:true};
    globalThis.__codexPanelNativeUpdate__={...(cached?.load===load?cached:{}),load,[kind]:binding};
  } else if (!binding?.url) return {needsNativeUpdateBinding:true,rspack:false};
  const module=load
    ? await (globalThis.__codexPanelRspack__?.loadModule?.(binding.id) ?? load(binding.id))
    : await import(binding.url);
  const value=module[binding.name];
  if(kind==="subscription") {
    if(typeof value!=="function")throw Error("无法识别 Codex 原生更新状态订阅");
    let state;
    const unsubscribe=value(next=>{state=next;});
    unsubscribe();
    if(!state)throw Error("Codex 尚未提供更新状态，请稍后重试");
    return {isUpdateReady:state.isUpdateReady,lifecycleState:state.lifecycleState,downloadProgressPercent:state.downloadProgressPercent,downloadedUpdateAppBrand:state.downloadedUpdateAppBrand};
  }
  if(value?.scope?.__scopeBrand!=="AppScope"||typeof value.resolve!=="function")throw Error("无法识别当前 Codex 更新频道");
  for(const anchor of document.querySelectorAll('nav[data-app-navigation-rail], [data-codex-composer-root]')) {
    const key=Object.keys(anchor).find(key=>key.startsWith("__reactFiber$"));
    for(let fiber=anchor[key];fiber;fiber=fiber.return) {
      const chain=fiber.memoizedProps?.value;
      const node=chain instanceof Map?chain.get(value.scope.id):null;
      if(node?.token!==value.scope||!node.store?.get)continue;
      const state=node.store.get(value.resolve(node,chain));
      if(state.isLoading||typeof state.enabled!=="boolean")throw Error("Codex 更新频道尚未就绪");
      return {beta:state.enabled};
    }
  }
  throw Error("Codex 更新频道尚未就绪");
}

async function readUpdateValue(cdp,kind) {
  const evaluate=async binding=>{
    const response=await cdp.send("Runtime.evaluate",{
      expression:`(async()=>{const findCodexRspackRequire=${findCodexRspackRequire};return (${readNativeUpdateValue})(${JSON.stringify(kind)},${JSON.stringify(binding)});})()`,
      awaitPromise:true,returnByValue:true,
    });
    if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description??"无法读取 Codex 更新状态");
    return response.result?.value;
  };
  let value=await evaluate(updateModules.get(cdp)?.[kind]);
  if(!value?.needsNativeUpdateBinding)return value;
  let binding;
  if(value.rspack) {
    const factories=await readRuntimeFactories(cdp);
    if(factories)binding=buildCodexUpdateBindings(factories)[kind];
  }
  else {
    const modules=await readCodexEsmModules(cdp,[],entries=>{
      const {context,moduleAst}=esmUpdateContext(entries);
      return !!locateUpdateBindings(entries,context,moduleAst)[kind];
    });
    const {context,moduleAst}=esmUpdateContext(modules),descriptor=locateUpdateBindings(modules,context,moduleAst)[kind];
    if(descriptor)binding={url:descriptor.id,name:descriptor.name};
    if(binding)updateModules.set(cdp,{...updateModules.get(cdp),[kind]:binding});
  }
  if(!binding)throw Error(kind==="channel"?"无法识别当前 Codex 更新频道":"无法识别 Codex 原生更新状态接口");
  return evaluate(binding);
}

export async function readCodexUpdateChannel(cdp) {
  const state=await readUpdateValue(cdp,"channel");
  if(typeof state?.beta!=="boolean")throw Error("无法读取 Codex 更新频道");
  return state;
}

export async function readCodexUpdateState(cdp) {
  const state=await readUpdateValue(cdp,"subscription");
  // “ready” also means an offer exists; a downloaded brand confirms the payload arrived.
  return {ready:state?.isUpdateReady===true&&state.lifecycleState==="ready"&&["chatgpt","codex"].includes(state.downloadedUpdateAppBrand),
    downloading:state?.lifecycleState==="downloading",progress:Number.isFinite(state?.downloadProgressPercent)?state.downloadProgressPercent:null};
}

const updateChecks = new WeakMap();

export async function downloadCodexUpdate(cdp, download, { getPlanType } = {}) {
  const current = download.status();
  if (current?.ready || current?.downloading) return current;
  const result = updateChecks.get(cdp)?.result;
  if (result?.status !== "available") return readCodexUpdateStatus(cdp, { force: true, download });
  download.start({ ...result, getPlanType });
  return download.status();
}

export async function readCodexUpdateStatus(cdp, { force = false, download } = {}) {
  if (force) download?.clearFailure();
  const direct = download?.status();
  if (direct) return direct;
  const state = await readCodexUpdateState(cdp).catch(() => ({ ready: false, downloading: false, progress: null }));
  let check = updateChecks.get(cdp);
  if (check && !check.result && Date.now() - check.startedAt >= 35_000) {
    check.result = { status: "timeout" };
  }
  if (!check || (force && check.result) || Date.now() - check.startedAt >= 15 * 60_000) {
    check = { startedAt: Date.now(), result: null };
    updateChecks.set(cdp, check);
    // Query the official feed independently of Sparkle's skipped-version state.
    void readCodexUpdateChannel(cdp).then(channel => download.check(channel)).then(result => {
      check.result ??= result;
    }).catch(error => { check.result ??= { status: "error", error: error.message }; });
  }
  const result = check.result;
  const version = typeof result?.installedVersion === "string" ? ` · ${result.installedVersion}` : "";
  let message;
  if (state.ready) message = `更新已下载，可安装并重新连接${version}`;
  else if (state.downloading) message = `正在下载更新${state.progress == null ? "…" : ` · ${Math.round(state.progress)}%`}`;
  else if (!result) message = `正在检查更新…${version}`;
  else if (result.status === "busy") message = `Codex 更新器正忙，请稍后重试${version}`;
  else if (result.status === "timeout") message = "检查更新超时，请重试";
  else if (result.status === "up_to_date") message = `当前已是最新版${version}`;
  else if (result.status === "available") message = result.availableVersion ? `发现新版本 ${result.availableVersion}${version}` : `发现新版本，尚未下载完成${version}`;
  else if (result.status === "restart_required") message = `更新需要重启后生效${version}`;
  else message = `暂时无法检查更新${result.error ? `：${result.error}` : version}`;
  return { ready: state.ready, available: result?.status === "available", downloading: state.downloading,
    message, checking: !result && !state.ready && !state.downloading };
}
