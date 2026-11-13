import { readFile } from 'node:fs/promises';

export async function readLumiPetAnimation() {
  const [image, timing] = await Promise.all([
    readFile(new URL('../inject/pets/lumi-hover.webp', import.meta.url)),
    readFile(new URL('../inject/pets/lumi-hover.json', import.meta.url), 'utf8'),
  ]);
  return { ...JSON.parse(timing), spritesheetUrl: `data:image/webp;base64,${image.toString('base64')}` };
}

// Serialized into the renderer; the native timer and its cleanup remain in charge.
export function createLumiPetAnimation(data) {
  const frames = data.frames.map(([cell, duration]) => ({
    columnIndex: cell % data.columns,
    rowIndex: Math.floor(cell / data.columns),
    frameDurationMs: duration,
  }));
  return {
    petId: data.petId,
    rows: data.rows,
    spritesheetUrl: data.spritesheetUrl,
    sequence(reducedMotion, loop, idle) {
      if (reducedMotion) return { frames: [frames[0]], loopStartIndex: null };
      return {
        frames: loop ? frames : [...frames, ...idle.map((frame, index) => ({
          ...frame, rowIndex: 2, columnIndex: index + 2,
        }))],
        loopStartIndex: loop ? 0 : frames.length,
      };
    },
  };
}

export function rewriteRspackPets(source) {
  if (!source.includes('data-codex-pet-state') || !source.includes('requiredFramesByRow') || source.includes('panelLumi')) return null;
  const id = '[A-Za-z_$][\\w$]*';
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const state = source.match(new RegExp(`(${id})=${id}&&${id}\\?"jumping":${id},(${id})=null==(${id})\\.assetRef\\?\\3\\.spriteRowCount:${id}\\.rows;`));
  const look = source.match(new RegExp(`lookFrame:(${id})[,}]`))?.[1];
  const sequence = state && source.match(new RegExp(`let (${id})=(${id})\\(${escape(state[1])},(${id}),(${id})\\),(${id})=\\1\\.frames`));
  if (!state || !look || !sequence) throw new Error('Native pet animation structure is unsupported');
  const [, activeState, rows, petSource] = state;
  const [, result, buildSequence, reduced, loop, frames] = sequence;
  const dependencies = `},[${activeState},${look},${loop},${reduced},${rows}]),`;
  const background = `backgroundImage:\`url(\${${petSource}.spritesheetUrl??`;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Native pet animation anchor is not unique');
    source = source.replace(before, after);
  };
  replace(state[0], state[0].replace(`${rows}=`, `panelLumi=globalThis.__codexPanelLumiPetV1__?.petId===${petSource}.petId&&"jumping"===${activeState}&&null==${look}?globalThis.__codexPanelLumiPetV1__:null,${rows}=panelLumi?panelLumi.rows:`));
  replace(sequence[0], `let ${result}=panelLumi?panelLumi.sequence(${reduced},${loop},${buildSequence}("idle",!1).frames):${buildSequence}(${activeState},${reduced},${loop}),${frames}=${result}.frames`);
  replace(dependencies, `},[${activeState},${look},${loop},${reduced},${rows},${petSource}.petId]),`);
  replace(background, `backgroundImage:\`url(\${panelLumi?.spritesheetUrl??${petSource}.spritesheetUrl??`);
  return source;
}
