import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { importPetAnimation, listPetAnimations, readBuiltinLumi, readPetAnimations, removePetAnimation } from '../scripts/pet-animations.mjs';

function png() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(18, 255); pixels[0] = 0; pixels[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-pet-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), data = path.join(root, 'data');
  await mkdir(source);
  await writeFile(path.join(source, 'spritesheet.png'), png());
  const manifest = {
    version: 1, petId: 'test-pet', name: 'Test pet', spritesheet: 'spritesheet.png', columns: 2, rows: 2,
    animations: { idle: { frames: [[0, 120], [1, 120]], loop: true }, jumping: { frames: [[2, 90], [3, 90]], loop: false } },
    lookFrames: Array.from({ length: 16 }, (_, index) => index % 4),
  };
  const file = path.join(source, 'animation.json');
  const save = () => writeFile(file, JSON.stringify(manifest));
  await save();
  return { root, source, data, manifest, file, save };
}

async function builtinManifest(source, pack) {
  const { spritesheetUrl, builtinLumi, ...manifest } = structuredClone(pack);
  manifest.spritesheet = 'lumi.webp';
  await writeFile(path.join(source, manifest.spritesheet), Buffer.from(spritesheetUrl.split(',')[1], 'base64'));
  for (const clip of Object.values(manifest.animations)) {
    if (clip.audio) await writeFile(path.join(source, clip.audio), Buffer.from(clip.audioUrl.split(',')[1], 'base64'));
    delete clip.audioUrl;
  }
  return manifest;
}

test('imports a self-contained animation pack, updates one pet, and removes only its managed resources', async t => {
  const { source, data, file, manifest, save } = await fixture(t);
  assert.deepEqual(await listPetAnimations(data), []);
  const lumi = await readBuiltinLumi();
  assert.equal(lumi.id, 'panel-lumi');
  assert.equal(lumi.spriteVersionNumber, 2);
  const [builtin] = await readPetAnimations(data);
  assert.equal(builtin.petId, lumi.id);
  assert.equal(builtin.animations.jumping.frames.reduce((total, frame) => total + frame[1], 0), 18_750);
  assert.match(builtin.animations.jumping.audioUrl, /^data:audio\/mp4;base64,/);
  const audio = Buffer.from(builtin.animations.jumping.audioUrl.split(',')[1], 'base64');
  await writeFile(path.join(source, 'dance.m4a'), audio);
  manifest.animations.jumping.audio = 'dance.m4a';
  await save();
  const imported = await importPetAnimation(data, file);
  assert.deepEqual(imported, [{
    petId: 'test-pet', name: 'Test pet', states: ['idle', 'jumping'], hasLookFrames: true, builtinLumi: false, selectable: true,
    preview: { spritesheetUrl: `data:image/png;base64,${png().toString('base64')}`, columns: 2, rows: 2, frame: 0, aspectRatio: 1 },
  }]);
  assert.deepEqual(await listPetAnimations(data), imported);
  const [first] = await readPetAnimations(data);
  assert.equal(first.columns, 2);
  assert.deepEqual(first.animations.jumping.frames, manifest.animations.jumping.frames);
  assert.equal(first.animations.jumping.loop, false);
  assert.ok(Buffer.from(first.animations.jumping.audioUrl.split(',')[1], 'base64').equals(audio));
  assert.ok(Buffer.from(first.spritesheetUrl.split(',')[1], 'base64').equals(png()));
  const directory = path.join(data, 'pet-animations');
  await writeFile(path.join(directory, 'user-note.txt'), 'keep');

  manifest.petId = 'second-pet';
  await save();
  await importPetAnimation(data, file);
  manifest.petId = 'test-pet'; manifest.name = 'Updated';
  manifest.animations.idle.frames = [[3, 200]];
  await save();
  const updated = await importPetAnimation(data, file);
  assert.equal(updated.length, 2);
  assert.equal(updated.find(item => item.petId === 'test-pet').name, 'Updated');
  assert.equal(updated.find(item => item.petId === 'test-pet').preview.frame, 3);
  assert.ok(!(await readdir(directory)).includes(first.spritesheet));
  assert.ok(!(await readdir(directory)).includes(first.animations.jumping.audio));
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.png')).length, 2);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.m4a')).length, 2);
  assert.deepEqual((await removePetAnimation(data, 'test-pet')).map(item => item.petId), ['second-pet']);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.png')).length, 1);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.m4a')).length, 1);
  assert.ok((await readFile(path.join(source, 'dance.m4a'))).equals(audio));
  assert.equal(await readFile(path.join(directory, 'user-note.txt'), 'utf8'), 'keep');
});

