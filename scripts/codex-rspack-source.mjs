import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const catalogs = new Map();
const nativeMarkers = ['CodexComposerAdapter', 'model_provider', 'serviceTierForRequest',
  'requiresFirstPartyInference', 'orbit-activity', 'paneItems', 'composerId:', 'tabById$', 'navigateToLocalConversation', 'getServerSnapshot'];

export function normalizeRspackFactory(source) {
  if (/^(?:async\s+)?function\b/.test(source)) return source;
  return source.replace(/^(async\s+)?[^ (]+\s*\(/, (_, prefix = '') => `${prefix}function(`);
}

export function rspackSourceContext(factories, selected = new Set()) {
  return {
    findModule(needles) {
      const terms = Array.isArray(needles) ? needles : [needles];
      const found = [...factories.values()].filter(module => terms.every(term => module.source.includes(term)));
      if (found.length !== 1) return null;
      selected.add(found[0].id);
      return found[0];
    },
    moduleSource(id) {
      const module = factories.get(id);
      if (module) selected.add(id);
      return module?.source ?? null;
    },
  };
}

export async function readCodexRspack(appPath) {
  if (!appPath) return null;
  const resources = appPath.endsWith('.app') ? path.join(appPath, 'Contents/Resources')
    : process.platform === 'linux' && appPath === '/usr/bin/chatgpt' ? '/usr/lib/chatgpt/resources'
      : path.join(path.dirname(appPath), 'resources');
  const archive = path.join(resources, 'app.asar');
  let details;
  try { details = await stat(archive); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const key = `${archive}:${details.size}:${details.mtimeMs}`;
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
      if (/export\s*\{[^}]*\bas\s+__webpack_require__\b/.test(source)) main = { urlPath, source };
    }
    if (!main) { catalogs.set(key, null); return null; }
    const factories = new Map();
    const unreadableChunks = [];
    for (const name of entries.keys()) {
      if (!/^webview\/assets\/.+\.js$/.test(name)) continue;
      const source = await sourceFor(name);
      if (!source.includes('export const __webpack_modules__=')) continue;
      if (!nativeMarkers.some(marker => source.includes(marker))) continue;
      // Rspack chunks declare factory objects; evaluating these declarations does not run their modules.
      const declarations = source.replace(/\bexport const (__rspack_esm_ids|__webpack_modules__|__rspack_esm_runtime)\b/g, 'var $1')
        .replaceAll('import.meta.url', JSON.stringify(`app://-/${name.slice('webview/'.length)}`));
      let chunk;
      try { chunk = vm.runInNewContext(`${declarations}\n;({modules:__webpack_modules__,ids:__rspack_esm_ids})`, {}, { timeout: 1000, filename: name }); }
      catch (error) { unreadableChunks.push({ name, message: error.message }); continue; }
      for (const [id, factory] of Object.entries(chunk.modules)) {
        if (typeof factory !== 'function') continue;
        const factorySource = normalizeRspackFactory(String(factory));
        const variant = { source: factorySource, chunkIds: [...chunk.ids], urlPath: name.slice('webview'.length), size: source.length };
        const previous = factories.get(id);
        if (!previous) factories.set(id, { id, ...variant, variants: [variant] });
        else {
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
