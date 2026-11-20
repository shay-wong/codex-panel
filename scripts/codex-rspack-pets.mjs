import { applyEdits, isFunction, propertyName, propertyValue, sourceAst, unique, unwrap } from './codex-source-ast.mjs';

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
    const catalog = runtime.prepared.pets && runtime.nativeServices?.petCatalog;
    const pets = catalog && (await runtime.loadModule(catalog.id))[catalog.exportName];
    const available = Array.isArray(pets) && pets.some(pet => pet?.id === selectedPetId);
    if (!available) throw Error(action === 'use-lumi' ? '当前 Codex 尚未载入内置 Lumi，请重启 Codex' : '该资源用于已有宠物，请在 Codex 原生选择器中选择');
  }
  const reference = runtime.nativeServices?.desktopServices;
  if (!reference) throw Error('当前 Codex 未提供可识别的原生宠物设置');
  const nativeModule = await runtime.loadModule(reference.id);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const settings = nativeModule[reference.exportName]?.settings;
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

export function buildNativeServiceBindings(context) {
  const services = context.modulesExporting('appServices').flatMap(module => {
    const ast = context.moduleAst(module.id);
    const exports = ast.exports();
    const value = exports.get('appServices'), setter = ast.value(exports.get('setAppServices'));
    if (!value || !isFunction(setter) || setter.params.length !== 1) return [];
    const assignsService = ast.all(node => node.type === 'AssignmentExpression'
      && node.operator === '=' && samePetValue(ast, node.left, value)
      && samePetValue(ast, node.right, setter.params[0]), setter.body).length > 0;
    return assignsService ? [{ id: module.id, exportName: 'appServices' }] : [];
  });
  const catalogs = context.modulesContaining('The original Codex companion.').flatMap(module => {
    const ast = context.moduleAst(module.id);
    return petCatalogs(ast).map(catalog => context.exportOf(ast, catalog)).filter(Boolean);
  });
  return {
    desktopServices: services.length ? unique(services, 'Native desktop service export is ambiguous') : null,
    petCatalog: catalogs.length ? unique(catalogs, 'Native pet catalog export is ambiguous') : null,
  };
}

function samePetValue(ast, left, right) {
  left = unwrap(left);
  right = unwrap(right);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.type === 'Identifier' && right.type === 'Identifier') {
    const binding = ast.binding(left);
    if (binding && binding === ast.binding(right)) return true;
  }
  const leftValue = ast.value(left), rightValue = ast.value(right);
  if (leftValue !== left || rightValue !== right) return samePetValue(ast, leftValue, rightValue);
  return left.type === 'MemberExpression' && right.type === 'MemberExpression'
    && propertyName(left) === propertyName(right) && samePetValue(ast, left.object, right.object);
}

function petCall(ast, node, method) {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  return callee?.type === 'MemberExpression' && propertyName(callee) === method;
}

function usesPetRuntime(ast, method) {
  return ast.all(node => petCall(ast, node, method)).some(node => {
    const owner = unwrap(ast.value(unwrap(node.callee).object));
    return owner?.type === 'MemberExpression' && propertyName(owner) === '__codexPanelPetAnimations__';
  });
}

function petCatalogs(ast) {
  return ast.all(node => node.type === 'ArrayExpression' && node.elements.some(element => (
    element?.type === 'ObjectExpression'
    && propertyValue(element, 'assetRef')?.value === 'codex'
    && propertyValue(element, 'description')?.value === 'The original Codex companion.'
  )));
}

function cloudPetPredicates(ast) {
  if (!ast.all(node => petCall(ast, node, 'safePatch')
    && node.arguments[0]?.value === '/settings/account_user_setting').length) return [];
  return ast.all(isFunction).filter(fn => {
    const parameter = fn.params[0];
    if (fn.params.length !== 1 || parameter?.type !== 'Identifier') return false;
    const calls = ast.all(node => node.type === 'CallExpression'
      && ast.enclosing(node, isFunction) === fn, fn.body);
    return calls.some(node => petCall(ast, node, 'startsWith')
      && node.arguments[0]?.value === 'pet_'
      && samePetValue(ast, unwrap(node.callee).object, parameter))
      && calls.some(node => {
        if (!petCall(ast, node, 'some')) return false;
        const predicate = ast.value(node.arguments[0]);
        if (!isFunction(predicate)) return false;
        const pet = predicate.params[0];
        const id = propertyValue(pet, 'id');
        return ast.all(value => value.type === 'BinaryExpression'
          && ['===', '=='].includes(value.operator), predicate.body).some(value => {
          const matches = (left, right) => samePetValue(ast, right, parameter)
            && (id ? samePetValue(ast, left, id) : left.type === 'MemberExpression'
              && propertyName(left) === 'id' && samePetValue(ast, left.object, pet));
          return matches(value.left, value.right) || matches(value.right, value.left);
        });
      });
  });
}

