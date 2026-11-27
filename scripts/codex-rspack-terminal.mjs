import { sourceAst, property, propertyValue, propertyName, unwrap, isFunction, returnValue, unique, applyEdits } from './codex-source-ast.mjs';
import { bodyStart, reactNamespace } from './codex-rspack-quota.mjs';
export { createBottomTerminalRuntime } from './codex-terminal-runtime.mjs';

const runtime = 'globalThis.__codexPanelBottomTerminalV1__';
const marker = '/* codex-panel-bottom-terminal */';
const legacyContexts = new WeakMap();
const callName = node => propertyName(unwrap(node.callee));
const same = (ast, a, b) => a === b || a?.type === 'Identifier' && b?.type === 'Identifier' && ast.binding(a) != null && ast.binding(a) === ast.binding(b);
const literal = (node, value) => {
  node = unwrap(node);
  return node?.type === 'Literal' ? node.value === value
    : node?.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'Literal' && !node.argument.value === value;
};
const fnOf = (ast, node) => ast.enclosing(node, isFunction);
const callOf = (ast, node) => ast.enclosing(node, value => value.type === 'CallExpression');
function outerBinding(ast, node, fn) {
  const value = unwrap(node);
  const binding = value?.type === 'Identifier' && ast.binding(value);
  return binding && (binding.node.start < fn.start || binding.node.end > fn.end);
}
function imported(context, ast, node, requireName) {
  const descriptor = context.exportOf(ast, node);
  if (!descriptor) throw new Error('Native bottom terminal dependency is unavailable');
  return `${requireName}(${JSON.stringify(descriptor.id)})[${JSON.stringify(descriptor.exportName)}]`;
}
function legacy(context) {
  if (!context) return false;
  const key = context.moduleSource;
  if (!legacyContexts.has(key)) legacyContexts.set(key, context.modulesExporting('terminalBottomPanelOpen$').length > 0);
  return legacyContexts.get(key);
}

function legacyTerminalPatch(ast) {
  const exports = ast.exports(), launch = exports.get('terminalLaunchPanel$');
  if (!launch) return null;
  const signal = unwrap(ast.value(launch));
  const callback = unique(signal?.arguments?.filter(isFunction) ?? [], 'Native terminal layout reader is unavailable');
  const result = returnValue(callback);
  if (!result) throw new Error('Native terminal layout setting is unavailable');
  const scope = propertyValue(callback.params[0], 'scope'), get = propertyValue(callback.params[0], 'get');
  if (scope?.type !== 'Identifier' || get?.type !== 'Identifier') throw new Error('Native terminal layout scope is unavailable');
  const visibility = name => {
    const init = unwrap(ast.value(exports.get(name)));
    const read = unique(init?.arguments?.filter(isFunction) ?? [], 'Native terminal visibility reader is unavailable');
    const readGet = propertyValue(read.params[0], 'get');
    const reads = ast.all(node => node.type === 'CallExpression' && same(ast, unwrap(node.callee), readGet) && unwrap(node.arguments[0])?.type === 'MemberExpression', read);
    const active = unique(reads.filter(node => propertyName(unwrap(node.arguments[0])) === 'activeTab$'), 'Native terminal controller is unavailable');
    const open = unique(reads.filter(node => node !== active), 'Native terminal visibility signal is unavailable');
    return { controller: unwrap(active.arguments[0]).object, open: open.arguments[0] };
  };
  const bottom = visibility('terminalBottomPanelOpen$'), right = visibility('terminalRightPanelOpen$');
  const namespace = unwrap(signal.callee)?.object;
  const atom = unique(ast.all(node => node.type === 'CallExpression' && node.arguments.length === 2 && literal(node.arguments[1], false)
    && unwrap(node.callee)?.type === 'MemberExpression' && same(ast, unwrap(node.callee).object, namespace)), 'Native terminal layout signal is unavailable');
  const show = unique(ast.all(node => node.type === 'CallExpression' && literal(node.arguments[1], 'bottom') && property(node.arguments[2], 'allowEmpty'), ast.value(exports.get('openTerminalBottomPanelWhenReady'))), 'Native terminal show action is unavailable');
  const hide = unique(ast.all(node => node.type === 'CallExpression' && node.arguments.length === 2 && literal(node.arguments[1], 'bottom'), ast.value(exports.get('toggleTerminalBottomPanel'))), 'Native terminal hide action is unavailable');
  const terminal = ast.value(exports.get('terminalTabType'));
  const open = ast.value(propertyValue(unwrap(terminal)?.arguments?.[0], 'open'));
  if (!isFunction(open) || open.params[0]?.type !== 'Identifier') throw new Error('Native terminal session action is unavailable');
  // Keep native capability gates; override only the default location preference.
  const target = result.type === 'ConditionalExpression' && literal(result.consequent, 'right') ? result.alternate : result;
  const configure = `${runtime}.configureLegacy({signal:${ast.text(unwrap(atom.callee))},routeScope:${ast.text(atom.arguments[0])},bottomController:${ast.text(bottom.controller)},rightController:${ast.text(right.controller)},bottomOpen$:${ast.text(bottom.open)},rightOpen$:${ast.text(right.open)},showPanel:(scope,panel)=>(${ast.text(unwrap(show.callee))})(scope,panel),hidePanel:(scope,panel)=>(${ast.text(unwrap(hide.callee))})(scope,panel),getLayout:scope=>scope.get(${ast.text(launch)}),isTerminalTab:tab=>tab.tabType.kind===${ast.text(exports.get('terminalTabType'))}.kind});`;
  return applyEdits(ast.source, [
    { start: target.start, end: target.end, text: `${runtime}.legacyLayout(${ast.text(scope)},${ast.text(get)},${ast.text(target)})` },
    { start: bodyStart(open), end: bodyStart(open), text: `${runtime}.trackScope(${ast.text(open.params[0])});` },
    { start: ast.factory.body.end - 1, end: ast.factory.body.end - 1, text: `;${configure}` },
  ]);
}

