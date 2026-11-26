function createPetAnimationRuntime(initialPacks = [], builtinPet) {
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
