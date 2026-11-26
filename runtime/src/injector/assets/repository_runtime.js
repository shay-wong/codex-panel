function createRepositoryBranchPrefixRuntime({ storage = globalThis.localStorage } = {}) {
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
