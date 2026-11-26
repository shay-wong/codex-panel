import { property, propertyValue, propertyName, unwrap, isFunction, returnValue, unique, applyEdits } from './codex-source-ast.mjs';
import { factoryAst, bodyStart, nativeProvider, importedExpression, reactNamespace } from './codex-rspack-quota.mjs';

const enclosingFunction = (ast, node) => ast.enclosing(node, isFunction);
const direct = (ast, node, fn) => enclosingFunction(ast, node) === fn;
const declarationOf = (ast, node) => ast.enclosing(node, item => item.type === 'VariableDeclarator');
const member = (node, name) => ['MemberExpression', 'OptionalMemberExpression'].includes(unwrap(node)?.type) && propertyName(unwrap(node)) === name;
const sameBinding = (ast, a, b) => a === b || (a?.type === 'Identifier' && b?.type === 'Identifier' && ast.binding(a) != null && ast.binding(a) === ast.binding(b));
const signalCache = new WeakMap();

function beforeDeclaration(ast, declarator, text) {
  const declaration = ast.parent(declarator);
  if (declaration?.type !== 'VariableDeclaration') throw new Error('Native hook declaration is unsupported');
  const index = declaration.declarations.indexOf(declarator);
  return index === 0 ? { start: declaration.start, end: declaration.start, text }
    : { start: declaration.declarations[index - 1].end, end: declarator.start, text: `;${text}${declaration.kind} ` };
}

export function rewriteRspackProjectlessChat(source, context) {
  if (!source.includes('canStartProjectlessChat') && !source.includes('startNewConversation')) return null;
  const ast = factoryAst(source, context);
  const enabled = 'globalThis.__codexPanelProjectlessChatV1__?.getSnapshot()===true';
  const selectors = ast.all(node => node.type === 'ObjectPattern' && property(node, 'canStartProjectlessChat'));
  if (selectors.length) {
    const fn = unique([...new Set(selectors.map(node => enclosingFunction(ast, node)))], 'Unsupported default new-chat target');
    const branches = ast.all(node => node.type === 'IfStatement', fn).filter(node => {
      const body = node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
      const returns = body.filter(item => item.type === 'ReturnStatement');
      if (returns.length !== 1) return false;
      const value = unwrap(ast.value(returns[0].argument));
      return value?.type === 'ObjectExpression' && unwrap(propertyValue(value, 'assignment'))?.value === null
        && unwrap(propertyValue(value, 'kind'))?.value === 'projectless';
    });
    if (branches.length) {
      const branch = unique(branches, 'Unsupported default new-chat target');
      return applyEdits(source, [{ start: branch.test.start, end: branch.test.end, text: `(${ast.text(branch.test)})||${enabled}` }]);
    }
  }
  const newChatAction = ast.value(ast.exports().get('startNewConversation'));
  const actions = ast.all(node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && property(node.id, 'activeProject'))
    .filter(node => enclosingFunction(ast, node) === newChatAction);
  if (!actions.length) return null;
  const target = unique(actions, 'Unsupported native new-chat action');
  const fn = enclosingFunction(ast, target);
  const optionNames = ast.all(node => node.type === 'Identifier', target.init)
    .filter(node => fn.params.some(param => sameBinding(ast, param, node)));
  const options = ast.text(unique(optionNames, 'Unsupported native new-chat options'));
  return applyEdits(source, [beforeDeclaration(ast, target,
    `if(${enabled}&&${options}?.activeProject===undefined)${options}={...${options},activeProject:null};`)]);
}

