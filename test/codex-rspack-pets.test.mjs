import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildNativeServiceBindings, createPetAnimationRuntime, rewriteRspackPets, nativePetSelection, installPetAudioBinding } from '../scripts/codex-rspack-pets.mjs';
import { rspackSourceContext } from '../scripts/codex-rspack-source.mjs';
import { sourceAst } from '../scripts/codex-source-ast.mjs';
import { findCodexRspackRequire } from '../scripts/codex-update.mjs';

// Captured native renderer from Codex 26.1106.51428; no application or user data is loaded.
const nativeSource = "function(e,t,n){n.d(t,{Pq:()=>o,IO:()=>l,bH:()=>y,kx:()=>g,_s:()=>m,P3:()=>E,Eu:()=>d});var r=n(\"ABep\"),i=n(\"on57\"),a=n(\"IjbW\"),s=n(\"zd8w\");let o={version:1,width:1536,height:1872,cellWidth:192,cellHeight:208,columns:8,rows:9,requiredFramesByRow:[6,8,8,4,5,8,6,6,6]},l={version:2,width:1536,height:2288,cellWidth:192,cellHeight:208,columns:8,rows:11,requiredFramesByRow:[6,8,8,4,5,8,6,6,6,8,8]},u=[o,l];function d(e,t){return u.find(n=>n.width===e&&n.height===t)??null}let c=l.columns,p=[{rowIndex:0,columnIndex:0,frameDurationMs:280},{rowIndex:0,columnIndex:1,frameDurationMs:110},{rowIndex:0,columnIndex:2,frameDurationMs:110},{rowIndex:0,columnIndex:3,frameDurationMs:140},{rowIndex:0,columnIndex:4,frameDurationMs:140},{rowIndex:0,columnIndex:5,frameDurationMs:320}],h=p.map(e=>({...e,frameDurationMs:6*e.frameDurationMs})),f={failed:_(5,8,140,240),idle:p,jumping:_(4,5,140,280),review:_(8,6,150,280),running:_(7,6,120,220),\"running-left\":_(2,8,120,220),\"running-right\":_(1,8,120,220),waving:_(3,4,140,280),waiting:_(6,6,150,260)};function m(e,t,n=!1){let r=f[e];if(t)return{frames:[g(r,0)],loopStartIndex:null};if(\"idle\"===e)return{frames:h,loopStartIndex:0};if(n)return{frames:r,loopStartIndex:0};let i=[...r,...r,...r];return{frames:[...i,...h],loopStartIndex:i.length}}function g(e,t){let n=e[t];if(null==n)throw RangeError(\"Codex pet animation frame is out of range\");return n}function _(e,t,n,r){return Array.from({length:t},(i,a)=>({columnIndex:a,frameDurationMs:a===t-1?r:n,rowIndex:e}))}function v(e,t){let n=e.columnIndex/(c-1)*100,r=null==t?`calc(-${e.rowIndex} * var(--codex-pet-frame-height))`:`${e.rowIndex/(t-1)*100}%`;return`${n}% ${r}`}let y=({assetMap:e,className:t,lookFrame:n,loop:o=!1,respondToHover:u=!1,size:d=\"default\",source:c,state:p=\"idle\"})=>{let[h,f]=(0,s.useState)(!1),_=(0,s.useRef)(null),y=(0,a.I)(),E=u&&h?\"jumping\":p,I=null==c.assetRef?c.spriteRowCount:l.rows;return(0,s.useEffect)(()=>{let e=_.current;if(null==e)return;if(null!=n){e.style.backgroundPosition=v(n,I);return}let t=m(E,y,o),r=t.frames,i=0,a=null;if(e.style.backgroundPosition=v(g(r,i),I),1===r.length)return;let s=()=>{a=window.setTimeout(()=>{let n=i+1;if(n>=r.length){if(null!=t.loopStartIndex){i=t.loopStartIndex,e.style.backgroundPosition=v(g(r,i),I),s();return}a=null;return}i=n,e.style.backgroundPosition=v(g(r,i),I),s()},g(r,i).frameDurationMs)};return s(),()=>{null!=a&&window.clearTimeout(a)}},[E,n,o,y,I]),(0,r.jsx)(\"div\",{ref:_,className:(0,i.A)(\"Root-acw8Rg\",\"container\"===d&&\"Container-AAUiZc\",t),\"data-codex-pet-asset-ref\":c.assetRef,\"data-codex-pet-id\":c.assetRef??c.petId,\"data-codex-pet-state\":E,onPointerEnter:()=>{u&&f(!0)},onPointerLeave:()=>{u&&f(!1)},style:{backgroundImage:`url(${c.spritesheetUrl??e[c.assetRef]})`,backgroundSize:null==I?void 0:`${100*l.columns}% ${100*I}%`},\"aria-hidden\":\"true\"})};function E(e,t,n=o.version){if(n!==l.version)return null;let r=t.x-(e.left+e.width/2),i=t.y-(e.top+e.height/2);if(1>=Math.hypot(r,i))return null;let a=Math.round((180/Math.PI*Math.atan2(r,-i)+360)%360/22.5)%16;return{columnIndex:a%8,frameDurationMs:0,rowIndex:9+Math.floor(a/8)}}}";