function controllerPatch(ast) {
  const constructions = ast.all(node => node.type === 'CallExpression' && isFunction(unwrap(node.callee)) && node.arguments.some(arg => literal(propertyValue(arg, 'panelId'), 'right') && property(arg, 'getPanelOpenSignal') && property(arg, 'setPanelOpen')));
  if (!constructions.length) return null;
  const construction = unique(constructions, 'Native panel controller is ambiguous');
  const builder = unwrap(construction.callee), options = builder.params[0];
  const panel = propertyValue(options, 'panelId');
  const setOpen = propertyValue(options, 'setPanelOpen');
  if (panel?.type !== 'Identifier' || setOpen?.type !== 'Identifier') throw new Error('Native panel controller parameters are unavailable');
  const controller = unique(ast.all(node => node.type === 'ObjectExpression' && property(node, 'openTab') && property(node, 'activeTab$') && property(node, 'closeEmptyPanel') && property(node, 'panelId'), builder), 'Native panel controller contract is unavailable');
  const closeEmpty = ast.value(propertyValue(controller, 'closeEmptyPanel'));
  const emptyCalls = ast.all(node => node.type === 'CallExpression', closeEmpty);
  const reconcile = unique(emptyCalls.filter(call => call.arguments.length === 2 && unwrap(call.arguments[1])?.type === 'ArrayExpression' && outerBinding(ast, unwrap(call.callee), builder)), 'Native panel reconciliation is unavailable');
  const closeFns = ast.all(isFunction, builder).filter(fn => ast.all(node => node.type === 'CallExpression' && same(ast, unwrap(node.callee), setOpen) && literal(node.arguments[1], false), fn).length && ast.all(node => literal(node, 'right-panel'), fn).length);
  const close = unique(closeFns.filter(fn => !closeFns.some(other => other !== fn && other.start > fn.start && other.end < fn.end)), 'Native panel close action is unavailable');
  const activate = ast.value(propertyValue(controller, 'activateTab'));
  const focusCall = unique(ast.all(node => node.type === 'CallExpression' && literal(node.arguments[1], 'right-panel'), activate), 'Native panel focus action is unavailable');
  const focusCallee = unwrap(focusCall.callee);
  const focusNamespace = focusCallee.object;
  const focusReads = ast.all(node => node.type === 'CallExpression' && callName(node) === 'get' && unwrap(node.arguments[0])?.type === 'MemberExpression' && same(ast, unwrap(node.arguments[0]).object, focusNamespace), close);
  const focusRead = unique(focusReads.filter(read => ast.all(node => node.type === 'ConditionalExpression' && ast.all(child => child === read, node.test).length, close).length), 'Native panel focus signal is unavailable');
  const signalCalls = ast.all(node => node.type === 'CallExpression' && node.arguments.length === 2 && unwrap(node.arguments[1])?.type === 'ArrayExpression' && unwrap(node.arguments[1]).elements.length === 0 && unwrap(node.callee)?.type === 'MemberExpression', builder);
  const signal = unique(signalCalls.filter(call => ast.parent(call)?.type === 'VariableDeclarator' && ast.text(ast.parent(call).id) === ast.text(propertyValue(controller, 'tabIds$'))), 'Native panel signals are unavailable');
  const rightOptions = construction.arguments.find(arg => literal(propertyValue(arg, 'panelId'), 'right'));
  const rightController = ast.enclosing(construction, node => node.type === 'VariableDeclarator')?.id;
  if (!rightController) throw new Error('Native right panel controller is unavailable');
  let panelText = 'panelTerminalPanelId';
  while (ast.all(node => node.type === 'Identifier' && node.name === panelText).length) panelText += '_';
  const guard = `${panelText}==="right"`;
  const edits = [{ start: bodyStart(builder), end: bodyStart(builder), text: `const ${panelText}=${ast.text(panel)};` }];
  const guardedCalls = new Set();
  const gate = call => {
    if (guardedCalls.has(call)) return;
    guardedCalls.add(call);
    edits.push({ start: call.start, end: call.end, text: `(${guard}&&${ast.text(call)})` });
  };
  for (const call of ast.all(node => node.type === 'CallExpression', builder)) {
    if (same(ast, unwrap(call.callee), reconcile.callee)) gate(call);
    // These layout setters belong to the original right controller, not the reused bottom instance.
    if (outerBinding(ast, unwrap(call.callee), builder) && literal(call.arguments[1], true)
      && (property(call.arguments[2], 'notifyTab') || ast.enclosing(call, node => node.type === 'LogicalExpression' && ast.all(child => child.type === 'MemberExpression' && propertyName(child) === 'isWorkspaceHome', node).length))) gate(call);
    if (callName(call) === 'set' && unwrap(call.arguments[0])?.type === 'MemberExpression' && same(ast, unwrap(call.arguments[0]).object, focusNamespace)) {
      if (fnOf(ast, call) === activate || ast.enclosing(call, node => node.type === 'LogicalExpression' && ast.all(child => child.type === 'MemberExpression' && propertyName(child) === 'exitFullWidthOnClose', node).length)) gate(call);
    }
    const callee = unwrap(call.callee);
    if (callee?.type === 'MemberExpression' && !same(ast, callee.object, focusNamespace)
      && ast.all(child => literal(child, 'auto_open'), activate).length && fnOf(ast, call) === activate
      && call.arguments.length === 3 && unwrap(call.arguments[1])?.type === 'MemberExpression' && propertyName(unwrap(call.arguments[1])) === 'tabId' && callName(call) !== 'set') gate(call);
  }
  for (const node of ast.all(node => literal(node, 'right-panel'), builder)) {
    if (node.start >= close.start && node.end <= close.end) continue;
    edits.push({ start: node.start, end: node.end, text: `(${panelText}+"-panel")` });
  }
  edits.push({ start: bodyStart(close), end: bodyStart(close), text: `if(${panelText}!=="right"){${ast.text(setOpen)}(${ast.text(close.params[0])},false);return;}` });
  const patchedBuilder = applyEdits(ast.text(builder), edits.map(edit => ({ ...edit, start: edit.start - builder.start, end: edit.end - builder.start })));
  const configure = `${runtime}.configureController({createController:panelTerminalCreateController,rightController:${ast.text(rightController)},rightOpen$:(${ast.text(propertyValue(rightOptions, 'getPanelOpenSignal'))})(),rightSetOpen:${ast.text(propertyValue(rightOptions, 'setPanelOpen'))},signal:${ast.text(unwrap(signal.callee))},routeScope:${ast.text(signal.arguments[0])},focus:(scope,area)=>(0,${ast.text(focusCallee)})(scope,area),getFocus:scope=>scope.get(${ast.text(focusRead.arguments[0])})});`;
  return applyEdits(ast.source, [
    { start: builder.start, end: builder.end, text: `(panelTerminalCreateController=${patchedBuilder})` },
    { start: bodyStart(ast.factory), end: bodyStart(ast.factory), text: 'let panelTerminalCreateController;' },
    { start: ast.factory.body.end - 1, end: ast.factory.body.end - 1, text: `;${configure}` },
  ]);
}

