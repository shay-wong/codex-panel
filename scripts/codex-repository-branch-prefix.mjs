import { applyEdits, isFunction, propertyName, propertyValue, returnValue, sourceAst, unique, unwrap } from './codex-source-ast.mjs';

// Serialized into the renderer. Repository overrides never mutate Codex's global setting.
export function createRepositoryBranchPrefixRuntime({ storage = globalThis.localStorage } = {}) {
  const storageKey = 'codex-panel.repository-branch-prefixes.v1';
  const read = () => {
    try {
      const value = JSON.parse(storage?.getItem(storageKey) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  let entries = read();
  const own = id => Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined;
  const valid = entry => entry && typeof entry.prefix === 'string' && entry.prefix.length <= 200
    && !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(entry.prefix) && !/\.\.|@\{/.test(entry.prefix) && typeof entry.hostId === 'string'
    && Array.isArray(entry.rootPaths) && entry.rootPaths.every(root => typeof root === 'string');
  const normalize = value => {
    if (typeof value !== 'string') return '';
    const path = value.replace(/\\/g, '/').replace(/\/+$/, '') || (value.startsWith('/') ? '/' : '');
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
  };
  const match = ({ projectId, hostId = 'local', cwd, assignment } = {}) => {
    if (assignment) {
      projectId = assignment.projectId;
      hostId = assignment.projectKind === 'local' ? 'local' : assignment.hostId ?? hostId;
    }
    const exact = projectId == null ? undefined : own(projectId);
    if (projectId != null) return valid(exact) && exact.hostId === hostId ? exact : undefined;
    const path = normalize(cwd);
    if (!path) return undefined;
    let result, length = -1;
    for (const entry of Object.values(entries)) {
      if (!valid(entry) || entry.hostId !== hostId) continue;
      for (const value of entry.rootPaths) {
        const root = normalize(value);
        if (root && root.length > length && (path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))) {
          result = entry;
          length = root.length;
        }
      }
    }
    return result;
  };
  const write = next => {
    storage?.setItem(storageKey, JSON.stringify(next));
    entries = next;
  };
  const appendInstructions = (instructions, entry) => {
    const instruction = entry.prefix === ''
      ? 'Create branches without any prefix; do not prepend the global default or codex/.'
      : `For this repository, use the branch prefix ${JSON.stringify(entry.prefix)} instead of the global branch-prefix default.`;
    const block = `<repository-branch-prefix>\n${instruction}\nFollow the user's explicit request if they ask for a different branch name or prefix.\n</repository-branch-prefix>`;
    const original = (instructions ?? '').replace(/(?:\n\n)?<repository-branch-prefix>\n[\s\S]*?\n<\/repository-branch-prefix>/g, '');
    return original ? `${original}\n\n${block}` : block;
  };
  globalThis.addEventListener?.('storage', event => {
    if (event.key === storageKey && (!event.storageArea || event.storageArea === storage)) {
      entries = read();
    }
  });
  return {
    storageKey,
    list: () => entries,
    get: projectId => { const entry = own(projectId); return valid(entry) ? entry : undefined; },
    set(projectId, entry) {
      if (typeof projectId !== 'string' || !projectId || !valid(entry)) throw Error('分支前缀不合法：请使用不含空白或 Git 特殊字符的前缀（最多 200 个字符）');
      write({ ...entries, [projectId]: { prefix: entry.prefix, hostId: entry.hostId, rootPaths: [...entry.rootPaths] } });
    },
    remove(projectId) {
      if (!Object.prototype.hasOwnProperty.call(entries, projectId)) return;
      const next = { ...entries };
      delete next[projectId];
      write(next);
    },
    resolve(context, fallback) { return match(context)?.prefix ?? fallback; },
    prepareConversation(options, hostId = 'local') {
      const assignment = options.projectAssignment;
      const projectHostId = assignment?.projectKind === 'local' ? 'local' : assignment?.hostId ?? hostId;
      const entry = match({ projectId: assignment?.projectId, hostId: projectHostId, cwd: options.cwd });
      if (!entry) return options;
      return { ...options, additionalDeveloperInstructions: appendInstructions(options.additionalDeveloperInstructions, entry) };
    },
    prepareDeveloperInstructions(request, result, assignment) {
      // The membership identifies a repository even when its chat runs in a separate worktree.
      if (request.threadId == null) return result;
      const hostId = assignment?.projectKind === 'local' ? 'local' : assignment?.hostId ?? request.hostId;
      const entry = match({ ...request, projectId: assignment?.projectId, hostId });
      return entry ? { ...result, instructions: appendInstructions(result.instructions, entry) } : result;
    },
  };
}

const runtime = 'globalThis.__codexPanelRepositoryBranchPrefixV1__';
const same = (ast, left, right) => left === right || left?.type === 'Identifier' && right?.type === 'Identifier'
  && ast.binding(left) != null && ast.binding(left) === ast.binding(right);
const fnOf = (ast, node) => ast.enclosing(node, isFunction);
const member = (node, name) => unwrap(node)?.type === 'MemberExpression' && propertyName(unwrap(node)) === name;
const ownNodes = (ast, fn, predicate) => ast.all(node => predicate(node) && fnOf(ast, node) === fn, fn.body);
const membershipReaders = new WeakMap();

function membershipBindings(context) {
  if (membershipReaders.has(context)) return membershipReaders.get(context);
  const candidates = [];
  for (const module of context.modulesContaining('readMemberships')) {
    const ast = context.moduleAst(module.id);
    const keyRefs = ast.all(node => member(node, 'THREAD_PROJECT_ASSIGNMENTS'))
      .map(node => context.exportOf(ast, node.object)).filter(Boolean);
    if (!keyRefs.length || !ast.all(node => node.type === 'CallExpression' && member(node.callee, 'readMemberships')).length) continue;
    const keyRef = unique([...new Map(keyRefs.map(ref => [JSON.stringify(ref), ref])).values()], 'Native repository membership key is ambiguous');
    for (const [, exported] of ast.exports()) {
      const fn = ast.value(exported), result = returnValue(fn);
      if (!isFunction(fn) || fn.params.length !== 2 || result?.type !== 'CallExpression' || !same(ast, result.callee, fn.params[0])) continue;
      const parsed = result.arguments[0];
      const signals = ast.all(node => node.type === 'Property' && propertyName(node) === 'data' && node.value.type === 'CallExpression'
        && node.value.arguments.some(argument => same(ast, argument, parsed)))
        .map(field => ast.enclosing(field, node => node.type === 'VariableDeclarator')?.id).filter(Boolean);
      const data = signals.map(node => context.exportOf(ast, node)).filter(Boolean);
      const read = context.exportOf(ast, exported);
      if (data.length === 1 && read) candidates.push({ read, data: unique(data), key: keyRef });
    }
  }
  const result = unique(candidates, 'Native repository membership signal is unavailable');
  membershipReaders.set(context, result);
  return result;
}

function parameterPatterns(ast, fn) {
  const parameter = unwrap(fn.params[0]);
  if (parameter?.type === 'ObjectPattern') return [parameter];
  return ownNodes(ast, fn, node => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern'
    && same(ast, ast.value(node.init), parameter)).map(node => node.id);
}

function threadContext(ast, fn, hook) {
  const contexts = [];
  for (const pattern of parameterPatterns(ast, fn)) {
    const id = propertyValue(pattern, 'conversationId');
    if (id && id.start < hook.start) contexts.push({ expression: ast.text(id), edits: [] });
    const target = propertyValue(pattern, 'target');
    if (!id && target?.type === 'Identifier' && target.start < hook.start
      && ownNodes(ast, fn, node => member(node, 'conversationId') && same(ast, node.object, target)).length) {
      contexts.push({ expression: `${ast.text(target)}.conversationId`, edits: [] });
    }
  }
  if (contexts.length) return unique(contexts, 'Native repository conversation context is ambiguous');
  const parameter = fn.params[0];
  if (parameter?.type !== 'Identifier') return null;
  if (ast.all(node => member(node, 'threadId') && same(ast, node.object, parameter), fn.body).length) {
    return { expression: `${ast.text(parameter)}.threadId`, edits: [] };
  }
  if (!ast.all(node => member(node, 'scope') && same(ast, node.object, parameter), hook).length && fn.id) {
    const callers = ast.all(node => node.type === 'CallExpression' && same(ast, node.arguments[0], fn.id));
    if (callers.length !== 1) return null;
    const caller = callers[0], owner = fnOf(ast, caller), props = caller.arguments[1];
    const threads = parameterPatterns(ast, owner).map(pattern => propertyValue(pattern, 'localConversationId')).filter(Boolean);
    if (!threads.length || props?.type !== 'ObjectExpression') return null;
    const id = unique(threads, 'Native branch dialog conversation is ambiguous');
    const assignment = ast.enclosing(caller, node => node.type === 'AssignmentExpression' && node.left.type === 'Identifier');
    const cache = assignment && ast.enclosing(assignment, node => node.type === 'ConditionalExpression'
      && unwrap(node.alternate)?.type === 'AssignmentExpression' && same(ast, unwrap(node.alternate).left, assignment.left));
    if (!cache) return null;
    // Read the ID outside the compiler's cached props expression on every caller render.
    return { expression: `${ast.text(parameter)}.panelRepositoryThreadId`, edits: [{ start: cache.start, end: cache.end,
      text: `${ast.text(assignment.left)}=((panelBranchElement)=>(panelBranchElement?{...panelBranchElement,props:{...panelBranchElement.props,panelRepositoryThreadId:${ast.text(id)}}}:panelBranchElement))(${ast.text(cache)})` }] };
  }
  return null;
}

function creationEdits(ast) {
  const candidates = [];
  for (const call of ast.all(node => node.type === 'CallExpression' && member(node.callee, 'startConversation'))) {
    const fn = fnOf(ast, call), options = fn?.params[2], host = fn?.params[1];
    if (!fn?.async || fn.body.type !== 'BlockStatement' || options?.type !== 'Identifier' || host?.type !== 'Identifier') continue;
    const request = unwrap(call.arguments[0]), callbacks = unwrap(call.arguments[1]);
    if (request?.type !== 'ObjectExpression' || callbacks?.type !== 'ObjectExpression' || !propertyValue(callbacks, 'worktreeInit')) continue;
    if (!request.properties.some(field => field.type === 'SpreadElement' && same(ast, ast.value(field.argument), options))) continue;
    const reader = propertyValue(callbacks, 'readThreadCreationInputs');
    if (!reader || !ast.all(node => node.type === 'CallExpression' && member(node.callee, 'readCreationInputs'), reader).length) continue;
    if (!ast.all(node => member(node, 'projectAssignment') && same(ast, ast.value(node.object), options), fn.body).length) continue;
    candidates.push({ fn, options, host });
  }
  if (!candidates.length) return [];
  const { fn, options, host } = unique(candidates, 'Native conversation creation for repository branch prefixes is ambiguous');
  const start = fn.body.body.filter(node => node.directive).at(-1)?.end ?? fn.body.start + 1;
  const name = ast.text(options);
  return [{ start, end: start, text: `${name}=${runtime}?.prepareConversation(${name},${ast.text(host)})??${name};` }];
}

function scopeForPrefix(ast, fn, hook) {
  const contexts = [];
  const available = node => ast.all(value => value.type === 'Identifier', node).every(value => {
    const binding = ast.binding(value);
    return !binding || binding.declaration?.start < hook.start;
  });
  for (const node of ownNodes(ast, fn, node => ['ObjectPattern', 'ObjectExpression'].includes(node.type)
    && propertyValue(node, 'cwd') && propertyValue(node, 'hostConfig'))) {
    const cwd = propertyValue(node, 'cwd'), host = propertyValue(node, 'hostConfig');
    if (available(cwd) && available(host)) contexts.push({ cwd: ast.text(cwd), host: `${ast.text(host)}.id` });
  }
  // Handoff branch naming receives the same proven cwd/hostConfig context as its callers.
  if (!contexts.length && fn.params[0]?.type === 'Identifier') {
    const parameter = fn.params[0];
    const scopedRead = ast.all(node => node.type === 'MemberExpression' && propertyName(node) === 'scope'
      && same(ast, node.object, parameter), hook);
    const calls = ast.all(node => node.type === 'CallExpression' && same(ast, node.callee, fn.id));
    if (scopedRead.length && calls.length && calls.every(call => {
      const argument = call.arguments[0], owner = fnOf(ast, call);
      return argument?.type === 'Identifier' && owner && ['cwd', 'hostConfig'].every(name => ast.all(node => member(node, name)
        && same(ast, node.object, argument), owner.body).length);
    })) contexts.push({ cwd: `${ast.text(parameter)}.cwd`, host: `${ast.text(parameter)}.hostConfig.id` });
  }
  const distinct = [...new Map(contexts.map(context => [JSON.stringify(context), context])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

function prefixEdits(ast, context) {
  const edits = [];
  let requireName = 'panelRepositoryRequire';
  while (ast.all(node => node.type === 'Identifier' && node.name === requireName).length) requireName += '_';
  for (const hook of ast.all(node => node.type === 'CallExpression' && node.arguments.some(argument => member(argument, 'branchPrefix')))) {
    const fn = fnOf(ast, hook);
    if (!fn) continue;
    const declaration = ast.enclosing(hook, node => node.type === 'VariableDeclarator');
    if (declaration?.id.type !== 'Identifier') continue;
    const usedForBranch = ownNodes(ast, fn, node => node.type === 'ObjectExpression' && propertyValue(node, 'conversationTitle')
      && same(ast, propertyValue(node, 'branchPrefix'), declaration.id));
    if (!usedForBranch.length) continue; // The global GitSettings field remains global.
    const scope = scopeForPrefix(ast, fn, hook);
    if (!scope) continue;
    const thread = context && threadContext(ast, fn, hook);
    let assignment = '';
    if (thread) {
      const refs = membershipBindings(context);
      const ref = value => `${requireName}(${JSON.stringify(value.id)})[${JSON.stringify(value.exportName)}]`;
      const read = `${ref(refs.read)}`, key = `${ref(refs.key)}.THREAD_PROJECT_ASSIGNMENTS`;
      const parameter = fn.params[0];
      const scoped = parameter?.type === 'Identifier' && ast.all(node => member(node, 'scope') && same(ast, node.object, parameter), hook).length;
      if (scoped) assignment = `,assignment:${read}(${ast.text(parameter)}.scope.get,${key})?.[${thread.expression}]`;
      else {
        const settings = context.resolve(ast, hook.callee), reader = settings && settings.ast.value(settings.node);
        const nativeHook = reader && unwrap(returnValue(reader));
        const hookRef = nativeHook?.type === 'CallExpression' && context.exportOf(settings.ast, nativeHook.callee);
        if (!hookRef) throw Error('Native repository membership hook is unavailable');
        assignment = `,assignment:${ref(hookRef)}(${ref(refs.data)},${key}).data?.[${thread.expression}]`;
      }
      edits.push(...thread.edits);
    }
    edits.push({ start: hook.start, end: hook.end,
      text: `((panelGlobalPrefix,panelAssignment)=>${runtime}?.resolve({cwd:${scope.cwd},hostId:${scope.host},assignment:panelAssignment},panelGlobalPrefix)??panelGlobalPrefix)(${ast.text(hook)}${assignment ? `,${assignment.slice(',assignment:'.length)}` : ''})` });
  }
  if (edits.some(edit => edit.text.includes(`${requireName}(`))) {
    const start = ast.factory.body.body.filter(node => node.directive).at(-1)?.end ?? ast.factory.body.start + 1;
    edits.push({ start, end: start, text: `const ${requireName}=${ast.text(ast.factory.params[2])};` });
  }
  return edits;
}

function developerInstructionEdits(ast) {
  const candidates = ast.all(node => node.type === 'CallExpression' && member(node.callee, 'readDeveloperInstructions')).filter(call => {
    const fn = fnOf(ast, call), parameter = fn?.params[0];
    if (fn?.params.length !== 1 || parameter?.type !== 'Identifier' || !same(ast, call.arguments[0], parameter)) return false;
    const service = unwrap(ast.value(unwrap(call.callee).object));
    return member(service, 'threadConfiguration') && member(unwrap(service.object), 'appServices')
      && ast.parent(call)?.type === 'ReturnStatement';
  });
  if (!candidates.length) return [];
  const call = unique(candidates, 'Native developer instruction service for repository branch prefixes is ambiguous');
  const service = unwrap(ast.value(unwrap(call.callee).object));
  const services = ast.text(service.object), request = ast.text(call.arguments[0]);
  return [{ start: call.start, end: call.end,
    text: `Promise.resolve(${ast.text(call)}).then(async panelInstructions=>{let panelMemberships;try{if(${request}.threadId!=null)panelMemberships=await ${services}.threadProjectAssignments?.readMemberships()}catch{}return ${runtime}?.prepareDeveloperInstructions(${request},panelInstructions,panelMemberships?.assignments?.[${request}.threadId])??panelInstructions})` }];
}

export function rewriteRspackRepositoryBranchPrefix(source, context) {
  if (source.includes('__codexPanelRepositoryBranchPrefixV1__') || !['branchPrefix', 'readCreationInputs', 'readDeveloperInstructions'].some(term => source.includes(term))) return null;
  const ast = context?.ast(source) ?? sourceAst(source, { factory: true });
  const edits = [...creationEdits(ast), ...prefixEdits(ast, context), ...developerInstructionEdits(ast)];
  return edits.length ? applyEdits(source, edits) : null;
}