const pack = {
  petId: 'custom-pet', columns: 4, rows: 3, spritesheetUrl: 'data:image/webp;base64,fixture',
  animations: {
    idle: { frames: [[9, 1680], [10, 660]], loop: true },
    jumping: { frames: [[8, 938], [0, 59], [1, 58], [2, 59]], loop: false },
    running: { frames: [[4, 150], [5, 150]], loop: true },
    review: { frames: [[6, 180], [7, 180]], loop: false },
  },
  lookFrames: Array.from({length: 16}, (_, index) => index % 12),
};

test('pet admission skips unrelated factories and admits each semantic marker independently', () => {
  assert.equal(rewriteRspackPets('function(module,exports,load){exports.unrelated=true}', {
    ast() { throw new Error('Unrelated factory must not be parsed'); },
  }), null);
  for (const marker of ['The original Codex companion.', '/settings/account_user_setting', 'data-codex-pet-state']) {
    let parsed = 0;
    const source = `function(module,exports,load){exports.marker=${JSON.stringify(marker)}}`;
    assert.equal(rewriteRspackPets(source, { ast(value) {
      parsed++;
      return sourceAst(value, { factory: true });
    } }), null);
    assert.equal(parsed, 1, marker);
  }
});

function render(source, packs, { petId = pack.petId, state = 'idle', hover = false, reduced = false, lookFrame } = {}) {
  const element = { style: {} }, effects = [], timers = new Map(), animationFrames = new Map(), hoverChanges = [];
  let timerId = 0, now = 0;
  const modules = {
    ABep: { jsx: (tag, props) => ({ tag, props }) },
    on57: { A: (...classes) => classes.filter(Boolean).join(' ') },
    IjbW: { I: () => reduced },
    zd8w: {
      useState: () => [hover, value => hoverChanges.push(value)],
      useRef: () => ({ current: element }),
      useEffect: effect => effects.push(effect),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    },
  };
  const exports = {};
  const require = id => { assert.ok(modules[id], id); return modules[id]; };
  require.d = (target, getters) => Object.entries(getters).forEach(([key, get]) => Object.defineProperty(target, key, { get }));
  const context = vm.createContext({
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id),
      requestAnimationFrame(callback) { const id = ++timerId; animationFrames.set(id, callback); return id; },
      cancelAnimationFrame: id => animationFrames.delete(id),
    },
    performance: { now: () => now },
    packs,
  });
  vm.runInContext(`globalThis.__codexPanelPetAnimations__=(${createPetAnimationRuntime})(packs)`, context);
  vm.runInContext(`(${source})`, context)({}, exports, require);
  const output = exports.bH({
    source: { petId, spriteRowCount: 11, spritesheetUrl: 'native.webp' },
    assetMap: {}, state, lookFrame, respondToHover: true,
  });
  return { output, element, timers, animationFrames, hoverChanges, cleanup: effects.at(-1)(),
    advance(milliseconds) {
      now += milliseconds;
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback(now);
    },
  };
}

