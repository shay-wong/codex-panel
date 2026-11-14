import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { importPetAnimation, listPetAnimations, readPetAnimations, removePetAnimation } from '../scripts/pet-animations.mjs';

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

test('imports a self-contained animation pack, updates one pet, and removes only its managed resources', async t => {
  const { data, file, manifest, save } = await fixture(t);
  assert.deepEqual(await listPetAnimations(data), []);
  assert.deepEqual(await readPetAnimations(data), []);
  assert.deepEqual(await importPetAnimation(data, file), [
    { petId: 'test-pet', name: 'Test pet', states: ['idle', 'jumping'], hasLookFrames: true },
  ]);
  const [first] = await readPetAnimations(data);
  assert.equal(first.columns, 2);
  assert.deepEqual(first.animations.jumping, manifest.animations.jumping);
  assert.ok(Buffer.from(first.spritesheetUrl.split(',')[1], 'base64').equals(png()));
  const directory = path.join(data, 'pet-animations');
  await writeFile(path.join(directory, 'user-note.txt'), 'keep');

  manifest.petId = 'second-pet';
  await save();
  await importPetAnimation(data, file);
  manifest.petId = 'test-pet'; manifest.name = 'Updated';
  await save();
  const updated = await importPetAnimation(data, file);
  assert.equal(updated.length, 2);
  assert.equal(updated.find(item => item.petId === 'test-pet').name, 'Updated');
  assert.ok(!(await readdir(directory)).includes(first.spritesheet));
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.png')).length, 2);
  assert.deepEqual((await removePetAnimation(data, 'test-pet')).map(item => item.petId), ['second-pet']);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.png')).length, 1);
  assert.equal(await readFile(path.join(directory, 'user-note.txt'), 'utf8'), 'keep');
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
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, 'outside.png'), png());
    await symlink(path.join(root, 'outside.png'), path.join(source, 'external.png'));
    manifest.spritesheet = 'external.png';
    await save();
    await assert.rejects(importPetAnimation(data, file), /不能链接到外部/);
  }
  assert.deepEqual(await listPetAnimations(data), []);
});