function nativeSettings(ast) {
  const candidates = [];
  for (const call of ast.all(node => node.type === 'CallExpression' && member(node.arguments[0], 'models') && member(node.arguments[1], 'model'))) {
    const fn = enclosingFunction(ast, call);
    if (!fn) continue;
    const access = ast.all(node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && property(node.id, 'serviceTierAccess'), fn)
      .filter(node => direct(ast, node, fn) && unwrap(node.init)?.type === 'CallExpression');
    if (access.length !== 1) continue;
    const targets = ast.all(node => node.type === 'VariableDeclarator' && member(node.init, 'hostId'), fn).filter(node => direct(ast, node, fn));
    if (targets.length !== 1) continue;
    const target = unwrap(targets[0].init).object;
    const scope = declarationOf(ast, target.type === 'Identifier' && ast.binding(target)?.node);
    const scopeCall = scope && unwrap(scope.init);
    if (scopeCall?.type !== 'CallExpression' || scopeCall.arguments.length !== 1) continue;
    const thread = scopeCall.arguments[0];
    const readers = ast.all(node => node.type === 'CallExpression' && node.arguments.length === 2 && sameBinding(ast, node.arguments[1], thread), fn)
      .filter(node => direct(ast, node, fn) && unwrap(node.callee)?.type === 'MemberExpression');
    const hooks = [...new Map(readers.map(node => [ast.text(unwrap(node.callee)), node.callee])).values()];
    if (hooks.length !== 1) continue;
    candidates.push({ fn, model: call, access: access[0], scope, scopeCall, thread, hook: hooks[0] });
  }
  return candidates;
}

function settingsResultEdits(ast) {
  const edits = [];
  for (const object of ast.all(node => node.type === 'ObjectExpression' && property(node, 'setServiceTier') && !property(node, 'serviceTierAccess'))) {
    const fn = enclosingFunction(ast, object);
    const bindings = ast.all(node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && property(node.id, 'serviceTierAccess'), fn)
      .filter(node => direct(ast, node, fn));
    const binding = bindings.find(node => {
      const tier = property(node.id, 'serviceTierSettings');
      const rest = node.id.properties.find(value => value.type === 'RestElement');
      return tier && sameBinding(ast, tier.value, propertyValue(object, 'serviceTierSettings'))
        || rest && object.properties.some(value => value.type === 'SpreadElement' && sameBinding(ast, value.argument, rest.argument));
    });
    if (!binding) continue;
    const access = property(binding.id, 'serviceTierAccess').value;
    edits.push({ start: object.end - 1, end: object.end - 1, text: `${object.properties.length ? ',' : ''}serviceTierAccess:${ast.text(access)}` });
  }
  return edits;
}

function rewriteModelMenu(ast) {
  const candidates = ast.all(node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern'
    && property(node.id, 'serviceTierSettings') && property(node.id, 'setServiceTier') && !property(node.id, 'serviceTierAccess'));
  const edits = [];
  for (const settings of candidates) {
    const fn = enclosingFunction(ast, settings);
    const tier = property(settings.id, 'serviceTierSettings').value;
    const access = ast.all(node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && property(node.id, 'serviceTierAccess'), fn)
      .filter(node => node !== settings && direct(ast, node, fn));
    if (access.length !== 1) continue;
    const allowed = property(access[0].id, 'serviceTierAccess').value;
    // 权限透传必须覆盖没有图标或多次缓存 selectedServiceTier 的菜单。
    edits.push({ start: settings.id.start + 1, end: settings.id.start + 1, text: 'serviceTierAccess:panelServiceTierAccess,' });
    for (const ref of ast.references(ast.binding(allowed))) {
      if (ref === allowed) continue;
      const parent = ast.parent(ref);
      edits.push(parent?.type === 'Property' && parent.shorthand
        ? { start: parent.start, end: parent.end, text: `${ast.text(ref)}:panelServiceTierAccess` }
        : { start: ref.start, end: ref.end, text: 'panelServiceTierAccess' });
    }
    const selected = ast.all(node => member(node, 'selectedServiceTier') && sameBinding(ast, unwrap(node).object, tier), fn);
    if (selected.length !== 1) continue;
    const selectedDeclaration = declarationOf(ast, selected[0]);
    const selectedValue = selectedDeclaration?.id ?? selected[0];
    const icons = ast.all(node => node.type === 'CallExpression' && node.arguments.some(argument => sameBinding(ast, argument, selectedValue)), fn)
      .filter(node => ast.enclosing(node, value => value.type === 'LogicalExpression' && value.operator === '&&'));
    if (icons.length !== 1) continue;
    const icon = icons[0];
    edits.push({ start: icon.start, end: icon.end, text: `(${ast.text(selectedValue)}==="ultrafast"&&${ast.text(tier)}.availableOptions.some(option=>option.value==="ultrafast")||${ast.text(icon)})` });
  }
  return edits;
}

