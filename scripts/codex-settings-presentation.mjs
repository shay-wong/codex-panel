import { applyEdits, isFunction, propertyName, sourceAst, unique, unwrap } from './codex-source-ast.mjs';

export function createSettingsPresentationRuntime(initialMode = 'system') {
  const normalize = value => value === 'dialog' || value === 'page' ? value : 'system';
  let mode = normalize(initialMode);
  const listeners = new Set();
  return {
    getSnapshot: () => mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(value) {
      const next = normalize(value);
      if (next === mode) return;
      mode = next;
      for (const listener of listeners) listener();
    },
  };
}

export function rewriteRspackSettingsPresentation(source, context) {
  if (!source.includes('3561799561') || source.includes('__codexPanelSettingsPresentationV1__')) return null;
  const ast = context?.ast?.(source) ?? sourceAst(source, { factory: true });
  const calls = ast.all(node => node.type === 'CallExpression' && unwrap(node.arguments[0])?.value === '3561799561');
  if (!calls.length) return null;
  const call = unique(calls, 'Native settings presentation gate is ambiguous');
  const fn = ast.enclosing(call, isFunction);
  const namespaces = ast.all(node => node.type === 'CallExpression'
    && ['useContext', 'useState', 'useEffect', 'useRef', 'useSyncExternalStore'].includes(propertyName(unwrap(node.callee))), fn)
    .filter(node => ast.enclosing(node, isFunction) === fn)
    .map(node => ast.text(unwrap(node.callee).object));
  const react = unique([...new Set(namespaces)], 'Native settings React hooks are unavailable');
  const runtime = 'globalThis.__codexPanelSettingsPresentationV1__';
  const mode = `(0,${react}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot)`;
  return applyEdits(source, [{
    start: call.start, end: call.end,
    // Keep the native gate subscribed so restoring system mode uses its current value.
    text: `((native,mode)=>mode==="system"?native:mode==="dialog")(${ast.text(call)},${mode})`,
  }]);
}
