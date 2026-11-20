import { sourceAst, property, propertyName, unwrap, isFunction, returnValue, unique, applyEdits } from './codex-source-ast.mjs';

export const factoryAst = (source, context) => context?.ast(source) ?? sourceAst(source, { factory: true });
export function bodyStart(fn) {
  const directives = fn.body.body.filter(node => node.type === 'ExpressionStatement' && typeof node.directive === 'string');
  return directives.at(-1)?.end ?? fn.body.start + 1;
}
const isCall = node => unwrap(node)?.type === 'CallExpression';
const functionOf = (ast, node) => ast.enclosing(node, isFunction);
const declaratorOf = (ast, node) => ast.enclosing(node, value => value.type === 'VariableDeclarator');
const same = (ast, a, b) => a === b || (a?.type === 'Identifier' && b?.type === 'Identifier' && ast.binding(a) != null && ast.binding(a) === ast.binding(b));
const providerCache = new WeakMap();

export function bindingValues(ast, node, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (node.type !== 'Identifier') return [node];
  const binding = ast.binding(node);
  if (!binding) return [node];
  const values = binding.init ? [binding.init] : [];
  for (const reference of ast.references(binding)) {
    const parent = ast.parent(reference);
    if (parent?.type === 'AssignmentExpression' && parent.left === reference && parent.operator === '=') values.push(parent.right);
  }
  return values.flatMap(value => bindingValues(ast, value, seen));
}

function dependencies(ast, roots) {
  const visited = new Set(), bindings = new Set(), pending = [...roots];
  while (pending.length) {
    const expression = pending.pop();
    if (!expression || visited.has(expression)) continue;
    for (const node of ast.all(() => true, expression)) {
      visited.add(node);
      if (node.type !== 'Identifier') continue;
      const binding = ast.binding(node);
      if (!binding || bindings.has(binding)) continue;
      bindings.add(binding);
      if (binding.init) pending.push(binding.init);
      for (const reference of ast.references(binding)) {
        const assignment = ast.parent(reference);
        if (assignment?.type === 'AssignmentExpression' && assignment.left === reference && assignment.operator === '=') pending.push(assignment.right);
      }
    }
  }
  return visited;
}

export function importedExpression(context, ast, node, requireName) {
  const exported = context.exportOf(ast, node);
  if (!exported || !context.moduleSource(exported.id)) throw new Error('Native custom-provider dependency is unavailable');
  return `${requireName}(${JSON.stringify(exported.id)})[${JSON.stringify(exported.exportName)}]`;
}

// Follow the provider expression's own inputs instead of relying on nearby statements or labels.
export function nativeProvider(context) {
  if (providerCache.has(context)) return providerCache.get(context);
  const candidates = [];
  for (const module of context.modulesContaining('model_provider')) {
    const ast = context.moduleAst(module.id);
    if (!ast) throw new Error('Native custom-provider dependency is unavailable');
    for (const field of ast.all(node => node.type === 'MemberExpression' && propertyName(node) === 'model_provider')) {
      const fn = functionOf(ast, field);
      if (!fn) continue;
      const dataBinding = field.object.type === 'Identifier' && ast.binding(field.object);
      const dataDeclaration = dataBinding && declaratorOf(ast, dataBinding.node);
      if (dataDeclaration?.id?.type !== 'ObjectPattern' || !property(dataDeclaration.id, 'data') || !isCall(dataDeclaration.init)) continue;
      const configCall = unwrap(dataDeclaration.init);
      if (propertyName(unwrap(configCall.callee)) !== 'get') continue;
      const target = unwrap(ast.value(configCall.arguments[1]));
      if (target?.type !== 'ObjectExpression') continue;
      const cwd = property(target, 'cwd')?.value, host = property(target, 'hostId')?.value;
      if (!cwd || !host) continue;
      const scopeDeclaration = cwd.type === 'Identifier' && declaratorOf(ast, ast.binding(cwd)?.node);
      if (scopeDeclaration?.id?.type !== 'ObjectPattern' || !property(scopeDeclaration.id, 'cwd') || !property(scopeDeclaration.id, 'hostId') || !isCall(scopeDeclaration.init)) continue;
      if (!same(ast, property(scopeDeclaration.id, 'hostId').value, host)) continue;
      const scopeCall = unwrap(scopeDeclaration.init);
      if (propertyName(unwrap(scopeCall.callee)) !== 'get') continue;
      const chain = ast.enclosing(field, node => node.type === 'LogicalExpression' && node.operator === '??');
      if (!chain) continue;
      let providerChain = chain;
      while (ast.parent(providerChain)?.type === 'LogicalExpression' && ast.parent(providerChain).operator === '??') providerChain = ast.parent(providerChain);
      const calls = ast.all(node => node.type === 'CallExpression' && propertyName(unwrap(node.callee)) === 'get', providerChain)
        .filter(call => call.arguments.length === 2 && same(ast, call.arguments[1], scopeCall.arguments[1]) && same(ast, unwrap(call.callee).object, unwrap(scopeCall.callee).object));
      if (calls.length !== 1) continue;
      candidates.push({ ast, target: scopeCall.arguments[0], config: configCall.arguments[0], provider: calls[0].arguments[0] });
    }
  }
  const byInputs = new Map();
  for (const candidate of candidates) {
    const inputs = ['target', 'config', 'provider'].map(key => context.exportOf(candidate.ast, candidate[key]));
    if (inputs.every(Boolean)) byInputs.set(JSON.stringify(inputs), candidate);
  }
  const provider = unique([...byInputs.values()], 'Native custom-provider reader is unavailable');
  providerCache.set(context, provider);
  return provider;
}

