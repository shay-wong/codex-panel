import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendInjectorControlRequest } from './codex-injector-control.mjs';

const states = new Set(['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']);
const imageLimit = 32 * 1024 * 1024;
const lumiDirectory = fileURLToPath(new URL('../inject/pets/lumi/', import.meta.url));

function validateManifest(value) {
  if (!value || value.version !== 1) throw new Error('动画清单版本必须为 1');
  for (const key of ['petId', 'name']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 240 || /[\x00-\x1f\x7f]/.test(value[key])) {
      throw new Error(`动画清单 ${key} 无效`);
    }
  }
  if (typeof value.spritesheet !== 'string' || !/^[^\\/:\x00-\x1f\x7f]+\.(?:png|webp)$/i.test(value.spritesheet) || value.spritesheet.length > 240) {
    throw new Error('spritesheet 必须是同目录的 PNG 或 WebP 文件名');
  }
  for (const key of ['columns', 'rows']) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 64) throw new Error(`${key} 必须在 1–64 之间`);
  }
  const validCell = cell => Number.isInteger(cell) && cell >= 0 && cell < value.columns * value.rows;
  if (!value.animations || typeof value.animations !== 'object' || Array.isArray(value.animations) || !Object.hasOwn(value.animations, 'idle')) {
    throw new Error('动画清单必须包含 idle 动作');
  }
  const animations = {};
  let frameCount = 0;
  for (const [state, animation] of Object.entries(value.animations)) {
    if (!states.has(state)) throw new Error(`不支持的动画状态：${state}`);
    if (!animation || !Array.isArray(animation.frames) || !animation.frames.length || animation.frames.length > 10_000
      || animation.loop !== undefined && typeof animation.loop !== 'boolean') throw new Error(`${state} 动作无效`);
    const frames = animation.frames.map(frame => {
      if (!Array.isArray(frame) || frame.length !== 2 || !validCell(frame[0]) || !Number.isInteger(frame[1]) || frame[1] < 1 || frame[1] > 60_000) {
        throw new Error(`${state} 帧须为有效的 [格子序号, 毫秒]`);
      }
      return [...frame];
    });
    frameCount += frames.length;
    animations[state] = { frames, loop: animation.loop ?? state === 'idle' };
  }
  if (frameCount > 10_000) throw new Error('动画总帧数不能超过 10000');
  if (value.lookFrames !== undefined && (!Array.isArray(value.lookFrames) || value.lookFrames.length !== 16 || !value.lookFrames.every(validCell))) {
    throw new Error('lookFrames 必须包含 16 个有效格子序号');
  }
  return {
    version: 1, petId: value.petId, name: value.name, spritesheet: value.spritesheet,
    columns: value.columns, rows: value.rows, animations,
    ...(value.lookFrames ? { lookFrames: [...value.lookFrames] } : {}),
  };
}

async function readLimited(file, limit) {
  const details = await stat(file);
  if (!details.isFile() || details.size > limit) throw new Error(`文件无效或超过大小限制：${path.basename(file)}`);
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error(`文件超过大小限制：${path.basename(file)}`);
  return bytes;
}

function imageDimensions(bytes, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (extension === '.webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let canvas;
    let image;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8, end = start + length;
      if (end > bytes.length) throw new Error('WebP 图片内容不完整');
      if (type === 'VP8X' && length >= 10) {
        if (bytes[start] & 2) throw new Error('请使用静态 WebP 图集');
        canvas = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
      } else if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        image = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      } else if (type === 'VP8 ' && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
        image = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
      }
      offset = end + length % 2;
    }
    if (image) return canvas ?? image;
  }
  throw new Error('图集不是有效的 PNG 或静态 WebP 图片');
}

async function readImage(directory, manifest) {
  const root = await realpath(directory), file = await realpath(path.join(root, manifest.spritesheet));
  if (path.dirname(file) !== root) throw new Error('图集必须位于清单所在目录，不能链接到外部文件');
  const bytes = await readLimited(file, imageLimit);
  const [width, height] = imageDimensions(bytes, manifest.spritesheet);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 64 * 1024 * 1024
    || width % manifest.columns || height % manifest.rows) throw new Error('图集尺寸不能按指定行列均分');
  return bytes;
}

async function readIndex(directory) {
  let bytes;
  try { bytes = await readLimited(path.join(directory, 'index.json'), 4 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const values = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(values) || values.length > 128) throw new Error('本地动画列表无效');
  const manifests = values.map(validateManifest);
  if (new Set(manifests.map(item => item.petId)).size !== manifests.length) throw new Error('本地动画列表存在重复宠物');
  return manifests;
}

function summaries(manifests) {
  return manifests.map(item => ({ petId: item.petId, name: item.name, states: Object.keys(item.animations), hasLookFrames: Boolean(item.lookFrames) }));
}

async function writeIndex(directory, manifests) {
  const content = JSON.stringify(manifests, null, 2) + '\n';
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('动画清单总大小不能超过 4 MiB');
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(directory, 'index.json'));
  } finally { await unlink(temporary).catch(() => {}); }
}