test('imported pet clips use their own grid, states and idle timing with native hover cancellation', () => {
  const patchedSource = rewriteRspackPets(nativeSource);
  const playing = render(patchedSource, [pack], { hover: true });
  assert.equal(playing.output.props.style.backgroundSize, '400% 300%');
  assert.equal(playing.output.props.style.backgroundImage, `url(${pack.spritesheetUrl})`);
  for (const [cell, duration] of pack.animations.jumping.frames) {
    assert.equal(playing.element.style.backgroundPosition, `${cell % 4 / 3 * 100}% ${Math.floor(cell / 4) / 2 * 100}%`);
    playing.advance(duration);
  }
  assert.equal(playing.element.style.backgroundPosition, '33.33333333333333% 100%');
  playing.advance(1679);
  assert.equal(playing.element.style.backgroundPosition, '33.33333333333333% 100%');
  playing.advance(1);
  assert.equal(playing.element.style.backgroundPosition, '66.66666666666666% 100%');
  playing.output.props.onPointerLeave();
  assert.deepEqual(playing.hoverChanges, [false]);
  playing.cleanup();
  assert.equal(playing.timers.size, 0);
  assert.equal(playing.animationFrames.size, 0);

  for (const state of ['idle', 'running', 'review']) {
    const result = render(patchedSource, [pack], { state });
    assert.equal(result.output.props.style.backgroundImage, `url(${pack.spritesheetUrl})`);
    result.cleanup();
  }
  const looking = render(patchedSource, [pack], { lookFrame: { rowIndex: 10, columnIndex: 4 } });
  assert.equal(looking.element.style.backgroundPosition, '0% 0%');
  assert.equal(looking.timers.size, 0);
  assert.equal(looking.animationFrames.size, 0);
  const paused = render(patchedSource, [pack], { lookFrame: { rowIndex: 0, columnIndex: 0 } });
  assert.equal(paused.element.style.backgroundPosition, '33.33333333333333% 100%');
  assert.equal(paused.timers.size, 0);
  assert.equal(paused.animationFrames.size, 0);
  const reduced = render(patchedSource, [pack], { hover: true, reduced: true });
  assert.equal(reduced.element.style.backgroundPosition, '0% 100%');
  assert.equal(reduced.timers.size, 0);
  assert.equal(reduced.animationFrames.size, 0);

  for (const options of [{ petId: 'unconfigured-pet', hover: true }, { state: 'failed' }]) {
    const before = render(nativeSource, [], options), after = render(patchedSource, [pack], options);
    assert.deepEqual({ ...after.output.props.style }, { ...before.output.props.style });
    assert.deepEqual(after.element.style, before.element.style);
    before.cleanup?.(); after.cleanup?.();
  }
});

test('pet rendering follows bound props and effects across declaration and field reordering', () => {
  const native = nativeSource
    .replace('lookFrame:n,loop:o=!1,respondToHover:u=!1,size:d="default",source:c,state:p="idle"',
      'state:p="idle",source:c,size:d="default",respondToHover:u=!1,loop:o=!1,lookFrame:n')
    .replace('let[h,f]=(0,s.useState)(!1),_=(0,s.useRef)(null),y=(0,a.I)(),E=u&&h?"jumping":p,I=null==c.assetRef?c.spriteRowCount:l.rows;',
      'const unused=(0,s.useState)(true);const _=(0,s.useRef)(null);let[h,f]=(0,s.useState)(!1);const I=null==c.assetRef?c.spriteRowCount:l.rows;const y=(0,a.I)();const E=u&&h?"jumping":p;(0,s.useEffect)(()=>{},[]);')
    .replace('let e=_.current;if(null==e)return;', 'const current=_.current;const e=current;if(e===null){return;}')
    .replace('let t=m(E,y,o),r=t.frames,i=0,a=null;', 'const t=m(E,y,o);let a=null;const r=t.frames;let i=0;')
    .replace('[E,n,o,y,I]', '[I,y,o,n,E]')
    .replace('style:{backgroundImage:`url(${c.spritesheetUrl??e[c.assetRef]})`,backgroundSize:null==I?void 0:`${100*l.columns}% ${100*I}%`}',
      'style:{backgroundSize:null==I?void 0:`${100*l.columns}% ${100*I}%`,backgroundImage:`url(${c.spritesheetUrl??e[c.assetRef]})`}');
  const patched = rewriteRspackPets(native);
  const imported = render(patched, [pack], { hover: true });
  assert.equal(imported.output.props.style.backgroundSize, '400% 300%');
  assert.equal(imported.output.props.style.backgroundImage, `url(${pack.spritesheetUrl})`);
  imported.advance(938);
  assert.equal(imported.element.style.backgroundPosition, '0% 0%');
  imported.cleanup();
  const before = render(native, [], { petId: 'native-pet' });
  const after = render(patched, [pack], { petId: 'native-pet' });
  assert.deepEqual({ ...after.output.props.style }, { ...before.output.props.style });
  assert.deepEqual(after.element.style, before.element.style);
  before.cleanup?.();
  after.cleanup?.();
  assert.equal(rewriteRspackPets(patched), null);
});