function hasPetModule(context, term, predicate) {
  return context.modulesContaining(term).some(module => predicate(context.moduleAst(module.id)));
}

function petPropertyInput(ast, fn, source, name) {
  const pattern = ast.all(node => node.type === 'ObjectPattern'
    && samePetValue(ast, propertyValue(node, 'source'), source), fn)
    .filter(node => propertyValue(node, name));
  if (pattern.length === 1) {
    const value = propertyValue(pattern[0], name);
    return value.type === 'AssignmentPattern' ? value.left : value;
  }
  const resolved = unwrap(ast.value(source));
  if (resolved?.type === 'MemberExpression' && propertyName(resolved) === 'source') {
    return { source: `${ast.text(resolved.object)}.${name}` };
  }
  throw new Error(`Native pet ${name} input is unsupported`);
}

function petRendererEdits(ast, props) {
  const component = ast.enclosing(props, isFunction);
  const source = unwrap(propertyValue(props, 'data-codex-pet-asset-ref'))?.object;
  const state = propertyValue(props, 'data-codex-pet-state');
  const ref = propertyValue(props, 'ref');
  const style = ast.value(propertyValue(props, 'style'));
  if (!component || !source || !state || !ref || style?.type !== 'ObjectExpression') {
    throw new Error('Native pet animation structure is unsupported');
  }
  const look = petPropertyInput(ast, component, source, 'lookFrame');
  const loop = petPropertyInput(ast, component, source, 'loop');
  const inputText = node => node.source ?? ast.text(node);
  const effect = unique(ast.all(node => petCall(ast, node, 'useEffect')
    && ast.enclosing(node, isFunction) === component, component.body).filter(node => {
    const callback = ast.value(node.arguments[0]);
    return isFunction(callback) && ast.all(member => member.type === 'MemberExpression'
      && propertyName(member) === 'current' && samePetValue(ast, member.object, ref), callback.body).length > 0;
  }), 'Native pet animation effect is unsupported');
  const callback = ast.value(effect.arguments[0]);
  const dependencies = ast.value(effect.arguments[1]);
  const sequences = ast.all(node => node.type === 'MemberExpression' && propertyName(node) === 'frames', callback.body)
    .map(node => ast.value(node.object))
    .filter(node => node?.type === 'CallExpression' && node.arguments.length === 3
      && node.arguments.some(argument => samePetValue(ast, argument, state))
      && node.arguments.some(argument => samePetValue(ast, argument, loop)));
  const sequence = unique([...new Set(sequences)], 'Native pet animation sequence is unsupported');
  const reduced = unique(sequence.arguments.filter(argument => !samePetValue(ast, argument, state)
    && !samePetValue(ast, argument, loop)), 'Native pet reduced-motion input is unsupported');
  const hooks = unwrap(effect.callee).object;
  const backgroundImage = propertyValue(style, 'backgroundImage');
  const backgroundSize = propertyValue(style, 'backgroundSize');
  if (dependencies?.type !== 'ArrayExpression' || !backgroundImage || !backgroundSize) {
    throw new Error('Native pet animation appearance is unsupported');
  }
  const resolve = `panelPetRuntime.resolve(panelPetSnapshot,${ast.text(source)},${ast.text(state)},${inputText(look)})`;
  const declarations = `let panelPetRuntime=globalThis.__codexPanelPetAnimations__,panelPetSnapshot=(0,${ast.text(hooks)}.useSyncExternalStore)(panelPetRuntime.subscribe,panelPetRuntime.getSnapshot);`;
  const playback = `const panelPetAnimation=${resolve};if(panelPetAnimation){const panelPetElement=${ast.text(ref)}.current;if(panelPetElement!=null)return panelPetRuntime.play(panelPetElement,panelPetAnimation,${ast.text(reduced)},${inputText(loop)});}`;
  const styleSource = applyEdits(ast.text(style), [
    { start: backgroundImage.start - style.start, end: backgroundImage.end - style.start,
      text: `panelPetAnimation?\`url(\${panelPetAnimation.pack.spritesheetUrl})\`:(${ast.text(backgroundImage)})` },
    { start: backgroundSize.start - style.start, end: backgroundSize.end - style.start,
      text: `panelPetAnimation?\`\${100*panelPetAnimation.pack.columns}% \${100*panelPetAnimation.pack.rows}%\`:(${ast.text(backgroundSize)})` },
  ]);
  const edits = [
    { start: style.start, end: style.end, text: `((panelPetAnimation)=>(${styleSource}))(${resolve})` },
    { start: dependencies.start, end: dependencies.end,
      text: `[...(${ast.text(dependencies)}),panelPetSnapshot,${ast.text(source)}.petId,${ast.text(source)}.assetRef]` },
  ];
  for (const [fn, prefix] of [[component, declarations], [callback, playback]]) {
    const body = fn.body;
    if (body.type === 'BlockStatement') {
      const statement = body.body.find(node => !node.directive);
      const start = statement?.start ?? body.end - 1;
      edits.push({ start, end: start, text: prefix });
    } else {
      edits.push({ start: body.start, end: body.start, text: `{${prefix}return (` });
      edits.push({ start: body.end, end: body.end, text: ');}' });
    }
  }
  return edits;
}