async function removeUnusedImages(directory, previous, next) {
  for (const item of previous) {
    if (/^[\da-f-]{36}\.(?:png|webp)$/.test(item.spritesheet) && !next.some(pack => pack.spritesheet === item.spritesheet)) {
      // The registry is already committed; leftover managed files must not turn success into failure.
      await unlink(path.join(directory, item.spritesheet)).catch(() => {});
    }
  }
}

export async function listPetAnimations(dataDirectory) {
  return summaries(await readIndex(path.join(dataDirectory, 'pet-animations')));
}

export async function readBuiltinLumi() {
  const manifest = JSON.parse(await readFile(path.join(lumiDirectory, 'pet.json'), 'utf8'));
  const image = await readFile(path.join(lumiDirectory, manifest.spritesheetPath));
  return {
    id: manifest.id, displayName: manifest.displayName, description: manifest.description,
    spriteVersionNumber: manifest.spriteVersionNumber, spritesheetUrl: `data:image/webp;base64,${image.toString('base64')}`,
  };
}

export async function readPetAnimations(dataDirectory) {
  const directory = path.join(dataDirectory, 'pet-animations');
  const manifests = await readIndex(directory);
  const builtin = validateManifest(JSON.parse(await readFile(path.join(lumiDirectory, 'animation.json'), 'utf8')));
  const entries = manifests.map(manifest => ({ manifest, directory }));
  if (!manifests.some(manifest => manifest.petId === builtin.petId)) entries.push({ manifest: builtin, directory: lumiDirectory });
  return Promise.all(entries.map(async ({ manifest, directory: imageDirectory }) => {
    const image = await readImage(imageDirectory, manifest);
    const format = path.extname(manifest.spritesheet).toLowerCase() === '.png' ? 'png' : 'webp';
    return { ...manifest, spritesheetUrl: `data:image/${format};base64,${image.toString('base64')}` };
  }));
}

export async function importPetAnimation(dataDirectory, manifestPath) {
  const manifest = validateManifest(JSON.parse((await readLimited(manifestPath, 1024 * 1024)).toString('utf8')));
  const image = await readImage(path.dirname(path.resolve(manifestPath)), manifest);
  const directory = path.join(dataDirectory, 'pet-animations');
  await mkdir(directory, { recursive: true });
  const previous = await readIndex(directory);
  const spritesheet = `${randomUUID()}${path.extname(manifest.spritesheet).toLowerCase()}`;
  const next = [...previous.filter(item => item.petId !== manifest.petId), { ...manifest, spritesheet }];
  if (next.length > 128) throw new Error('最多导入 128 个宠物动画包');
  await writeFile(path.join(directory, spritesheet), image, { flag: 'wx', mode: 0o600 });
  try { await writeIndex(directory, next); }
  catch (error) { await unlink(path.join(directory, spritesheet)).catch(() => {}); throw error; }
  await removeUnusedImages(directory, previous, next);
  return summaries(next);
}

export async function removePetAnimation(dataDirectory, petId) {
  const directory = path.join(dataDirectory, 'pet-animations'), previous = await readIndex(directory);
  const next = previous.filter(item => item.petId !== petId);
  if (next.length !== previous.length) {
    await writeIndex(directory, next);
    await removeUnusedImages(directory, previous, next);
  }
  return summaries(next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, dataDirectory, value] = process.argv.slice(2);
    if (!dataDirectory || !['list', 'import', 'remove', 'use-lumi'].includes(operation) || ['import', 'remove'].includes(operation) && !value) {
      throw new Error('用法：pet-animations.mjs list <数据目录> | import <数据目录> <清单路径> | remove <数据目录> <宠物 ID> | use-lumi <数据目录>');
    }
    if (operation === 'use-lumi') {
      await sendInjectorControlRequest({
        runtimeFile: path.join(dataDirectory, 'launcher-runtime.json'), action: 'use-lumi',
        ownership: { nodePath: process.execPath, injectorPath: fileURLToPath(new URL('./codex-injector.mjs', import.meta.url)) },
      });
    }
    const result = operation === 'list' || operation === 'use-lumi' ? await listPetAnimations(dataDirectory)
      : operation === 'import' ? await importPetAnimation(dataDirectory, value) : await removePetAnimation(dataDirectory, value);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
