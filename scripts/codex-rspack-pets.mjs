// Serialized into the renderer; imported packs contain data, never executable code.
export function createPetAnimationRuntime(initialPacks = [], builtinPet) {
  let packs = initialPacks;
  let catalog, nativePets = [];
  const localPetIds = new Set();
  const listeners = new Set();
  let soundEnabled = true;
  let soundId = 0;
  const playingSounds = new Map();
  const playAudio = id => {
    const playback = soundEnabled && playingSounds.get(id);
    if (!playback) return;
    return playback.sound.play().then(() => {
      if (playingSounds.get(id) === playback) playback.start();
    }).catch(error => {
      console.error('Pet animation audio failed:', error);
      playback.sound.pause();
      playingSounds.delete(id);
      playback.start();
    });
  };
  const syncCatalog = () => {
    if (!catalog) return;
    const pets = [...nativePets];
    localPetIds.clear();
    if (builtinPet) pets.push(builtinPet);
    for (const pack of packs) {
      if (pack.petId === builtinPet?.id || /^(?:pet_|custom:)/.test(pack.petId)
        || nativePets.some(pet => pet.id === pack.petId)) continue;
      localPetIds.add(pack.petId);
      pets.push({ id: pack.petId, displayName: pack.name, description: '导入的本地宠物',
        spriteVersionNumber: 2, spritesheetUrl: pack.spritesheetUrl });
    }
    catalog.splice(0, catalog.length, ...pets);
  };
  return {
    builtinPet,
    getSnapshot: () => packs,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    bindCatalog(next) {
      if (catalog !== next) { catalog = next; nativePets = [...next]; }
      syncCatalog();
    },
    isLocalPet: id => id === builtinPet?.id || localPetIds.has(id),
    playAudio,
    setSoundEnabled(enabled) {
      soundEnabled = enabled;
      if (!enabled) for (const playback of playingSounds.values()) { playback.sound.pause(); playback.start(); }
    },
    setPacks(next) { packs = next; syncCatalog(); for (const listener of listeners) listener(); },
    resolve(snapshot, source, state, lookFrame) {
      const pack = snapshot.find(item => item.petId === (source.assetRef ?? source.petId));
      if (!pack) return null;
      const clip = pack.animations[state] ?? (localPetIds.has(pack.petId) ? pack.animations.idle : null);
      if (lookFrame) {
        if (lookFrame.rowIndex < 9) {
          return clip ? { pack, frames: [clip.frames[0]], still: true } : null;
        }
        const direction = (lookFrame.rowIndex - 9) * 8 + lookFrame.columnIndex;
        const cell = pack.lookFrames?.[direction] ?? (localPetIds.has(pack.petId) ? pack.animations.idle.frames[0][0] : undefined);
        return cell === undefined ? null : { pack, frames: [[cell, 1]], still: true };
      }
      return clip ? { pack, ...clip } : null;
    },
    play(element, animation, reducedMotion, loop) {
      const { pack } = animation;
      const looping = loop || animation.loop;
      const frames = reducedMotion || animation.still ? [animation.frames[0]]
        : looping ? animation.frames : [...animation.frames, ...pack.animations.idle.frames];
      let duration = 0;
      const ends = frames.map(([, milliseconds]) => duration += milliseconds);
      const clipDuration = animation.frames.reduce((total, [, milliseconds]) => total + milliseconds, 0);
      let index = 0, timer, sound, currentSoundId, startedAt, started = false, stopped = false;
      const stopSound = () => {
        if (!sound) return;
        sound.pause();
        sound.currentTime = 0;
        playingSounds.delete(currentSoundId);
        sound = undefined;
      };
      const show = () => {
        const cell = frames[index][0];
        element.style.backgroundPosition = `${cell % pack.columns / Math.max(1, pack.columns - 1) * 100}% ${Math.floor(cell / pack.columns) / Math.max(1, pack.rows - 1) * 100}%`;
      };
      const tick = () => {
        if (stopped) return;
        const now = performance.now();
        if (sound && !looping && (!sound.paused || sound.ended)) {
          startedAt = now - sound.currentTime * 1000;
          if (sound.ended) stopSound();
        }
        const elapsed = now - startedAt;
        if (!looping && elapsed >= clipDuration) stopSound();
        const position = looping ? elapsed % clipDuration : elapsed < clipDuration ? elapsed
          : clipDuration + (elapsed - clipDuration) % (duration - clipDuration);
        const nextIndex = ends.findIndex(end => position < end);
        if (nextIndex !== index) { index = nextIndex; show(); }
        timer = window.requestAnimationFrame(tick);
      };
      const start = () => {
        if (started || stopped || reducedMotion || animation.still) return;
        started = true;
        startedAt = performance.now();
        timer = window.requestAnimationFrame(tick);
      };
      show();
      if (soundEnabled && animation.audioUrl && !reducedMotion && !animation.still) {
        sound = new Audio(animation.audioUrl);
        sound.loop = Boolean(looping);
        currentSoundId = ++soundId;
        playingSounds.set(currentSoundId, { sound, start });
        const requestPlayback = globalThis.__codexPanelPlayPetAudioV1;
        if (typeof requestPlayback === 'function') requestPlayback(String(currentSoundId));
        else playAudio(currentSoundId);
      } else start();
      return () => { stopped = true; if (timer !== undefined) window.cancelAnimationFrame(timer); stopSound(); };
    },
  };
}