export function reactNamespace(ast, fn) {
  const names = new Set(ast.all(node => node.type === 'MemberExpression' && ['useState', 'use', 'useSyncExternalStore'].includes(propertyName(node)), fn)
    .map(node => ast.text(node.object)));
  return unique([...names], 'Native React hooks are unavailable');
}

// Splitting a declaration at a bound value preserves initialization order even in comma declarations.
export function afterDeclaration(ast, declarator, text) {
  const declaration = ast.parent(declarator);
  if (declaration?.type !== 'VariableDeclaration') throw new Error('Native hook declaration is unsupported');
  const index = declaration.declarations.indexOf(declarator);
  const next = declaration.declarations[index + 1];
  return next
    ? { start: declarator.end, end: next.start, text: `;${text}${declaration.kind} ` }
    : { start: declaration.end, end: declaration.end, text: `${ast.source[declaration.end - 1] === ';' ? '' : ';'}${text}` };
}

function quotaSignal(context, ast, argument) {
  const resolved = context.resolve(ast, argument);
  if (!resolved) return false;
  const value = unwrap(resolved.ast.value(resolved.node));
  if (!isCall(value)) return false;
  const callbacks = value.arguments.filter(isFunction);
  return callbacks.some(callback => {
    const result = returnValue(callback);
    if (!result) return false;
    return resolved.ast.all(node => node.type === 'ArrayExpression', result).some(array => {
      const reasons = array.elements.map(element => {
        let reason = unwrap(element);
        while (reason?.type === 'LogicalExpression') reason = unwrap(reason.right);
        return reason?.type === 'Literal' ? reason.value : null;
      });
      return reasons.length === 2 && reasons.includes('reserve-limit') && reasons.includes('usage-limit');
    });
  });
}

