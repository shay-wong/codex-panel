import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { propertyName, sourceAst } from './codex-source-ast.mjs';

const require = createRequire(import.meta.url);
const featureNames = ['quota', 'ultrafast', 'dot', 'tabs', 'queue', 'pets', 'projectlessChat', 'repositoryBranchPrefix'];

export async function getCodexRspackRevisions({ scriptsDirectory = fileURLToPath(new URL('.', import.meta.url)) } = {}) {
  const modules = new Map(), packages = new Map();
  const load = async filename => {
    if (!modules.has(filename)) modules.set(filename, (async () => {
      const source = await readFile(path.join(scriptsDirectory, filename), 'utf8');
      const ast = sourceAst(source, { cache: false }), bindings = new Map();
      for (const statement of ast.root.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        const nodes = declaration?.type === 'VariableDeclaration' ? declaration.declarations
          : declaration?.type === 'ImportDeclaration' ? declaration.specifiers : declaration?.id ? [declaration] : [];
        for (const node of nodes) {
          const identifier = node.type.startsWith('Import') ? node.local : node.id;
          if (identifier?.type === 'Identifier') bindings.set(ast.binding(identifier), node);
        }
      }
      return { ast, bindings };
    })());
    return modules.get(filename);
  };
  const packageVersion = async name => {
    if (!packages.has(name)) packages.set(name, readFile(require.resolve(`${name}/package.json`), 'utf8')
      .then(source => JSON.parse(source).version));
    return packages.get(name);
  };
  const digest = async (entries, feature) => {
    const parts = new Map();
    const visit = async (filename, binding) => {
      const key = `${filename}:${binding.name}`;
      if (parts.has(key)) return;
      const { ast, bindings } = await load(filename), declaration = bindings.get(binding);
      if (!declaration) throw new Error(`Missing adapter dependency: ${key}`);
      if (declaration.type.startsWith('Import')) {
        const source = ast.parent(declaration).source.value;
        parts.set(key, [source, ast.text(declaration)]);
        if (source.startsWith('.')) {
          const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), source));
          const target = await load(dependency);
          const exportedName = declaration.type === 'ImportDefaultSpecifier' ? 'default' : propertyName(declaration.imported);
          if (!exportedName) throw new Error(`Unsupported adapter namespace import: ${key}`);
          const exported = target.ast.exports().get(exportedName);
          const targetBinding = exported && target.ast.binding(exported);
          if (!targetBinding) throw new Error(`Missing adapter export: ${dependency}:${exportedName}`);
          await visit(dependency, targetBinding);
        } else if (!source.startsWith('node:')) {
          const packageName = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
          parts.set(`package:${packageName}`, await packageVersion(packageName));
        }
        return;
      }
      let node = declaration;
      if (feature && filename === 'codex-rspack.mjs' && ['transformers', 'featureTerms'].includes(binding.name)) {
        node = declaration.init?.properties?.find(field => propertyName(field) === feature);
        if (!node) throw new Error(`Missing adapter configuration: ${binding.name}.${feature}`);
      }
      parts.set(key, [ast.parent(declaration)?.kind ?? declaration.type, ast.text(node)]);
      const dependencies = new Set();
      for (const identifier of ast.all(node => node.type === 'Identifier', node)) {
        const dependency = ast.binding(identifier);
        if (bindings.has(dependency) && ast.references(dependency).includes(identifier)) dependencies.add(dependency);
      }
      for (const dependency of dependencies) await visit(filename, dependency);
    };
    for (const [filename, name] of entries) {
      const { ast } = await load(filename), exported = ast.exports().get(name);
      const binding = exported && ast.binding(exported);
      if (!binding) throw new Error(`Missing adapter entry: ${filename}:${name}`);
      await visit(filename, binding);
    }
    return createHash('sha256').update(JSON.stringify([1, process.versions.node, [...parts].toSorted(([a], [b]) => a.localeCompare(b))])).digest('hex');
  };
  const catalog = await digest(['readCodexRspack', 'shareRspackCatalog', 'sharedRspackCatalog']
    .map(name => ['codex-rspack-source.mjs', name]));
  const features = {};
  for (const feature of featureNames) features[feature] = await digest([['codex-rspack.mjs', 'buildRspackFeaturePlan']], feature);
  features.nativeUpdate = await digest([['codex-rspack.mjs', 'buildRspackUpdatePlan']]);
  features.nativeServices = await digest([['codex-rspack.mjs', 'buildRspackServicePlan']]);
  const compose = await digest([['codex-rspack.mjs', 'composeRspackFeaturePlans']]);
  return { catalog, features, compose };
}