export function rewriteRspackUltrafast(source, context) {
  if (!source.includes('serviceTierSettings') || source.includes('panelSpeedEnabled') || source.includes('panelServiceTierAccess')) return null;
  const ast = factoryAst(source, context);
  const settings = nativeSettings(ast);
  if (!settings.length) {
    const menu = rewriteModelMenu(ast);
    if (menu.length) return applyEdits(source, menu);
    if (ast.all(node => node.type === 'ObjectExpression' && property(node, 'hasManagedNewThreadSettings')
      && property(node, 'serviceTierSettings') && property(node, 'serviceTierAccess')).length) throw new Error('Unsupported Rspack Ultrafast settings structure');
    return null;
  }
  const native = unique(settings, 'Ambiguous Rspack Ultrafast settings');
  const provider = nativeProvider(context);
  const atoms = ['target', 'config', 'provider'].map(key => importedExpression(context, provider.ast, provider[key], 'panelSpeedRequire'));
  const runtime = 'globalThis.__codexPanelProviderUltrafastV1__';
  const hook = ast.text(unwrap(native.hook)), thread = ast.text(native.thread), model = ast.text(native.model.arguments[1]);
  const read = `const panelSpeedScope=${ast.text(native.scopeCall)};const panelSpeedEnabled=(0,${reactNamespace(ast,native.fn)}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);const panelSpeedTarget=(0,${hook})(${atoms[0]},${thread});const panelSpeedConfig=(0,${hook})(${atoms[1]},panelSpeedTarget);const panelSpeedThreadProvider=(0,${hook})(${atoms[2]},${thread});const panelSpeedProvider=panelSpeedThreadProvider??panelSpeedConfig.data?.model_provider??"openai";const panelCustomSpeed=panelSpeedEnabled&&panelSpeedScope.hostId==="local"&&typeof panelSpeedProvider==="string"&&panelSpeedProvider.trim()!=="";const panelUltrafastModel=/^(?:gpt-6[- ]astra|gpt-6\\.1[- ]sol|gpt-6\\.2[- ](?:astra|sol))$/i.test(${model});`;
  const accessCall = unwrap(native.access.init);
  const adaptedAccess = `((native)=>({...native,serviceTierAccess:panelCustomSpeed?{...native.serviceTierAccess,fast:panelUltrafastModel||native.serviceTierAccess?.fast===true,ultrafast:panelUltrafastModel}:native.serviceTierAccess}))(${ast.text(accessCall)})`;
  const adaptedModel = `(panelCustomSpeed&&panelUltrafastModel?(model=>{if(!model)return model;const missing=[{id:"priority",name:"Fast",description:""},{id:"ultrafast",name:"Ultrafast",description:""}].filter(tier=>!model.serviceTiers?.some(existing=>existing.id===tier.id));return missing.length?{...model,serviceTiers:[...(model.serviceTiers??[]),...missing]}:model})(${ast.text(native.model)}):${ast.text(native.model)})`;
  const factoryStart = bodyStart(ast.factory), hookStart = bodyStart(native.fn);
  return applyEdits(source, [
    { start: factoryStart, end: factoryStart, text: `const panelSpeedRequire=${ast.text(ast.factory.params[2])};` },
    { start: hookStart, end: hookStart, text: read },
    { start: native.scopeCall.start, end: native.scopeCall.end, text: 'panelSpeedScope' },
    { start: accessCall.start, end: accessCall.end, text: adaptedAccess },
    { start: native.model.start, end: native.model.end, text: adaptedModel },
    ...settingsResultEdits(ast),
  ]);
}

