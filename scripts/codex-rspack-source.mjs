import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSync, visitorKeys } from 'oxc-parser';
import { sourceAst, unwrap, propertyName } from './codex-source-ast.mjs';

const catalogs = new Map();

export function normalizeRspackFactory(source) {
  if (/^(?:async\s+)?function\b/.test(source)) return source;
  return source.replace(/^(async\s+)?[^ (]+\s*\(/, (_, prefix = '') => `${prefix}function(`);
}

export function rspackSourceContext(factories, selected = new Set()) {
  const ids = new WeakMap();
  const asts = new Map();
  const sourceIds = new Map();
  for (const module of factories.values()) {
    for (const variant of module.variants ?? [module]) sourceIds.set(variant.source, module.id);
  }
  const imported = (ast, expression) => {
    expression = unwrap(expression);
    if (expression?.type === 'Identifier') expression = ast.value(expression);
    if (expression?.type !== 'MemberExpression') return null;
    const namespace = unwrap(ast.value(expression.object));
    const requireBinding = ast.binding(ast.factory?.params[2]);
    if (namespace?.type !== 'CallExpression' || namespace.arguments.length !== 1
      || namespace.arguments[0].type !== 'Literal' || !requireBinding || ast.binding(ast.value(unwrap(namespace.callee))) !== requireBinding) return null;
    const name = propertyName(expression);
    return name == null ? null : { id: String(namespace.arguments[0].value), exportName: name };
  };
  const context = {
    id(ast) { return ids.get(ast); },
    ast(source) {
      let ast = asts.get(source);
      if (!ast) { ast = sourceAst(source, { factory: true }); asts.set(source, ast); }
      const id = sourceIds.get(source) ?? this.moduleId;
      if (id != null) ids.set(ast, id);
      return ast;
    },
    moduleAst(id) {
      const source = this.moduleSource(id);
      return source == null ? null : this.ast(source);
    },
    modulesContaining(term) {
      return [...factories.values()].filter(module => module.source.includes(term));
    },
    modulesExporting(name) {
      return [...factories.values()].filter(module => module.exportNames ? module.exportNames.includes(name) : module.source.includes(name))
        .filter(module => this.moduleAst(module.id).exports().has(name));
    },
    resolve(ast, node) {
      const seen = new Set();
      for (;;) {
        const dependency = imported(ast, node);
        if (dependency) {
          const key = `${dependency.id}:${dependency.exportName}`;
          if (seen.has(key)) return { ast, node };
          seen.add(key);
          const targetAst = this.moduleAst(dependency.id);
          const target = targetAst?.exports().get(dependency.exportName);
          if (target) { ast = targetAst; node = target; continue; }
        }
        const value = ast.value(node);
        if (value === node) return { ast, node };
        node = value;
      }
    },
    exportOf(ast, node) {
      const dependency = imported(ast, node);
      if (dependency) { selected.add(dependency.id); return dependency; }
      const exportName = ast.exportName(node), id = ids.get(ast);
      if (exportName != null && id != null) { selected.add(id); return { id, exportName }; }
      const resolved = this.resolve(ast, node);
      if (resolved.ast !== ast) return this.exportOf(resolved.ast, resolved.node);
      return null;
    },
    moduleSource(id) {
      const module = factories.get(id);
      if (module) selected.add(id);
      return module?.source ?? null;
    },
  };
  return context;
}

export async function readCodexRspackIdentity(appPath) {
  if (!appPath) return null;
  const resources = appPath.endsWith('.app') ? path.join(appPath, 'Contents/Resources')
    : process.platform === 'linux' && appPath === '/usr/bin/chatgpt' ? '/usr/lib/chatgpt/resources'
      : path.join(path.dirname(appPath), 'resources');
  let archive = path.join(resources, 'app.asar');
  let details;
  try { archive = await realpath(archive); details = await stat(archive); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const key = JSON.stringify([archive, details.size, details.mtimeMs, details.ctimeMs, details.dev, details.ino]);
  return { archive, key, size: details.size };
}

export async function readCodexRspack(appPath) {
  const identity = await readCodexRspackIdentity(appPath);
  if (!identity) return null;
  const { archive, key } = identity;
  const details = identity;
  if (catalogs.has(key)) return catalogs.get(key);
  const file = await open(archive, 'r');
  try {
    const read = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, offset);
      if (bytesRead !== length) throw new Error('Codex app.asar 内容不完整');
      return bytes;
    };
    const prefix = await read(0, 16);
    const headerSize = prefix.readUInt32LE(4), jsonLength = prefix.readUInt32LE(12);
    if (jsonLength > headerSize || headerSize + 8 > details.size) throw new Error('Codex app.asar 索引无效');
    const header = JSON.parse((await read(16, jsonLength)).toString());
    const entries = new Map();
    const walk = (tree, parent = '') => {
      for (const [name, entry] of Object.entries(tree.files ?? {})) {
        const nameInArchive = parent ? `${parent}/${name}` : name;
        if (entry.files) walk(entry, nameInArchive);
        else entries.set(nameInArchive, entry);
      }
    };
    walk(header);
    const sourceFor = async name => {
      const entry = entries.get(name);
      if (!entry || entry.unpacked || entry.link) throw new Error(`Codex 资源不可读取：${name}`);
      const offset = Number(entry.offset), length = entry.size;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || headerSize + 8 + offset + length > details.size) throw new Error(`Codex 资源索引无效：${name}`);
      return (await read(headerSize + 8 + offset, length)).toString();
    };
    const html = await sourceFor('webview/index.html');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/g)].map(match => match[1]);
    let main;
    for (const urlPath of scripts) {
      const source = await sourceFor(`webview/${urlPath.replace(/^\//, '')}`);
      if (!source.includes('__webpack_require__')) continue;
      const ast = sourceAst(source, { cache: false });
      if (ast.exports().has('__webpack_require__')) main = { urlPath, source };
    }
    if (!main) { catalogs.set(key, null); return null; }
    const factories = new Map();
    const unreadableChunks = [];
    for (const name of entries.keys()) {
      if (!name.startsWith('webview/') || !name.endsWith('.js')) continue;
      const source = await sourceFor(name);
      if (!source.includes('__webpack_modules__')) continue;
      let modules, chunkIds;
      try {
        const parsed = parseSync(name, source, { sourceType: 'module', preserveParens: false });
        if (parsed.errors.length) throw new Error(parsed.errors[0].message);
        const declarations = parsed.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations : []);
        modules = declarations.find(node => node.id.name === '__webpack_modules__')?.init;
        if (!modules) continue;
        const ids = declarations.find(node => node.id.name === '__rspack_esm_ids')?.init;
        if (modules?.type !== 'ObjectExpression' || ids?.type !== 'ArrayExpression' || ids.elements.some(node => node.type !== 'Literal')) throw new Error('Unsupported Rspack chunk exports');
        chunkIds = ids.elements.map(node => node.value);
      } catch (error) { unreadableChunks.push({ name, message: error.message }); continue; }
      for (const field of modules.properties) {
        if (field.type !== 'Property' || !['FunctionExpression', 'ArrowFunctionExpression'].includes(field.value.type)) continue;
        const id = propertyName(field);
        const exportNames = new Set();
        const require = field.value.params[2], exports = field.value.params[1];
        const exported = node => {
          if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'd'
            && require?.type === 'Identifier' && node.callee.object.type === 'Identifier' && node.callee.object.name === require.name
            && exports?.type === 'Identifier' && node.arguments[0]?.type === 'Identifier' && node.arguments[0].name === exports.name) {
            for (const object of node.arguments.slice(1)) for (const item of object.properties ?? []) {
              if (item.type === 'Property') exportNames.add(propertyName(item));
            }
          }
          if (node !== field.value && ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(node.type)) return;
          for (const key of visitorKeys[node.type] ?? []) {
            const value = node[key];
            if (Array.isArray(value)) value.forEach(child => { if (child?.type) exported(child); });
            else if (value?.type) exported(value);
          }
        };
        exported(field.value);
        let factorySource = source.slice(field.value.start, field.value.end);
        if (field.method) factorySource = `function${factorySource}`;
        const variant = { source: factorySource, chunkIds, urlPath: name.slice('webview'.length), size: source.length };
        const previous = factories.get(id);
        if (!previous) factories.set(id, { id, ...variant, exportNames: [...exportNames], variants: [variant] });
        else {
          previous.exportNames = [...new Set([...previous.exportNames, ...exportNames])];
          if (!previous.variants.some(item => item.source === factorySource)) previous.variants.push(variant);
          if (variant.size < previous.size) Object.assign(previous, variant);
        }
      }
    }
    const result = { main, factories, unreadableChunks };
    catalogs.clear();
    catalogs.set(key, result);
    return result;
  } finally { await file.close(); }
}