function terminalPatch(ast) {
  const exports = ast.exports();
  if (!exports.has('toggleTerminalPanel') || !exports.has('terminalTabType')) return null;
  const edits = [];
  const replace = (node, text) => edits.push({ start: node.start, end: node.end, text });
  const toggle = ast.value(exports.get('toggleTerminalPanel'));
  if (!isFunction(toggle)) throw new Error('Native terminal action is unavailable');
  replace(toggle.body, `{return ${runtime}.toggle(${ast.text(toggle.params[0])});}`);
  const controllerMembers = ast.all(node => node.type === 'MemberExpression' && ['tabs$', 'activeTab$', 'tabById$', 'updateTab', 'closeTab', 'activateTab'].includes(propertyName(node)));
  const controllers = new Map();
  for (const member of controllerMembers) {
    const base = unwrap(member.object);
    if (base?.type === 'MemberExpression') controllers.set(ast.text(base), base);
  }
  const controller = unique([...controllers.values()].filter(base => controllerMembers.some(member => ast.text(member.object) === ast.text(base) && propertyName(member) === 'tabs$') && controllerMembers.some(member => ast.text(member.object) === ast.text(base) && propertyName(member) === 'activeTab$')), 'Native terminal controller is unavailable');
  for (const node of ast.all(node => node.type === 'MemberExpression' && ast.text(node) === ast.text(controller))) replace(node, `${runtime}.controller`);
  const terminal = ast.value(exports.get('terminalTabType'));
  const openFunction = ast.value(propertyValue(unwrap(terminal)?.arguments?.[0], 'open'));
  const available = ast.value(exports.get('canOpenTerminalPanelTab'));
  if (!isFunction(openFunction) || !isFunction(available)) throw new Error('Native terminal session action is unavailable');
  const calls = ast.all(node => node.type === 'CallExpression');
  const openCalls = calls.filter(call => call.arguments.length === 3 && ast.all(node => node.type === 'Property' && propertyName(node) === 'onUndoClose', call.arguments[2]).length && literal(propertyValue(call.arguments[2], 'target'), 'right'));
  const openCall = unique(openCalls, 'Native terminal tab creation is unavailable');
  replace(openCall.callee, `${runtime}.controller.openTab`);
  replace(propertyValue(openCall.arguments[2], 'target'), `${runtime}.panelId`);
  const derived = ast.value(exports.get('terminalRightPanelOpen$'));
  const visibilityCallback = unique(derived.arguments.filter(isFunction), 'Native terminal visibility reader is unavailable');
  const scopePattern = visibilityCallback.params[0];
  const scopeName = 'panelTerminalScope';
  edits.push({ start: scopePattern.end - 1, end: scopePattern.end - 1, text: `,scope:${scopeName}` });
  edits.push({ start: bodyStart(visibilityCallback), end: bodyStart(visibilityCallback), text: `${runtime}.readLayout(${scopeName},${ast.text(propertyValue(scopePattern, 'get'))});` });
  const read = unique(ast.all(node => node.type === 'CallExpression' && callName(node) !== 'get' && node.arguments.length === 1 && unwrap(node.callee)?.type === 'Identifier' && unwrap(node.arguments[0])?.type === 'MemberExpression', derived).filter(call => !['activeTab$', 'tabs$'].includes(propertyName(unwrap(call.arguments[0])))), 'Native terminal visibility signal is unavailable');
  const rightSignal = read.arguments[0];
  for (const node of ast.all(node => node.type === 'MemberExpression' && same(ast, node.object, rightSignal.object) && propertyName(node) === propertyName(rightSignal))) replace(node, `${runtime}.open$`);
  const showCalls = calls.filter(call => literal(call.arguments[1], 'right') && call.arguments.length === 2);
  const showCall = unique(showCalls.filter(call => ast.enclosing(call, node => node.type === 'LogicalExpression' && ast.all(child => child.type === 'MemberExpression' && propertyName(child) === 'activateTab', node).length)), 'Native terminal panel action is unavailable');
  const showCallee = unwrap(showCall.callee);
  replace(showCall.callee, `${runtime}.show`);
  replace(showCall.arguments[1], 'true');
  for (const call of showCalls.filter(call => call !== showCall)) {
    const callee = unwrap(call.callee);
    if (callee?.type === 'MemberExpression' && same(ast, callee.object, showCallee.object)) {
      replace(call.callee, `${runtime}.setOpen`);
      replace(call.arguments[1], 'false');
    }
  }
  for (const node of ast.all(node => literal(node, 'right-panel'))) replace(node, `(${runtime}.panelId+"-panel")`);
  for (const template of ast.all(node => node.type === 'TemplateLiteral' && node.quasis.some(part => part.value.cooked?.includes('data-app-shell-tab-panel-controller="right"')))) replace(template, ast.text(template).replace('data-app-shell-tab-panel-controller="right"', `data-app-shell-tab-panel-controller="\${${runtime}.panelId}"`));
  const visibilityReads = calls.filter(call => callName(call) === 'get' && unwrap(call.arguments[0])?.type === 'MemberExpression'
    && same(ast, call.arguments[0].object, rightSignal.object) && propertyName(call.arguments[0]) === propertyName(rightSignal));
  const focusActions = calls.filter(call => {
    const sequence = ast.parent(call);
    return unwrap(call.callee)?.type === 'MemberExpression' && call.arguments.length === 1 && sequence?.type === 'SequenceExpression' && literal(sequence.expressions.at(-1), true)
      && ast.enclosing(call, node => node.type === 'LogicalExpression' && ast.all(child => child.type === 'CallExpression' && callName(child) === 'querySelector' && literal(child.arguments[0], 'textarea'), node).length);
  });
  for (const action of focusActions) {
    const fn = fnOf(ast, action);
    const visibility = unique(visibilityReads.filter(call => fnOf(ast, call) === fn), 'Native terminal focus scope is unavailable');
    replace(action, `${runtime}.focus(${ast.text(unwrap(visibility.callee).object)})`);
  }
  edits.push({ start: bodyStart(openFunction), end: bodyStart(openFunction), text: `${runtime}.trackScope(${ast.text(openFunction.params[0])});` });
  edits.push({ start: ast.factory.body.end - 1, end: ast.factory.body.end - 1, text: `;${runtime}.registerLaunch(${ast.text(openFunction.id ?? propertyValue(unwrap(terminal).arguments[0], 'open'))},${ast.text(exports.get('canOpenTerminalPanelTab'))},${ast.text(exports.get('terminalTabType'))});` });
  return applyEdits(ast.source, edits);
}