test('pet catalogs and cloud predicates ignore property order and declaration placement', () => {
  const catalog = `function(module,exports,load){
    const unrelated=["not a pet", "];"];
    function serialize(pet){return pet.id;}
    const pets=[{id:"codex",spriteVersionNumber:2,displayName:"Codex",description:"The original Codex companion.",assetRef:"codex"}];
    exports.serialize=serialize;exports.catalog=pets;
  }`;
  const cloud = `function(module,exports,load){
    const catalog=load("catalog");
    exports.select=id=>{if(eligible(id))load("account").safePatch("/settings/account_user_setting",{scope:"cloud-pet-selection",value:id});};
    const eligible=id=>{
      const builtin=catalog.catalog.some(({displayName,id:petId})=>id===petId);
      const remote=id.startsWith("pet_")&&id.length>4;
      return builtin||remote;
    };
  }`;
  const builtin = { id: 'panel-lumi' };
  const context = vm.createContext({ __codexPanelPetAnimations__: createPetAnimationRuntime([], builtin) });
  const catalogExports = {}, cloudExports = {}, writes = [];
  const load = id => id === 'catalog' ? catalogExports : { safePatch: (...args) => writes.push(args) };
  const patchedCatalog = rewriteRspackPets(catalog), patchedCloud = rewriteRspackPets(cloud);
  vm.runInContext(`(${patchedCatalog})`, context)({}, catalogExports, load);
  vm.runInContext(`(${patchedCloud})`, context)({}, cloudExports, load);
  assert.equal(catalogExports.catalog.at(-1), builtin);
  assert.equal(catalogExports.serialize(builtin), 'panel-lumi');
  cloudExports.select('panel-lumi');
  assert.equal(writes.length, 0);
  cloudExports.select('codex');
  cloudExports.select('pet_cloud');
  assert.equal(writes.length, 2);
  assert.equal(rewriteRspackPets(patchedCatalog), null);
  assert.equal(rewriteRspackPets(patchedCloud), null);
});

test('native service bindings follow exported assignments and the catalog array', () => {
  const factories = new Map([
    ['service-module', { id: 'service-module', source: `function(module,exports,load){
      let current;
      function publish(value){current=value;}
      load.d(exports,{setAppServices:()=>publish,appServices:()=>current});
    }` }],
    ['catalog-module', { id: 'catalog-module', source: `function(module,exports,load){
      const pets=[{description:"The original Codex companion.",id:"codex",assetRef:"codex"}];
      const alias=pets;
      load.d(exports,{}, {nativePets:alias,unrelated:"value"});
    }` }],
    ['unrelated', { id: 'unrelated', source: `function(module,exports,load){
      const text="appServices setAppServices The original Codex companion.";
      load.d(exports,{}, {text});
    }` }],
  ]);
  assert.deepEqual(buildNativeServiceBindings(rspackSourceContext(factories)), {
    desktopServices: { id: 'service-module', exportName: 'appServices' },
    petCatalog: { id: 'catalog-module', exportName: 'nativePets' },
  });
});