function signalExport(context, ast, family) {
  const namespace = context.exportOf(ast, family);
  if (!namespace) throw new Error('Native reactive namespace for Dot unavailable');
  const cached = signalCache.get(context) ?? new Map();
  if (cached.has(namespace.id)) return cached.get(namespace.id);
  const native = context.moduleAst(namespace.id);
  if (!native) throw new Error('Native reactive namespace for Dot unavailable');
  const candidates = new Map();
  for (const [name, target] of native.exports()) {
    const resolved = context.resolve(native, target);
    if (!resolved) continue;
    const fn = unwrap(resolved.ast.value(resolved.node));
    if (!isFunction(fn)) continue;
    const result = returnValue(fn);
    const value = result && unwrap(resolved.ast.value(result));
    if (value?.type !== 'CallExpression' || unwrap(value.arguments[0])?.value !== 'signal') continue;
    const identity = context.exportOf(resolved.ast, fn);
    const key = identity ? JSON.stringify(identity) : `${resolved.ast.source}:${fn.start}`;
    const previous = candidates.get(key);
    if (!previous || name.localeCompare(previous.exportName) < 0) candidates.set(key, { id: namespace.id, exportName: name });
  }
  const exported = unique([...candidates.values()], 'Native signal helper for Dot unavailable');
  cached.set(namespace.id, exported);
  signalCache.set(context, cached);
  return exported;
}

export function rewriteRspackDot(source, context) {
  if (!source.includes('isCapable') || source.includes('panelDotPreference')) return null;
  const ast = factoryAst(source, context);
  const candidates = [];
  for (const fn of ast.all(isFunction)) {
    const request = fn.params[0], readerPattern = fn.params.find(node => node.type === 'ObjectPattern' && property(node, 'get'));
    if (request?.type !== 'Identifier' || !readerPattern) continue;
    const lookups = ast.all(node => node.type === 'VariableDeclarator' && unwrap(node.init)?.type === 'MemberExpression' && unwrap(node.init).computed
      && member(unwrap(node.init).property, 'name') && sameBinding(ast, unwrap(unwrap(node.init).property).object, request), fn);
    if (lookups.length !== 1 || !ast.all(node => node.type === 'ObjectExpression' && property(node, 'isCapable'), fn).length) continue;
    const call = ast.parent(fn);
    if (call?.type === 'CallExpression') candidates.push({ fn, call, lookup: lookups[0], request, reader: property(readerPattern, 'get').value });
  }
  if (!candidates.length) return null;
  const candidate = unique(candidates, 'Unsupported Rspack Dot capability structure');
  const signal = signalExport(context, ast, candidate.call.callee);
  const runtime = 'globalThis.__codexPanelDotEntryV1__';
  const scope = candidate.call.arguments.find(node => node !== candidate.fn);
  const check = `if(${ast.text(candidate.lookup.id)}!=null&&(${ast.text(candidate.request)}.name==="orbit"||${ast.text(candidate.request)}.name==="orbit.navigation")&&${ast.text(candidate.reader)}(panelDotPreference))return{isLoading:false,isError:false,isCapable:true};`;
  const after = ast.parent(candidate.lookup);
  const next = after.declarations[after.declarations.indexOf(candidate.lookup) + 1];
  const insertion = next ? { start: candidate.lookup.end, end: next.start, text: `;${check}${after.kind} ` }
    : { start: after.end, end: after.end, text: `${ast.source[after.end - 1] === ';' ? '' : ';'}${check}` };
  const callText = applyEdits(ast.text(candidate.call), [{ start: insertion.start - candidate.call.start, end: insertion.end - candidate.call.start, text: insertion.text }]);
  const preference = `panelDotRequire(${JSON.stringify(signal.id)})[${JSON.stringify(signal.exportName)}](${ast.text(scope)},()=>${runtime}.getSnapshot(),{getServerSnapshot:()=>false,onMount(set){set(${runtime}.getSnapshot());return ${runtime}.subscribe(()=>set(${runtime}.getSnapshot()))}})`;
  const start = bodyStart(ast.factory);
  return applyEdits(source, [
    { start, end: start, text: `const panelDotRequire=${ast.text(ast.factory.params[2])};` },
    { start: candidate.call.start, end: candidate.call.end, text: `((panelDotPreference)=>${callText})(${preference})` },
  ]);
}