function rendererPatch(ast) {
  const candidates = ast.all(node => node.type === 'CallExpression' && literal(propertyValue(node.arguments[1], 'target'), 'content') && property(node.arguments[1], 'children'))
    .map(call => ({ call, inner: unwrap(propertyValue(call.arguments[1], 'children')) }))
    .filter(({ inner }) => inner?.type === 'CallExpression' && property(inner.arguments[1], 'controller') && property(inner.arguments[1], 'tabs'));
  if (!candidates.length) return null;
  const { call, inner } = unique(candidates, 'Native terminal tab header is ambiguous');
  const controller = propertyValue(inner.arguments[1], 'controller');
  return applyEdits(ast.source, [{ start: call.arguments[0].start, end: call.arguments[0].end, text: `(${ast.text(controller)}.panelId==="bottom"?${runtime}.Header:${ast.text(call.arguments[0])})` }]);
}

function shellPatch(ast, context) {
  const shells = ast.all(node => node.type === 'ObjectExpression' && property(node, 'Root') && property(node, 'MainContentLayout') && property(node, 'RightPanelTabs'));
  if (!shells.length) return null;
  const shell = unique(shells, 'Native workspace shell is ambiguous');
  const memo = ast.value(propertyValue(shell, 'Root'));
  const root = isFunction(memo) ? memo : unwrap(memo)?.arguments?.find(isFunction);
  if (!root) throw new Error('Native workspace root is unavailable');
  const workspaceProp = unique(ast.all(node => node.type === 'Property' && propertyName(node) === 'data-app-shell-workspace-layout', root), 'Native workspace layout is unavailable');
  const workspace = callOf(ast, workspaceProp);
  const declaration = ast.enclosing(workspace, node => node.type === 'AssignmentExpression' || node.type === 'VariableDeclarator');
  const workspaceValue = declaration.type === 'AssignmentExpression' ? declaration.left : declaration.id;
  const containers = ast.all(node => node.type === 'CallExpression' && property(node.arguments[1], 'children'), root).filter(call => {
    const children = unwrap(propertyValue(call.arguments[1], 'children'));
    return children?.type === 'ArrayExpression' && children.elements.length === 2 && children.elements.some(element => same(ast, element, workspaceValue));
  });
  const container = unique(containers, 'Native workspace container is unavailable');
  const tabRendererCalls = ast.all(node => node.type === 'CallExpression' && property(node.arguments[1], 'controller') && property(node.arguments[1], 'showTabStrip') && property(node.arguments[1], 'headerHeight'));
  const rendererCall = unique(tabRendererCalls, 'Native panel renderer is unavailable');
  const renderer = rendererCall.arguments[0];
  const nativeController = unwrap(propertyValue(rendererCall.arguments[1], 'controller'));
  const controllerNamespace = nativeController.object;
  const scopeReads = ast.all(node => node.type === 'CallExpression' && callName(node) === 'get' && unwrap(node.arguments[0])?.type === 'MemberExpression'
    && propertyName(unwrap(node.arguments[0])) === 'activeTab$' && ast.text(unwrap(node.arguments[0]).object) === ast.text(nativeController), root);
  const scopes = new Map(scopeReads.map(read => {
    const scope = unwrap(read.callee).object;
    return [ast.binding(scope), scope];
  }));
  const scope = unique([...scopes.values()], 'Native workspace scope is unavailable');
  const signalRead = unique(ast.all(node => node.type === 'CallExpression' && node.arguments.length === 1 && unwrap(node.arguments[0])?.type === 'MemberExpression' && propertyName(unwrap(node.arguments[0])) === 'singleTab$' && same(ast, unwrap(node.arguments[0]).object?.object, controllerNamespace)), 'Native reactive panel reader is unavailable');
  const resizers = [];
  for (const module of context.modulesContaining('getCurrentSize')) {
    const tree = context.moduleAst(module.id);
    const pane = tree.all(isFunction).find(fn => tree.all(node => node.type === 'Property' && propertyName(node) === 'width', fn).length && tree.all(node => node.type === 'Property' && propertyName(node) === 'getCurrentSize', fn).length);
    if (!pane) continue;
    for (const call of tree.all(node => node.type === 'CallExpression' && property(node.arguments[1], 'currentSize') && property(node.arguments[1], 'getCurrentSize'), pane)) {
      const descriptor = context.exportOf(tree, call.arguments[0]);
      if (descriptor) {
        const resolved = context.resolve(tree, call.arguments[0]);
        const fn = resolved.ast.value(resolved.node);
        if (isFunction(fn) && resolved.ast.all(node => node.type === 'Property' && propertyName(node) === 'edge', fn).length && resolved.ast.source.includes('ArrowUp')) resizers.push({ tree, node: call.arguments[0], descriptor });
      }
    }
  }
  const resizerById = new Map(resizers.map(candidate => [JSON.stringify(candidate.descriptor), candidate]));
  const resizer = unique([...resizerById.values()], 'Native vertical panel resizer is unavailable');
  const requireName = 'panelTerminalRequire';
  const configure = `${runtime}.configureView({React:${reactNamespace(ast, root)},Renderer:${imported(context, ast, renderer, requireName)},Resizer:${imported(context, resizer.tree, resizer.node, requireName)},useSignal:${ast.text(unwrap(signalRead.callee))}});`;
  return applyEdits(ast.source, [
    { start: bodyStart(ast.factory), end: bodyStart(ast.factory), text: `const ${requireName}=${ast.text(ast.factory.params[2])};` },
    { start: bodyStart(root), end: bodyStart(root), text: configure },
    { start: container.start, end: container.end, text: `${runtime}.wrap(${ast.text(scope)},${ast.text(container)})` },
  ]);
}

export function rewriteRspackTerminal(source, context) {
  if (source.includes(marker)) return null;
  if (legacy(context)) {
    if (!source.includes('terminalLaunchPanel$') || !source.includes('toggleTerminalPanel')) return null;
    const ast = context.ast(source);
    const rewritten = legacyTerminalPatch(ast);
    return rewritten == null ? null : `${rewritten}${marker}`;
  }
  if (!/toggleTerminalPanel|panelId|MainContentLayout|data-app-shell-tab-panel-controller/.test(source)) return null;
  const ast = context?.ast(source) ?? sourceAst(source, { factory: true });
  const rewritten = terminalPatch(ast) ?? controllerPatch(ast) ?? shellPatch(ast, context) ?? rendererPatch(ast);
  return rewritten == null ? null : `${rewritten}${marker}`;
}