test('replacing and removing imported data notifies renderer subscriptions', () => {
  const runtime = createPetAnimationRuntime([]);
  const original = { id: 'codex', assetRef: 'codex' };
  const catalog = [original];
  runtime.bindCatalog(catalog);
  let notified = 0;
  const unsubscribe = runtime.subscribe(() => notified++);
  runtime.setPacks([pack]);
  assert.equal(catalog[0], original);
  assert.equal(catalog[1].id, pack.petId);
  assert.equal(catalog[1].spritesheetUrl, pack.spritesheetUrl);
  assert.equal(runtime.isLocalPet(pack.petId), true);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running').pack, pack);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'failed').frames, pack.animations.idle.frames);
  assert.deepEqual(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'failed', {rowIndex: 10, columnIndex: 1}).frames, [[pack.lookFrames[9], 1]]);
  const idleOnly = { ...pack, name: 'Updated', animations: { idle: pack.animations.idle }, lookFrames: undefined };
  runtime.setPacks([idleOnly]);
  assert.equal(catalog[1].displayName, 'Updated');
  assert.deepEqual(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running', {rowIndex: 10, columnIndex: 1}).frames, [[9, 1]]);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running').frames, pack.animations.idle.frames);
  runtime.setPacks([{ ...idleOnly, builtinLumi: true }]);
  assert.equal(catalog[1].id, pack.petId, 'replacing a selected local pet with Lumi resources preserves its selectable identity');
  assert.equal(runtime.isLocalPet(pack.petId), true);
  runtime.setPacks([]);
  assert.deepEqual(catalog, [original]);
  assert.equal(runtime.isLocalPet(pack.petId), false);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running'), null);
  assert.equal(notified, 4);
  unsubscribe();
  runtime.setPacks([pack]);
  assert.equal(notified, 4);
});