export function rewriteRspackQuota(source, context) {
  if (!source.includes('data-codex-composer-root') || source.includes('panelQuotaEnabled')) return null;
  const ast = factoryAst(source, context);
  const roots = ast.all(node => node.type === 'Property' && propertyName(node) === 'data-codex-composer-root');
  if (!roots.length) return null;
  const candidates = [...new Set(roots.map(node => functionOf(ast, node)))].map(fn => ({ fn,
    submitted: ast.all(node => node.type === 'Property' && ['submitDisabledReasons', 'submitDisabled'].includes(propertyName(node))
      && functionOf(ast, node) === fn, fn),
  })).filter(candidate => candidate.submitted.length);
  if (!candidates.length) return null;
  const { fn, submitted } = unique(candidates, 'Native composer is ambiguous');
  const active = dependencies(ast, submitted.map(node => node.value));
  const calls = ast.all(node => node.type === 'CallExpression' && active.has(node), fn);
  const signalReads = calls.filter(call => call.arguments.length === 2 && quotaSignal(context, ast, call.arguments[0]));
  const reasonNodes = ast.all(node => active.has(node) && node.type === 'LogicalExpression' && ['reserve-limit', 'usage-limit'].includes(unwrap(node.right)?.value), fn);
  let host, hostQuota, workQuota;
  if (signalReads.length) host = unique(signalReads, 'Native quota signal read is ambiguous').arguments[1];
  else if (reasonNodes.length) {
    const reserve = unique(reasonNodes.filter(node => unwrap(node.right)?.value === 'reserve-limit'), 'Native reserve quota reason is ambiguous');
    hostQuota = unique(bindingValues(ast, reserve.left).filter(isCall), 'Native reserve quota reader is unavailable');
    host = hostQuota.arguments[1];
  } else {
    const work = calls.filter(call => call.arguments.length === 1 && ast.all(node => node.type === 'BinaryExpression' && ['===', '=='].includes(node.operator)
      && [unwrap(node.left)?.value, unwrap(node.right)?.value].includes('local'), call.arguments[0]).length);
    workQuota = unique(work, 'Native composer quota gate is unsupported');
    const local = unique(ast.all(node => node.type === 'BinaryExpression' && [unwrap(node.left)?.value, unwrap(node.right)?.value].includes('local'), workQuota.arguments[0]), 'Native quota host is ambiguous');
    host = unwrap(local.left)?.value === 'local' ? local.right : local.left;
    hostQuota = unique(calls.filter(call => call.arguments.length === 2 && same(ast, call.arguments[1], host)
      && same(ast, unwrap(call.callee)?.object, unwrap(workQuota.callee)?.object)), 'Native host quota reader is unsupported');
  }
  const hostBinding = host?.type === 'Identifier' && ast.binding(host);
  const hostDeclaration = hostBinding && declaratorOf(ast, hostBinding.node);
  const hostRead = hostDeclaration && unwrap(ast.value(hostDeclaration.init));
  if (hostRead?.type !== 'CallExpression' || hostRead.arguments.length !== 2) throw new Error('Native host quota reader is unsupported');
  const thread = hostRead.arguments[1];
  const provider = nativeProvider(context);
  const requireName = 'panelQuotaRequire';
  const atoms = ['target', 'config', 'provider'].map(key => importedExpression(context, provider.ast, provider[key], requireName));
  const hook = ast.text(unwrap(hostRead.callee));
  const runtime = 'globalThis.__codexPanelProviderQuotaV1__';
  const read = `const panelQuotaEnabled=(0,${reactNamespace(ast, fn)}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);const panelQuotaTarget=(0,${hook})(${atoms[0]},${ast.text(thread)});const panelQuotaThreadProvider=(0,${hook})(${atoms[2]},${ast.text(thread)});const panelQuotaConfig=(0,${hook})(${atoms[1]},panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;const panelCustomQuota=panelQuotaEnabled&&${ast.text(host)}==="local"&&typeof panelQuotaProvider==="string"&&panelQuotaProvider!==""&&panelQuotaProvider!=="openai";`;
  const start = bodyStart(ast.factory);
  const edits = [{ start, end: start, text: `const ${requireName}=${ast.text(ast.factory.params[2])};` }, afterDeclaration(ast, hostDeclaration, read)];
  if (signalReads.length) {
    const call = signalReads[0];
    edits.push({ start: call.start, end: call.end, text: `((value)=>panelCustomQuota?null:value)(${ast.text(call)})` });
  } else if (reasonNodes.length) {
    for (const node of reasonNodes) edits.push({ start: node.start, end: node.end, text: `(${ast.text(node.left)})&&!panelCustomQuota&&${ast.text(node.right)}` });
  } else {
    const gate = unique(submitted.filter(node => propertyName(node) === 'submitDisabled'), 'Native composer quota gate is unsupported');
    const initializers = bindingValues(ast, gate.value);
    const quotaBindings = [hostQuota, workQuota].map(call => ast.binding(declaratorOf(ast, call)?.id));
    const references = initializers.flatMap(node => ast.all(value => value.type === 'Identifier' && quotaBindings.includes(ast.binding(value)), node));
    if (references.length !== 2) throw new Error('Native composer quota gate is unsupported');
    for (const node of references) edits.push({ start: node.start, end: node.end, text: `(${ast.text(node)}&&!panelCustomQuota)` });
  }
  return applyEdits(source, edits);
}