export function rewriteRspackPets(source, context) {
  // Admit each native pet capability independently; AST relationships decide the actual patch.
  if (!['The original Codex companion.', '/settings/account_user_setting', 'data-codex-pet-state']
    .some(term => source.includes(term))) return null;
  const ast = context?.ast(source) ?? sourceAst(source, { factory: true });
  const edits = [];
  const catalogs = petCatalogs(ast);
  if (catalogs.length && !usesPetRuntime(ast, 'bindCatalog')) {
    if (context && !hasPetModule(context, 'data-codex-pet-state', module => module.all(node => node.type === 'Property'
      && propertyName(node) === 'data-codex-pet-state').length > 0)) {
      throw new Error('Native pet renderer is unsupported');
    }
    const catalog = unique(catalogs, 'Native built-in pet catalog is unsupported');
    edits.push({ start: catalog.start, end: catalog.end,
      text: `((panelPetCatalog)=>(globalThis.__codexPanelPetAnimations__.bindCatalog(panelPetCatalog),panelPetCatalog))(${ast.text(catalog)})` });
  }
  const predicates = cloudPetPredicates(ast);
  if (predicates.length && !usesPetRuntime(ast, 'isLocalPet')) {
    const predicate = unique(predicates, 'Native cloud pet selection is unsupported');
    const parameter = ast.text(predicate.params[0]);
    const returns = predicate.body.type === 'BlockStatement'
      ? ast.all(node => node.type === 'ReturnStatement' && node.argument && ast.enclosing(node, isFunction) === predicate, predicate.body).map(node => node.argument)
      : [predicate.body];
    for (const value of returns) {
      // Panel pets are local and must never be written to the official account.
      edits.push({ start: value.start, end: value.end,
        text: `(!globalThis.__codexPanelPetAnimations__.isLocalPet(${parameter})&&(${ast.text(value)}))` });
    }
  }
  const renderers = ast.all(node => node.type === 'ObjectExpression' && propertyValue(node, 'data-codex-pet-state'));
  if (renderers.length && !usesPetRuntime(ast, 'resolve')) {
    if (context && (!hasPetModule(context, 'The original Codex companion.', module => petCatalogs(module).length > 0)
      || !hasPetModule(context, 'cloud-pet-selection', module => cloudPetPredicates(module).length > 0))) {
      throw new Error('Native built-in pet selection is unsupported');
    }
    edits.push(...petRendererEdits(ast, unique(renderers, 'Native pet renderer is unsupported')));
  }
  return edits.length ? applyEdits(source, edits) : null;
}
