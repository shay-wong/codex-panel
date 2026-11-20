import { parseSync, visitorKeys } from 'oxc-parser';

const cache = new Map();
let cachedNodes = 0;

export const isFunction = node => !!node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);

export function unwrap(node) {
  while (node && ['ChainExpression', 'ParenthesizedExpression', 'SequenceExpression'].includes(node.type)) {
    node = node.type === 'SequenceExpression' ? node.expressions.at(-1) : node.expression;
  }
  return node;
}

export function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  return key?.type === 'Literal' ? String(key.value) : !node.computed && key?.type === 'Identifier' ? key.name : null;
}

export function property(node, name) {
  return unwrap(node)?.properties?.find(item => item.type === 'Property' && propertyName(item) === name) ?? null;
}

export const propertyValue = (node, name) => property(node, name)?.value ?? null;

function children(node) {
  return (visitorKeys[node.type] ?? []).flatMap(key => {
    const value = node[key];
    return Array.isArray(value) ? value.filter(item => item?.type) : value?.type ? [value] : [];
  });
}

export function returnValue(fn) {
  fn = unwrap(fn);
  if (!isFunction(fn)) return null;
  if (fn.body.type !== 'BlockStatement') return unwrap(fn.body);
  const returns = [];
  const visit = node => {
    if (isFunction(node)) return;
    if (node.type === 'ReturnStatement') returns.push(node.argument);
    else children(node).forEach(visit);
  };
  visit(fn.body);
  return returns.length === 1 ? unwrap(returns[0]) : null;
}

export function unique(values, message = 'Native source contract is ambiguous') {
  if (values.length !== 1) throw new Error(message);
  return values[0];
}

export function applyEdits(source, edits) {
  const ordered = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
  let end = 0, result = '';
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < end || edit.end < edit.start || edit.end > source.length) {
      throw new Error('Overlapping or invalid native source edits');
    }
    result += source.slice(end, edit.start) + edit.text;
    end = edit.end;
  }
  return result + source.slice(end);
}

