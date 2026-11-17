import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendInjectorControlRequest } from './codex-injector-control.mjs';

const states = new Set(['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']);
const imageLimit = 32 * 1024 * 1024;
const audioLimit = 16 * 1024 * 1024;
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
    if (animation.audio !== undefined && (typeof animation.audio !== 'string' || animation.audio.length > 240
      || !/^[^\\/:\x00-\x1f\x7f]+\.(?:m4a|mp3|wav|ogg)$/i.test(animation.audio))) {
      throw new Error(`${state} audio 必须是同目录的 M4A、MP3、WAV 或 Ogg 文件名`);
    }
    const frames = animation.frames.map(frame => {
      if (!Array.isArray(frame) || frame.length !== 2 || !validCell(frame[0]) || !Number.isInteger(frame[1]) || frame[1] < 1 || frame[1] > 60_000) {
        throw new Error(`${state} 帧须为有效的 [格子序号, 毫秒]`);
      }
      return [...frame];
    });
    frameCount += frames.length;
    animations[state] = { frames, loop: animation.loop ?? state === 'idle', ...(animation.audio ? { audio: animation.audio } : {}) };
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

function audioType(bytes, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.m4a' && bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length) return 'audio/mp4';
  if (extension === '.mp3' && bytes.length >= 4 && (bytes.toString('ascii', 0, 3) === 'ID3'
    || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)) return 'audio/mpeg';
  if (extension === '.wav' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (extension === '.ogg' && bytes.length >= 27 && bytes.toString('ascii', 0, 4) === 'OggS' && bytes[4] === 0) return 'audio/ogg';
  throw new Error(`音频内容与格式不符：${filename}`);
}

async function readAudio(directory, manifest) {
  const names = [...new Set(Object.values(manifest.animations).map(clip => clip.audio).filter(Boolean))];
  if (!names.length) return {};
  const root = await realpath(directory);
  return Object.fromEntries(await Promise.all(names.map(async name => {
    const file = await realpath(path.join(root, name));
    if (path.dirname(file) !== root) throw new Error('音频必须位于清单所在目录，不能链接到外部文件');
    const bytes = await readLimited(file, audioLimit);
    return [name, { bytes, type: audioType(bytes, name) }];
  })));
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

function animationKey(item, image, audio = {}) {
  return JSON.stringify([
    item.columns, item.rows, [...states].map(state => {
      const clip = item.animations[state];
      return clip ? [clip.frames, clip.loop, clip.audio && audio[clip.audio] ? createHash('sha256').update(audio[clip.audio].bytes).digest('hex') : null] : null;
    }), item.lookFrames ?? null,
    createHash('sha256').update(image).digest('hex'),
  ]);
}

function matchesBuiltinLumi(item, image, audio, builtinKeys) {
  const key = animationKey(item, image, audio);
  // The shipped silent Lumi pack keeps its identity when its preparation timing is updated.
  return builtinKeys.has(key) || createHash('sha256').update(key).digest('hex')
    === '6d49a3d4e2afe659baaf02b16b7b3cb5911ed0d745c130a9d700bf26c26b9c8d';
}

async function summaries(manifests, directory) {
  const builtin = validateManifest(JSON.parse(await readFile(path.join(lumiDirectory, 'animation.json'), 'utf8')));
  const builtinImage = await readImage(lumiDirectory, builtin);
  const builtinAudio = await readAudio(lumiDirectory, builtin);
  const builtinKeys = new Set([animationKey(builtin, builtinImage, builtinAudio), animationKey(builtin, builtinImage)]);
  const result = await Promise.all(manifests.map(async item => {
    const image = await readImage(directory, item);
    const matchesBuiltin = matchesBuiltinLumi(item, image, await readAudio(directory, item), builtinKeys);
    if (item.petId === builtin.petId && matchesBuiltin) return null;
    const [width, height] = imageDimensions(image, item.spritesheet);
    const format = path.extname(item.spritesheet).toLowerCase() === '.png' ? 'png' : 'webp';
    return {
      petId: item.petId, name: item.name, states: Object.keys(item.animations), hasLookFrames: Boolean(item.lookFrames),
      builtinLumi: item.petId === builtin.petId || matchesBuiltin,
      selectable: !item.petId.startsWith('pet_') && !item.petId.startsWith('custom:'),
      preview: {
        spritesheetUrl: `data:image/${format};base64,${image.toString('base64')}`,
        columns: item.columns, rows: item.rows, frame: item.animations.idle.frames[0][0],
        aspectRatio: width / item.columns / (height / item.rows),
      },
    };
  }));
  return result.filter(Boolean);
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

async function removeUnusedResources(directory, previous, next) {
  const resources = packs => new Set(packs.flatMap(item => [item.spritesheet, ...Object.values(item.animations).map(clip => clip.audio).filter(Boolean)]));
  const retained = resources(next);
  for (const file of resources(previous)) {
    if (/^[\da-f-]{36}\.(?:png|webp|m4a|mp3|wav|ogg)$/.test(file) && !retained.has(file)) {
      // The registry is already committed; leftover managed files must not turn success into failure.
      await unlink(path.join(directory, file)).catch(() => {});
    }
  }
}

export async function listPetAnimations(dataDirectory) {
  const directory = path.join(dataDirectory, 'pet-animations');
  return summaries(await readIndex(directory), directory);
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
  const builtinImage = await readImage(lumiDirectory, builtin);
  const builtinAudio = await readAudio(lumiDirectory, builtin);
  const builtinKeys = new Set([animationKey(builtin, builtinImage, builtinAudio), animationKey(builtin, builtinImage)]);
  const entries = manifests.map(manifest => ({ manifest, directory }));
  if (!manifests.some(manifest => manifest.petId === builtin.petId)) entries.push({ manifest: builtin, directory: lumiDirectory });
  return Promise.all(entries.map(async ({ manifest, directory: imageDirectory }) => {
    let image = await readImage(imageDirectory, manifest);
    let audio = await readAudio(imageDirectory, manifest);
    const matchesBuiltin = matchesBuiltinLumi(manifest, image, audio, builtinKeys);
    if (matchesBuiltin) {
      manifest = { ...builtin, petId: manifest.petId, name: manifest.name };
      image = builtinImage;
      audio = builtinAudio;
    }
    const format = path.extname(manifest.spritesheet).toLowerCase() === '.png' ? 'png' : 'webp';
    const animations = Object.fromEntries(Object.entries(manifest.animations).map(([state, clip]) => [state, {
      ...clip, ...(clip.audio ? { audioUrl: `data:${audio[clip.audio].type};base64,${audio[clip.audio].bytes.toString('base64')}` } : {}),
    }]));
    return { ...manifest, animations, builtinLumi: manifest.petId === builtin.petId || matchesBuiltin,
      spritesheetUrl: `data:image/${format};base64,${image.toString('base64')}` };
  }));
}

export async function importPetAnimation(dataDirectory, manifestPath) {
  const manifest = validateManifest(JSON.parse((await readLimited(manifestPath, 1024 * 1024)).toString('utf8')));
  const sourceDirectory = path.dirname(path.resolve(manifestPath));
  const image = await readImage(sourceDirectory, manifest);
  const audio = await readAudio(sourceDirectory, manifest);
  const builtin = validateManifest(JSON.parse(await readFile(path.join(lumiDirectory, 'animation.json'), 'utf8')));
  const builtinImage = await readImage(lumiDirectory, builtin);
  const builtinKeys = new Set([animationKey(builtin, builtinImage, await readAudio(lumiDirectory, builtin)), animationKey(builtin, builtinImage)]);
  if (manifest.petId === builtin.petId && matchesBuiltinLumi(manifest, image, audio, builtinKeys)) {
    return removePetAnimation(dataDirectory, manifest.petId);
  }
  const directory = path.join(dataDirectory, 'pet-animations');
  await mkdir(directory, { recursive: true });
  const previous = await readIndex(directory);
  const spritesheet = `${randomUUID()}${path.extname(manifest.spritesheet).toLowerCase()}`;
  const audioNames = Object.fromEntries(Object.keys(audio).map(name => [name, `${randomUUID()}${path.extname(name).toLowerCase()}`]));
  const animations = Object.fromEntries(Object.entries(manifest.animations).map(([state, clip]) => [state, {
    ...clip, ...(clip.audio ? { audio: audioNames[clip.audio] } : {}),
  }]));
  const next = [...previous.filter(item => item.petId !== manifest.petId), { ...manifest, spritesheet, animations }];
  if (next.length > 128) throw new Error('最多导入 128 个宠物动画包');
  const written = [];
  try {
    for (const [name, bytes] of [[spritesheet, image], ...Object.entries(audio).map(([name, resource]) => [audioNames[name], resource.bytes])]) {
      await writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
      written.push(name);
    }
    await writeIndex(directory, next);
  } catch (error) {
    for (const name of written) await unlink(path.join(directory, name)).catch(() => {});
    throw error;
  }
  await removeUnusedResources(directory, previous, next);
  return summaries(next, directory);
}

export async function removePetAnimation(dataDirectory, petId) {
  const directory = path.join(dataDirectory, 'pet-animations'), previous = await readIndex(directory);
  const next = previous.filter(item => item.petId !== petId);
  if (next.length !== previous.length) {
    await writeIndex(directory, next);
    await removeUnusedResources(directory, previous, next);
  }
  return summaries(next, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, dataDirectory, value] = process.argv.slice(2);
    if (!dataDirectory || !['list', 'import', 'remove', 'pet-selection', 'use-lumi', 'cancel-lumi', 'use-pet', 'cancel-pet'].includes(operation)
      || ['import', 'remove', 'use-pet', 'cancel-pet'].includes(operation) && !value) {
      throw new Error('用法：pet-animations.mjs list|pet-selection|use-lumi|cancel-lumi <数据目录> | import <数据目录> <清单路径> | remove|use-pet|cancel-pet <数据目录> <宠物 ID>');
    }
    const result = ['pet-selection', 'use-lumi', 'cancel-lumi', 'use-pet', 'cancel-pet'].includes(operation)
      ? await sendInjectorControlRequest({
        runtimeFile: path.join(dataDirectory, 'launcher-runtime.json'), action: operation,
        ...(['use-pet', 'cancel-pet'].includes(operation) ? { payload: { petId: value } } : {}),
        ownership: { nodePath: process.execPath, injectorPath: fileURLToPath(new URL('./codex-injector.mjs', import.meta.url)) },
      })
      : operation === 'list' ? await listPetAnimations(dataDirectory)
        : operation === 'import' ? await importPetAnimation(dataDirectory, value) : await removePetAnimation(dataDirectory, value);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