export async function installPetAudioBinding(cdp) {
  if (cdp.petAudioBindingInstalled) return;
  const name = '__codexPanelPlayPetAudioV1';
  await cdp.send('Runtime.addBinding', { name });
  cdp.on('Runtime.bindingCalled', params => {
    if (params.name !== name || !/^[1-9]\d{0,9}$/.test(params.payload)) return;
    void cdp.send('Runtime.evaluate', {
      expression: `globalThis.__codexPanelPetAnimations__?.playAudio(${Number(params.payload)})`,
      contextId: params.executionContextId, userGesture: true, awaitPromise: true, returnByValue: true,
    }).catch(error => console.error(`Pet audio playback failed: ${error.message}`));
  });
  cdp.petAudioBindingInstalled = true;
}

export async function nativePetSelection(load, action, lumiPetIds = [], targetPetId) {
  if (!['pet-selection', 'use-lumi', 'cancel-lumi', 'use-pet', 'cancel-pet'].includes(action)) throw Error('不支持的宠物操作');
  const runtime = globalThis.__codexPanelRspack__;
  if (!load || runtime?.require !== load) throw Error('请先通过 Panel 连接 Codex');
  if (['use-pet', 'cancel-pet'].includes(action)
    && !globalThis.__codexPanelPetAnimations__?.getSnapshot().some(pack => pack.petId === targetPetId)) {
    throw Error('该宠物尚未导入，请刷新宠物列表');
  }
  const selectedPetId = action === 'use-lumi' ? 'panel-lumi' : targetPetId;
  if (action === 'use-lumi' || action === 'use-pet') {
    const catalog = runtime.prepared.pets && runtime.findModule(['The original Codex companion.', 'spritesheetUrl', 'custom:']);
    const available = catalog && Object.values(load(catalog.id)).some(value => Array.isArray(value)
      && value.some(pet => pet?.id === selectedPetId));
    if (!available) throw Error(action === 'use-lumi' ? '当前 Codex 尚未载入内置 Lumi，请重启 Codex' : '该资源用于已有宠物，请在 Codex 原生选择器中选择');
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    const module = runtime.findModule(['setAppHost', 'setAppServices', 'appServices:']);
    const settings = module && load(module.id).appServices?.settings;
    if (settings) {
      let current = await settings.read('selected-avatar-id');
      if (action === 'use-lumi' || action === 'use-pet'
        || action === 'cancel-lumi' && (current.effective === 'panel-lumi' || lumiPetIds.includes(current.effective))
        || action === 'cancel-pet' && current.effective === targetPetId) {
        await settings.write('selected-avatar-id', action === 'use-lumi' || action === 'use-pet' ? selectedPetId : null);
        current = await settings.read('selected-avatar-id');
      }
      if (current.effective !== null && typeof current.effective !== 'string') throw Error('Codex 未返回有效的宠物选择');
      return { petId: current.effective };
    }
    if (Date.now() >= deadline) throw Error('Codex 原生宠物设置尚未就绪');
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
}

export function rewriteRspackPets(source, context) {
  const id = '[A-Za-z_$][\\w$]*';
  if (source.includes('The original Codex companion.') && source.includes('custom:') && !source.includes('__codexPanelPetAnimations__.bindCatalog')) {
    if (context && !context.findModule(['data-codex-pet-state', 'requiredFramesByRow'])) throw new Error('Native pet renderer is unsupported');
    const catalog = source.match(new RegExp(`let (${id})=\\[\\{assetRef:"codex",description:"The original Codex companion\\."`));
    const end = catalog && source.indexOf('];', catalog.index);
    if (!catalog || end < 0) throw new Error('Native built-in pet catalog is unsupported');
    return `${source.slice(0, end + 2)}globalThis.__codexPanelPetAnimations__.bindCatalog(${catalog[1]});${source.slice(end + 2)}`;
  }
  if (source.includes('cloud-pet-selection') && source.includes('/settings/account_user_setting') && !source.includes('__codexPanelPetAnimations__.isLocalPet')) {
    const predicate = source.match(new RegExp(`function (${id})\\((${id})\\)\\{return \\2\\.startsWith\\("pet_"\\)&&\\2\\.length>4\\|\\|${id}\\.${id}\\.some\\(\\(\\{id:${id}\\}\\)=>${id}===\\2\\)\\}`));
    if (!predicate) throw new Error('Native cloud pet selection is unsupported');
    // Panel pets are local and must never be written to the official account.
    return source.replace(predicate[0], predicate[0].replace('return ', `return !globalThis.__codexPanelPetAnimations__.isLocalPet(${predicate[2]})&&(`).replace(/}$/, ')}'));
  }
  if (!source.includes('data-codex-pet-state') || !source.includes('requiredFramesByRow') || source.includes('panelPetAnimation')) return null;
  if (context && (!context.findModule(['The original Codex companion.', 'spritesheetUrl', 'custom:'])
    || !context.findModule(['cloud-pet-selection', '/settings/account_user_setting']))) {
    throw new Error('Native built-in pet selection is unsupported');
  }
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