export function sourceAst(source, { factory = false, cache: useCache = true } = {}) {
  const key = `${factory ? 'factory' : 'module'}:${source}`;
  if (useCache && cache.has(key)) return cache.get(key);
  const parsed = parseSync('codex.js', factory ? `(${source})` : source, { sourceType: 'module', preserveParens: false });
  if (parsed.errors.length) throw new Error(`Cannot parse native source: ${parsed.errors[0].message}`);
  const root = factory ? parsed.program.body[0]?.expression : parsed.program;
  if (factory && !isFunction(root)) throw new Error('Native factory is not a function');
  const nodes = [], parents = new WeakMap(), scopes = new WeakMap(), declarations = new WeakMap(), synthesized = [];
  const makeScope = (parent, functionScope = false) => ({ parent, functionScope, bindings: new Map() });
  const globalScope = makeScope(null, true);
  const declare = (identifier, scope, init, declaration) => {
    if (!identifier) return;
    if (identifier.type === 'Identifier') {
      let binding = scope.bindings.get(identifier.name);
      if (!binding) {
        binding = { name: identifier.name, node: identifier, init, declaration, scope, references: [] };
        scope.bindings.set(identifier.name, binding);
      } else if (init && !binding.init) Object.assign(binding, { init, declaration });
      declarations.set(identifier, binding);
    } else if (identifier.type === 'AssignmentPattern') declare(identifier.left, scope, init ?? identifier.right, declaration);
    else if (identifier.type === 'RestElement') declare(identifier.argument, scope, null, declaration);
    else if (identifier.type === 'ObjectPattern') {
      for (const field of identifier.properties) {
        if (field.type === 'RestElement') declare(field.argument, scope, null, declaration);
        else {
          const value = init ? { type: 'MemberExpression', object: init, property: field.key, computed: field.computed, optional: false, start: init.start, end: init.end } : null;
          if (value) synthesized.push(value);
          declare(field.value, scope, value, declaration);
        }
      }
    } else if (identifier.type === 'ArrayPattern') {
      identifier.elements.forEach((element, index) => {
        const value = init ? { type: 'MemberExpression', object: init, property: { type: 'Literal', value: index }, computed: true, optional: false, start: init.start, end: init.end } : null;
        if (value) synthesized.push(value);
        declare(element, scope, value, declaration);
      });
    }
  };
  const visit = (node, parent, scope) => {
    if (factory) { node.start--; node.end--; }
    nodes.push(node);
    if (parent) parents.set(node, parent);
    if (node.type === 'FunctionDeclaration' && node.id) declare(node.id, scope, node, node);
    if (node.type === 'ClassDeclaration' && node.id) declare(node.id, scope, node, node);
    if (isFunction(node)) {
      scope = makeScope(scope, true);
      if (node.type === 'FunctionExpression' && node.id) declare(node.id, scope, node, node);
      node.params.forEach(param => declare(param, scope, null, param));
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'].includes(node.type)) {
      scope = makeScope(scope);
      if (node.type === 'CatchClause') declare(node.param, scope, null, node);
    }
    scopes.set(node, scope);
    if (node.type === 'VariableDeclarator') {
      let target = scope;
      if (parent?.kind === 'var') while (!target.functionScope) target = target.parent;
      declare(node.id, target, node.init, node);
    }
    if (node.type === 'ImportDeclaration') node.specifiers.forEach(specifier => declare(specifier.local, scope, null, specifier));
    children(node).forEach(child => visit(child, node, scope));
  };
  visit(root, null, globalScope);
  for (const node of synthesized) { node.start = node.object.start; node.end = node.object.end; }
  const lookup = node => {
    if (node?.type !== 'Identifier') return null;
    if (declarations.has(node)) return declarations.get(node);
    let scope = scopes.get(node);
    while (scope) {
      if (scope.bindings.has(node.name)) return scope.bindings.get(node.name);
      scope = scope.parent;
    }
    return null;
  };
  const isReference = node => {
    if (node.type !== 'Identifier' || declarations.has(node)) return false;
    const parent = parents.get(node);
    if ((parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
      || (parent?.type === 'Property' && parent.key === node && !parent.computed)
      || ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type)) return false;
    return true;
  };
  for (const node of nodes) if (isReference(node)) lookup(node)?.references.push(node);
  const ast = {
    source, root, factory: factory ? root : null, nodes,
    parent: node => parents.get(node) ?? null,
    text: node => node == null ? '' : source.slice(node.start, node.end),
    all(predicate, within = root) {
      return nodes.filter(node => (node === within || node.start >= within.start && node.end <= within.end) && predicate(node));
    },
    find(predicate, within = root) { return this.all(predicate, within)[0] ?? null; },
    enclosing(node, predicate) {
      for (let current = parents.get(node); current; current = parents.get(current)) if (predicate(current)) return current;
      return null;
    },
    binding: lookup,
    references: binding => binding?.references ?? [],
    value(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return node;
      seen.add(node);
      if (node.type === 'Identifier') {
        const binding = lookup(node);
        return binding?.init ? this.value(binding.init, seen) : node;
      }
      if (node.type === 'MemberExpression') {
        const object = this.value(node.object, seen), name = propertyName(node);
        const field = propertyValue(object, name);
        if (field) return this.value(field, seen);
        if (object?.type === 'ArrayExpression' && node.computed && node.property.type === 'Literal') {
          return this.value(object.elements[node.property.value], seen);
        }
      }
      return node;
    },
    exports() {
      const result = new Map();
      const register = (name, value) => { if (name != null && value) result.set(name, value); };
      for (const node of nodes) {
        if (factory && root.params[2] && node.type === 'CallExpression' && propertyName(unwrap(node.callee)) === 'd'
          && lookup(unwrap(node.callee).object) === lookup(root.params[2]) && lookup(node.arguments[0]) === lookup(root.params[1])) {
          for (let index = 1; index < node.arguments.length; index++) {
            for (const field of this.value(node.arguments[index])?.properties ?? []) {
              if (field.type !== 'Property') continue;
              const value = field.value;
              register(propertyName(field), index === 1 && isFunction(value) && value.params.length === 0 ? returnValue(value) : value);
            }
          }
        }
        if (!factory && node.type === 'ExportNamedDeclaration') {
          for (const specifier of node.specifiers) register(propertyName(specifier.exported), specifier.local);
          const declaration = node.declaration;
          if (declaration?.type === 'VariableDeclaration') declaration.declarations.forEach(item => { if (item.id.type === 'Identifier') register(item.id.name, item.id); });
          else if (declaration?.id) register(declaration.id.name, declaration.id);
        }
        if (!factory && node.type === 'ExportDefaultDeclaration') register('default', node.declaration);
      }
      return result;
    },
    exportName(node) {
      const value = this.value(node), binding = lookup(node);
      const names = [...this.exports()].filter(([, target]) => target === node || binding && lookup(target) === binding || this.value(target) === value).map(([name]) => name);
      return names.length === 1 ? names[0] : null;
    },
  };
  // Keep bundle planning bounded; the cache is shared by the Node-side adapters only.
  if (useCache && nodes.length <= 100_000) {
    while (cache.size && (cache.size >= 128 || cachedNodes + nodes.length > 100_000)) {
      const oldest = cache.keys().next().value;
      cachedNodes -= cache.get(oldest).nodes.length;
      cache.delete(oldest);
    }
    cache.set(key, ast);
    cachedNodes += nodes.length;
  }
  return ast;
}