test('groups identical Lumi imports with the built-in pet without changing stored packs', async t => {
  const { source, data, file } = await fixture(t);
  const [builtin] = await readPetAnimations(data);
  const manifest = await builtinManifest(source, builtin);
  delete manifest.animations.jumping.audio;
  // The already imported silent package used the original eight-frame preparation.
  manifest.animations.jumping.frames = [
    [104, 117], [105, 117], [106, 118], [107, 117], [108, 117], [109, 117], [110, 117], [111, 118],
    ...manifest.animations.jumping.frames.slice(12, 236), [36, 937],
  ];
  manifest.petId = 'pet-cloud-lumi';
  manifest.name = 'Lumi imported under another name';
  await writeFile(file, JSON.stringify(manifest));
  await importPetAnimation(data, file);
  manifest.petId = 'different-pet';
  manifest.animations.idle.frames[0][1] += 1;
  await writeFile(file, JSON.stringify(manifest));
  await importPetAnimation(data, file);
  manifest.petId = 'panel-lumi';
  await writeFile(file, JSON.stringify(manifest));
  await importPetAnimation(data, file);
  const indexFile = path.join(data, 'pet-animations/index.json');
  const before = await readFile(indexFile, 'utf8');
  const summaries = await listPetAnimations(data);
  assert.deepEqual(summaries.map(({ petId, builtinLumi }) => [petId, builtinLumi]), [
    ['pet-cloud-lumi', true], ['different-pet', false], ['panel-lumi', true],
  ]);
  assert.equal(await readFile(indexFile, 'utf8'), before);
  const packs = await readPetAnimations(data);
  assert.equal(packs.length, 3);
  assert.equal(packs.find(item => item.petId === 'pet-cloud-lumi').animations.jumping.audioUrl, builtin.animations.jumping.audioUrl);
  assert.deepEqual(packs.find(item => item.petId === 'pet-cloud-lumi').animations.jumping.frames, builtin.animations.jumping.frames);
  assert.equal(packs.find(item => item.petId === 'panel-lumi').animations.idle.frames[0][1], manifest.animations.idle.frames[0][1]);

  const musicVariant = await builtinManifest(source, builtin);
  musicVariant.petId = 'different-audio';
  const wave = Buffer.alloc(46);
  wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(2, 40);
  musicVariant.animations.jumping.audio = 'different.wav';
  await writeFile(path.join(source, 'different.wav'), wave);
  await writeFile(file, JSON.stringify(musicVariant));
  const variants = await importPetAnimation(data, file);
  assert.equal(variants.find(item => item.petId === 'different-audio').builtinLumi, false);
  const variant = (await readPetAnimations(data)).find(item => item.petId === 'different-audio');
  assert.equal(variant.animations.jumping.audioUrl, `data:audio/wav;base64,${wave.toString('base64')}`);
});

test('uses the bundled Lumi directly for identical imports and leftover overrides', async t => {
  const { source, data, file } = await fixture(t);
  const [builtin] = await readPetAnimations(data);
  const manifest = await builtinManifest(source, builtin);
  const bytes = Buffer.from(builtin.spritesheetUrl.split(',')[1], 'base64');
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await importPetAnimation(data, file), []);
  assert.deepEqual(await readPetAnimations(data), [builtin]);
  await assert.rejects(readdir(path.join(data, 'pet-animations')), { code: 'ENOENT' });

  const directory = path.join(data, 'pet-animations');
  await mkdir(directory, { recursive: true });
  const storedImage = '11111111-1111-1111-1111-111111111111.webp';
  await writeFile(path.join(directory, storedImage), bytes);
  await writeFile(path.join(directory, manifest.animations.jumping.audio), Buffer.from(builtin.animations.jumping.audioUrl.split(',')[1], 'base64'));
  await writeFile(path.join(directory, 'index.json'), JSON.stringify([{ ...manifest, spritesheet: storedImage }]));
  assert.deepEqual(await listPetAnimations(data), []);
  assert.deepEqual(await readPetAnimations(data), [builtin]);

  manifest.animations.idle.frames[0][1] += 1;
  await writeFile(file, JSON.stringify(manifest));
  assert.equal((await importPetAnimation(data, file)).length, 1);
  manifest.animations.idle.frames[0][1] -= 1;
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await importPetAnimation(data, file), []);
  assert.deepEqual(await readPetAnimations(data), [builtin]);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')), []);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.webp')).length, 0);
});

test('rejects invalid frames, non-divisible grids and paths outside the selected package before writing', async t => {
  const { root, source, data, file, manifest, save } = await fixture(t);
  manifest.animations.jumping.frames[0][0] = 4;
  await save();
  await assert.rejects(importPetAnimation(data, file), /帧须为有效/);
  manifest.animations.jumping.frames[0][0] = 2;
  manifest.columns = 3;
  await save();
  await assert.rejects(importPetAnimation(data, file), /尺寸不能/);
  manifest.columns = 2;
  manifest.spritesheet = '../outside.png';
  await save();
  await assert.rejects(importPetAnimation(data, file), /同目录/);
  manifest.spritesheet = 'spritesheet.png';
  manifest.animations.jumping.audio = '../outside.mp3';
  await save();
  await assert.rejects(importPetAnimation(data, file), /audio 必须是同目录/);
  manifest.animations.jumping.audio = 'invalid.mp3';
  await writeFile(path.join(source, 'invalid.mp3'), png());
  await save();
  await assert.rejects(importPetAnimation(data, file), /音频内容与格式不符/);
  delete manifest.animations.jumping.audio;
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, 'outside.png'), png());
    await symlink(path.join(root, 'outside.png'), path.join(source, 'external.png'));
    manifest.spritesheet = 'external.png';
    await save();
    await assert.rejects(importPetAnimation(data, file), /不能链接到外部/);
  }
  assert.deepEqual(await listPetAnimations(data), []);
});
