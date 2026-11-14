// Serialized into the renderer; imported packs contain data, never executable code.
export function createPetAnimationRuntime(initialPacks = []) {
  let packs = initialPacks;
  const listeners = new Set();
  return {
    getSnapshot: () => packs,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setPacks(next) { packs = next; for (const listener of listeners) listener(); },
    resolve(snapshot, source, state, lookFrame) {
      const pack = snapshot.find(item => item.petId === (source.assetRef ?? source.petId));
      if (!pack) return null;
      if (lookFrame) {
        if (lookFrame.rowIndex < 9) {
          const clip = pack.animations[state];
          return clip ? { pack, frames: [clip.frames[0]], still: true } : null;
        }
        const direction = (lookFrame.rowIndex - 9) * 8 + lookFrame.columnIndex;
        const cell = pack.lookFrames?.[direction];
        return cell === undefined ? null : { pack, frames: [[cell, 1]], still: true };
      }
      const clip = pack.animations[state];
      return clip ? { pack, ...clip } : null;
    },
    play(element, animation, reducedMotion, loop) {
      const { pack } = animation;
      const looping = loop || animation.loop;
      const frames = reducedMotion || animation.still ? [animation.frames[0]]
        : looping ? animation.frames : [...animation.frames, ...pack.animations.idle.frames];
      const loopStart = looping ? 0 : animation.frames.length;
      let index = 0, timer;
      const show = () => {
        const cell = frames[index][0];
        element.style.backgroundPosition = `${cell % pack.columns / Math.max(1, pack.columns - 1) * 100}% ${Math.floor(cell / pack.columns) / Math.max(1, pack.rows - 1) * 100}%`;
      };
      const next = () => {
        timer = window.setTimeout(() => {
          index = index + 1 < frames.length ? index + 1 : loopStart;
          show();
          next();
        }, frames[index][1]);
      };
      show();
      if (!reducedMotion && !animation.still) next();
      return () => { if (timer !== undefined) window.clearTimeout(timer); };
    },
  };
}

export function rewriteRspackPets(source) {
  if (!source.includes('data-codex-pet-state') || !source.includes('requiredFramesByRow') || source.includes('panelPetAnimation')) return null;
  const id = '[A-Za-z_$][\\w$]*';
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const state = source.match(new RegExp(`(${id})=${id}&&${id}\\?"jumping":${id},(${id})=null==(${id})\\.assetRef\\?\\3\\.spriteRowCount:(${id})\\.rows;`));
  const look = source.match(new RegExp(`lookFrame:(${id})[,}]`))?.[1];
  const sequence = state && source.match(new RegExp(`let (${id})=(${id})\\(${escape(state[1])},(${id}),(${id})\\),(${id})=\\1\\.frames`));
  const hooks = source.match(new RegExp(`\\(0,(${id})\\.useState\\)`))?.[1];
  const firstHook = source.match(new RegExp(`let\\[${id},${id}\\]=\\(0,${id}\\.useState\\)`))?.[0];
  const element = source.match(new RegExp(`let (${id})=(${id})\\.current;if\\(null==\\1\\)return;`));
  if (!state || !look || !sequence || !hooks || !firstHook || !element) throw new Error('Native pet animation structure is unsupported');
  const [, activeState, rows, petSource, layout] = state;
  const [, , , reduced, loop] = sequence;
  const dependencies = `},[${activeState},${look},${loop},${reduced},${rows}]),`;
  const background = `backgroundImage:\`url(\${${petSource}.spritesheetUrl??`;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Native pet animation anchor is not unique');
    source = source.replace(before, after);
  };
  replace(firstHook, `let panelPetRuntime=globalThis.__codexPanelPetAnimations__,panelPetSnapshot=(0,${hooks}.useSyncExternalStore)(panelPetRuntime.subscribe,panelPetRuntime.getSnapshot);${firstHook}`);
  replace(state[0], state[0].replace(`${rows}=`, `panelPetAnimation=panelPetRuntime.resolve(panelPetSnapshot,${petSource},${activeState},${look}),${rows}=panelPetAnimation?panelPetAnimation.pack.rows:`));
  replace(element[0], `${element[0]}if(panelPetAnimation)return panelPetRuntime.play(${element[1]},panelPetAnimation,${reduced},${loop});`);
  replace(dependencies, `},[${activeState},${look},${loop},${reduced},${rows},panelPetSnapshot,${petSource}.petId,${petSource}.assetRef]),`);
  replace(background, `backgroundImage:\`url(\${panelPetAnimation?.pack.spritesheetUrl??${petSource}.spritesheetUrl??`);
  replace(`100*${layout}.columns`, `100*(panelPetAnimation?.pack.columns??${layout}.columns)`);
  return source;
}