test('animation music starts with the clip and stops on finish, cancellation or mute', async t => {
  const sounds = [], callbacks = new Map();
  let now = 0;
  const previousWindow = globalThis.window, previousAudio = globalThis.Audio;
  t.mock.method(performance, 'now', () => now);
  globalThis.window = {
    requestAnimationFrame(callback) { const id = Symbol(); callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  };
  globalThis.Audio = class {
    constructor(url) { this.url = url; this.currentTime = 0; this.paused = true; this.ended = false; sounds.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  t.after(() => { globalThis.window = previousWindow; globalThis.Audio = previousAudio; });
  const runtime = createPetAnimationRuntime([pack]);
  const animation = { pack, ...pack.animations.jumping, audioUrl: 'data:audio/mp4;base64,fixture' };
  const element = { style: {} };
  const tick = milliseconds => {
    now += milliseconds;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(now);
  };
  let stop = runtime.play(element, animation, false, false);
  assert.equal(sounds[0].paused, false);
  assert.equal(sounds[0].loop, false);
  assert.equal(callbacks.size, 0, 'the first frame waits for audio playback to start');
  await Promise.resolve();
  sounds[0].currentTime = 1.2;
  tick(1200);
  assert.equal(sounds[0].paused, true);
  assert.equal(element.style.backgroundPosition, '33.33333333333333% 100%');
  stop();
  stop = runtime.play(element, animation, false, false);
  stop();
  assert.equal(sounds[1].paused, true);
  stop = runtime.play(element, animation, false, false);
  runtime.setSoundEnabled(false);
  assert.equal(sounds[2].paused, true);
  tick(950);
  assert.equal(element.style.backgroundPosition, '0% 0%', 'muted playback continues with elapsed time');
  stop();
  for (const [reduced, still] of [[false, false], [true, false], [false, true]]) {
    runtime.play(element, { ...animation, still }, reduced, false)();
  }
  assert.equal(sounds.length, 3, 'muted animations do not create a player');
  runtime.setSoundEnabled(true);
  for (const [reduced, still] of [[true, false], [false, true]]) runtime.play(element, { ...animation, still }, reduced, false)();
  assert.equal(sounds.length, 3, 'still poses do not start music');
  stop = runtime.play(element, animation, false, true);
  assert.equal(sounds[3].loop, true);
  stop();
  assert.equal(callbacks.size, 0);
});

test('late paints follow the audio clock and silent playback keeps absolute elapsed time', async t => {
  const previousWindow = globalThis.window, previousAudio = globalThis.Audio;
  const callbacks = new Map(), sounds = [];
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  globalThis.window = {
    requestAnimationFrame(callback) { const id = Symbol(); callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  };
  globalThis.Audio = class {
    constructor() { this.currentTime = 0; this.paused = true; this.ended = false; sounds.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  t.after(() => { globalThis.window = previousWindow; globalThis.Audio = previousAudio; });
  const tick = value => {
    now = value;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(now);
  };
  const runtime = createPetAnimationRuntime([pack]);
  const animation = { pack, ...pack.animations.jumping, audioUrl: 'data:audio/mp4;base64,fixture' };
  const element = { style: {} };
  let stop = runtime.play(element, animation, false, false);
  await Promise.resolve();
  sounds[0].currentTime = 1.065;
  tick(1550);
  assert.equal(element.style.backgroundPosition, '66.66666666666666% 0%', 'a delayed paint skips to the frame matching audio time');
  runtime.setSoundEnabled(false);
  tick(1600);
  assert.equal(element.style.backgroundPosition, '33.33333333333333% 100%', 'muting preserves the media position before continuing silently');
  stop();
  const silent = render(rewriteRspackPets(nativeSource), [pack], { hover: true });
  silent.advance(1065);
  assert.equal(silent.element.style.backgroundPosition, '66.66666666666666% 0%');
  silent.cleanup();
  runtime.setSoundEnabled(true);
  stop = runtime.play(element, animation, false, false);
  await Promise.resolve();
  sounds[1].currentTime = 1.065;
  sounds[1].paused = sounds[1].ended = true;
  tick(2400);
  tick(2700);
  assert.equal(element.style.backgroundPosition, '33.33333333333333% 100%', 'natural audio completion continues through the silent tail');
  stop();
  stop = runtime.play(element, animation, false, true);
  await Promise.resolve();
  sounds[2].currentTime = 0.955;
  tick(3655);
  assert.equal(element.style.backgroundPosition, '0% 0%');
  sounds[2].currentTime = 0.2;
  tick(3760);
  assert.equal(element.style.backgroundPosition, '66.66666666666666% 0%', 'a shorter audio loop does not skip the visual tail');
  tick(3814);
  assert.equal(element.style.backgroundPosition, '0% 100%', 'the whole visual cycle completes before restarting');
  stop();
});

test('pet audio activation uses the requested player in its own renderer context', async () => {
  const commands = [], events = new Map();
  const cdp = { async send(method, params) { commands.push({ method, params }); }, on(name, callback) { events.set(name, callback); } };
  await installPetAudioBinding(cdp);
  await installPetAudioBinding(cdp);
  assert.equal(commands.length, 1);
  const callback = events.get('Runtime.bindingCalled');
  callback({ name: '__codexPanelPlayPetAudioV1', payload: '4);globalThis.unrelated()', executionContextId: 8 });
  assert.equal(commands.length, 1);
  callback({ name: '__codexPanelPlayPetAudioV1', payload: '4', executionContextId: 8 });
  assert.deepEqual(commands[1], { method: 'Runtime.evaluate', params: {
    expression: 'globalThis.__codexPanelPetAnimations__?.playAudio(4)',
    contextId: 8, userGesture: true, awaitPromise: true, returnByValue: true,
  } });
});

test('packaged Lumi joins the native catalog and selection stays local', async () => {
  // Native 27194 catalog and cloud selection structures, with unrelated pets and services omitted.
  const catalog = 'function(e,t,n){let i=[{assetRef:"codex",description:"The original Codex companion.",displayName:"Codex",id:"codex",spriteVersionNumber:2}];t.B4=i;t.SV=e=>e.startsWith("custom:");t.i0=(e,t)=>[...(e??[]),...(t??[]),...i];t.aN=e=>null==e.spritesheetUrl?{assetRef:e.assetRef}:{petId:e.id,spriteRowCount:11,spritesheetUrl:e.spritesheetUrl}}';
  const cloud = 'function(e,t,n){let g=n("catalog");function D(e){return e.startsWith("pet_")&&e.length>4||g.B4.some(({id:t})=>t===e)}t.select=e=>{if(D(e))n("account").safePatch("/settings/account_user_setting",{value:e,scope:"cloud-pet-selection"})}}';
  const builtin = { id: 'panel-lumi', displayName: 'Lumi', spriteVersionNumber: 2, spritesheetUrl: 'data:image/webp;base64,fixture' };
  const settingsWrites = [], cloudWrites = [];
  let selected = 'panel-lumi';
  const nativeCatalog = {}, nativeCloud = {};
  const context = vm.createContext({
    window: { setTimeout },
    __codexPanelPetAnimations__: createPetAnimationRuntime([], builtin),
  });
  const load = id => ({ catalog: nativeCatalog, services: { appServices: { settings: {
    async read(key) { assert.equal(key, 'selected-avatar-id'); return { configured: null, effective: selected }; },
    async write(...args) { settingsWrites.push(args); selected = args[1]; },
  } } }, account: { safePatch(...args) { cloudWrites.push(args); } } })[id];
  vm.runInContext(`(${rewriteRspackPets(catalog)})`, context)({}, nativeCatalog, load);
  vm.runInContext(`(${rewriteRspackPets(cloud)})`, context)({}, nativeCloud, load);
  assert.equal(nativeCatalog.B4.at(-1), builtin);
  assert.equal(nativeCatalog.i0([], []).at(-1), builtin);
  assert.equal(nativeCatalog.i0([{ id: 'custom:fixture' }], [{ id: 'pet_fixture' }]).at(-1), builtin);
  assert.deepEqual({ ...nativeCatalog.aN(builtin) }, { petId: 'panel-lumi', spriteRowCount: 11, spritesheetUrl: builtin.spritesheetUrl });
  nativeCloud.select('panel-lumi');
  assert.equal(cloudWrites.length, 0);
  for (const id of ['codex', 'pet_fixture']) nativeCloud.select(id);
  assert.equal(cloudWrites.length, 2);
  context.__codexPanelRspack__ = {
    require: load, prepared: { pets: true },
    nativeServices: {
      desktopServices: { id: 'services', exportName: 'appServices' },
      petCatalog: { id: 'catalog', exportName: 'B4' },
    },
    loadModule: async id => load(id),
  };
  const selection = vm.runInContext(`(${nativePetSelection})`, context);
  assert.equal((await selection(load, 'pet-selection')).petId, 'panel-lumi');
  assert.equal(settingsWrites.length, 0);
  assert.equal((await selection(load, 'cancel-lumi')).petId, null);
  assert.deepEqual(settingsWrites, [['selected-avatar-id', null]]);
  selected = 'pet_fixture';
  assert.equal((await selection(load, 'cancel-lumi')).petId, 'pet_fixture');
  assert.equal(settingsWrites.length, 1);
  assert.equal((await selection(load, 'use-lumi')).petId, 'panel-lumi');
  assert.deepEqual(settingsWrites, [['selected-avatar-id', null], ['selected-avatar-id', 'panel-lumi']]);

  const cloudPack = { ...pack, petId: 'pet_fixture' };
  const existingPack = { ...pack, petId: 'custom:fixture' };
  const duplicateLumi = { ...pack, petId: 'another-lumi', builtinLumi: true };
  const nativeOverride = { ...pack, petId: 'codex' };
  context.__codexPanelPetAnimations__.setPacks([pack, cloudPack, existingPack, duplicateLumi, nativeOverride]);
  assert.deepEqual(Array.from(nativeCatalog.B4, pet => pet.id), ['codex', 'panel-lumi', pack.petId, duplicateLumi.petId]);
  assert.equal(nativeCatalog.i0([], []).at(-1).id, duplicateLumi.petId);
  assert.equal(nativeCatalog.aN(nativeCatalog.B4.at(-1)).spritesheetUrl, pack.spritesheetUrl);
  nativeCloud.select(pack.petId);
  assert.equal(cloudWrites.length, 2);
  nativeCloud.select(duplicateLumi.petId);
  assert.equal(cloudWrites.length, 2);
  nativeCloud.select(cloudPack.petId);
  assert.equal(cloudWrites.length, 3);
  assert.equal((await selection(load, 'use-pet', [], pack.petId)).petId, pack.petId);
  selected = 'pet_fixture';
  assert.equal((await selection(load, 'cancel-pet', [], pack.petId)).petId, 'pet_fixture');
  selected = pack.petId;
  assert.equal((await selection(load, 'cancel-pet', [], pack.petId)).petId, null);
  await assert.rejects(selection(load, 'use-pet', [], 'not-imported'), /尚未导入/);
  await assert.rejects(selection(load, 'use-pet', [], cloudPack.petId), /原生选择器/);
  assert.equal((await selection(load, 'use-pet', [], nativeOverride.petId)).petId, 'codex');
  assert.equal(context.__codexPanelPetAnimations__.resolve([cloudPack], {petId: cloudPack.petId}, 'failed'), null);
  context.__codexPanelPetAnimations__.setPacks([]);
  assert.deepEqual(Array.from(nativeCatalog.B4, pet => pet.id), ['codex', 'panel-lumi']);
  selected = 'panel-lumi';
  nativeCatalog.B4.pop();
  await assert.rejects(selection(load, 'use-lumi'), /尚未载入内置 Lumi/);
  assert.equal((await selection(load, 'pet-selection')).petId, 'panel-lumi');
  assert.equal((await selection(load, 'cancel-lumi')).petId, null);
  assert.equal(settingsWrites.length, 6);
});

test('pet controls use trusted imports and synchronize both windows before selection', async () => {
  const injector = await readFile(new URL('../scripts/codex-injector.mjs', import.meta.url), 'utf8');
  const start = injector.indexOf('...Object.fromEntries(["pet-selection", "use-lumi", "cancel-lumi", "use-pet", "cancel-pet"].map(');
  const end = injector.indexOf('\n          "interrupt-thread"', start);
  assert.ok(start > 0 && end > start);
  let selected = 'pet_unrelated', reads = 0;
  const writes = [], syncs = [];
  const nativeCatalog = { B4: [{ id: 'codex' }] };
  const petRuntime = createPetAnimationRuntime([pack]);
  petRuntime.bindCatalog(nativeCatalog.B4);
  const load = id => id === 'catalog' ? nativeCatalog : ({ appServices: { settings: {
    async read() { return { configured: null, effective: selected }; },
    async write(key, value) {
      if (value === pack.petId) assert.equal(syncs.length, 1, 'synchronize the imported catalog before selecting it');
      writes.push([key, value]); selected = value;
    },
  } } });
  load.m = {};
  const page = vm.createContext({
    __codexPanelPetAnimations__: petRuntime,
    __codexPanelRspack__: { require: load, prepared: { pets: true },
      nativeServices: {
        desktopServices: { id: 'services', exportName: 'appServices' },
        petCatalog: { id: 'catalog', exportName: 'B4' },
      },
      loadModule: async id => load(id) },
  });
  const cdp = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: await vm.runInContext(params.expression, page) } };
  } };
  const avatar = { closed: false };
  const handlers = vm.runInNewContext(`({${injector.slice(start, end)}})`, {
    injectedTargets: new Map([['native', cdp]]), avatarConnections: new Map([['avatar', avatar]]), panelDataDirectory: '/isolated/panel-data',
    nativePetSelection, findCodexRspackRequire,
    async readPetAnimations(directory) { assert.equal(directory, '/isolated/panel-data'); return [pack]; },
    async syncPetAnimations(directory, connections) {
      assert.equal(directory, '/isolated/panel-data');
      assert.equal(connections.length, 2);
      assert.equal(connections[0], cdp);
      assert.equal(connections[1], avatar);
      syncs.push(connections);
    },
    async listPetAnimations(directory) {
      assert.equal(directory, '/isolated/panel-data'); reads++;
      return [{ petId: 'pet_old_lumi', builtinLumi: true }, { petId: 'pet_unrelated', builtinLumi: false }];
    },
  });
  assert.equal((await handlers['cancel-lumi']({ lumiPetIds: ['pet_unrelated'] })).petId, 'pet_unrelated');
  assert.equal(writes.length, 0);
  selected = 'pet_old_lumi';
  assert.equal((await handlers['pet-selection']({})).petId, 'pet_old_lumi');
  assert.equal(reads, 1);
  assert.equal((await handlers['cancel-lumi']({ lumiPetIds: [] })).petId, null);
  assert.equal(reads, 2);
  assert.deepEqual(writes, [['selected-avatar-id', null]]);
  assert.equal((await handlers['use-pet']({ petId: pack.petId })).petId, pack.petId);
  assert.deepEqual(writes.at(-1), ['selected-avatar-id', pack.petId]);
  selected = 'pet_unrelated';
  const written = writes.length;
  assert.equal((await handlers['cancel-pet']({ petId: pack.petId })).petId, selected);
  assert.equal(writes.length, written);
  selected = pack.petId;
  assert.equal((await handlers['cancel-pet']({ petId: pack.petId })).petId, null);
  assert.deepEqual(writes.at(-1), ['selected-avatar-id', null]);
  const synchronized = syncs.length;
  for (const action of ['use-pet', 'cancel-pet']) {
    await assert.rejects(handlers[action]({ petId: 'not-imported', packs: [{ petId: 'not-imported' }] }), /尚未导入/);
  }
  assert.equal(syncs.length, synchronized, 'request-supplied resources cannot reach the renderer');
  assert.equal(writes.length, written + 1);
});
