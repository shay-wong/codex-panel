// Restore Dot through the local capability gate; server authorization is unchanged.
import { sourceAst, property, propertyValue, propertyName, unwrap, isFunction, applyEdits } from "./codex-source-ast.mjs";
import { absoluteModuleImports, esmFunction, esmOwnNodes, esmSameBinding, readCodexEsmModules } from "./codex-provider-quota.mjs";

export function rewriteCodexDotEntry(source, sourceUrl) {
  try {
    const ast = sourceAst(source), candidates = [];
    for (const fn of ast.all(isFunction)) {
      if (fn.body?.type !== "BlockStatement" || fn.params.length !== 2) continue;
      const request = fn.params[0], get = propertyValue(fn.params[1], "get");
      if (request.type !== "Identifier" || get?.type !== "Identifier") continue;
      const call = ast.parent(fn);
      if (call?.type !== "CallExpression" || call.arguments[1] !== fn) continue;
      const definitions = esmOwnNodes(ast, fn, node => node.type === "VariableDeclarator" && node.id.type === "Identifier"
        && node.init?.type === "MemberExpression" && node.init.computed
        && propertyName(node.init.property) === "name" && esmSameBinding(ast, node.init.property.object, request));
      for (const definition of definitions) {
        if (!esmOwnNodes(ast, fn, node => node.type === "MemberExpression" && propertyName(node) === "requiresFirstPartyInference"
          && esmSameBinding(ast, node.object, definition.id)).length) continue;
        const signals = ast.all(node => node.type === "CallExpression" && node.arguments.length === 3
          && esmSameBinding(ast, node.arguments[0], call.arguments[0])
          && property(node.arguments[2], "getServerSnapshot") && property(node.arguments[2], "onMount"));
        if (signals.length === 1) candidates.push({fn, call, definition, request, get, signal:signals[0]});
      }
    }
    if (candidates.length !== 1) return null;
    const {call, definition, request, get, signal} = candidates[0];
    const statement = ast.parent(definition);
    if (statement?.type !== "VariableDeclaration") return null;
    const runtime = "globalThis.__codexPanelDotEntryV1__", atom = `${runtime}.preference`;
    const initialize = `${atom}=${ast.text(signal.callee)}(${ast.text(call.arguments[0])},()=>${runtime}.getSnapshot(),{onMount(set){set(${runtime}.getSnapshot());return ${runtime}.subscribe(()=>set(${runtime}.getSnapshot()))}})`;
    // Signal families require an explicit key even when the key is undefined.
    const isDot = `${ast.text(definition.id)}!=null&&(${ast.text(request)}.name==="orbit"||${ast.text(request)}.name==="orbit.navigation")`;
    const patched = applyEdits(source, [
      {start:call.start,end:call.start,text:`(${initialize},`},
      {start:call.end,end:call.end,text:")"},
      {start:statement.end,end:statement.end,text:`;if(${isDot}&&${ast.text(get)}(${atom},void 0))return{isLoading:false,isError:false,isCapable:true};`},
    ]);
    return absoluteModuleImports(patched, sourceUrl);
  } catch { return null; }
}

export async function prepareCodexDotEntry(cdp, modules, report = console.error) {
  try {
    let candidates = modules.map(module => ({...module,source:rewriteCodexDotEntry(module.source,module.url)})).filter(module => module.source !== null);
    if (!candidates.length) {
      const sources = await readCodexEsmModules(cdp, modules, entries => entries.some(module => rewriteCodexDotEntry(module.source,module.url)));
      candidates = sources.map(module => ({...module,source:rewriteCodexDotEntry(module.source,module.url)})).filter(module => module.source !== null);
    }
    if (candidates.length !== 1) throw Error("unsupported or ambiguous native Dot capability structure");
    const prepared = candidates[0];
    report("Panel custom-provider Dot entry module prepared for the next renderer load.");
    return {modules:[...modules.filter(module => module.url !== prepared.url),prepared],prepared:true};
  } catch (error) {
    report(`Panel custom-provider Dot entry unavailable: ${error.message}`);
    return {modules,prepared:false};
  }
}
