import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createPetAnimationRuntime, rewriteRspackPets, nativePetSelection } from '../scripts/codex-rspack-pets.mjs';
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

function render(source, packs, { petId = pack.petId, state = 'idle', hover = false, reduced = false, lookFrame } = {}) {
  const element = { style: {} }, effects = [], timers = new Map(), hoverChanges = [];
  let timerId = 0;
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
    },
    packs,
  });
  vm.runInContext(`globalThis.__codexPanelPetAnimations__=(${createPetAnimationRuntime})(packs)`, context);
  vm.runInContext(`(${source})`, context)({}, exports, require);
  const output = exports.bH({
    source: { petId, spriteRowCount: 11, spritesheetUrl: 'native.webp' },
    assetMap: {}, state, lookFrame, respondToHover: true,
  });
  return { output, element, timers, hoverChanges, cleanup: effects.at(-1)() };
}

test('imported pet clips use their own grid, states and idle timing with native hover cancellation', () => {
  const patchedSource = rewriteRspackPets(nativeSource);
  const playing = render(patchedSource, [pack], { hover: true });
  assert.equal(playing.output.props.style.backgroundSize, '400% 300%');
  assert.equal(playing.output.props.style.backgroundImage, `url(${pack.spritesheetUrl})`);
  for (const [cell, duration] of pack.animations.jumping.frames) {
    assert.equal(playing.element.style.backgroundPosition, `${cell % 4 / 3 * 100}% ${Math.floor(cell / 4) / 2 * 100}%`);
    const [id, timer] = [...playing.timers][0];
    assert.equal(timer.delay, duration);
    playing.timers.delete(id);
    timer.callback();
  }
  assert.equal(playing.element.style.backgroundPosition, '33.33333333333333% 100%');
  assert.equal([...playing.timers.values()][0].delay, 1680);
  playing.output.props.onPointerLeave();
  assert.deepEqual(playing.hoverChanges, [false]);
  playing.cleanup();
  assert.equal(playing.timers.size, 0);

  for (const state of ['idle', 'running', 'review']) {
    const result = render(patchedSource, [pack], { state });
    assert.equal(result.output.props.style.backgroundImage, `url(${pack.spritesheetUrl})`);
    result.cleanup();
  }
  const looking = render(patchedSource, [pack], { lookFrame: { rowIndex: 10, columnIndex: 4 } });
  assert.equal(looking.element.style.backgroundPosition, '0% 0%');
  assert.equal(looking.timers.size, 0);
  const paused = render(patchedSource, [pack], { lookFrame: { rowIndex: 0, columnIndex: 0 } });
  assert.equal(paused.element.style.backgroundPosition, '33.33333333333333% 100%');
  assert.equal(paused.timers.size, 0);
  const reduced = render(patchedSource, [pack], { hover: true, reduced: true });
  assert.equal(reduced.element.style.backgroundPosition, '0% 100%');
  assert.equal(reduced.timers.size, 0);

  for (const options of [{ petId: 'unconfigured-pet', hover: true }, { state: 'failed' }]) {
    const before = render(nativeSource, [], options), after = render(patchedSource, [pack], options);
    assert.deepEqual({ ...after.output.props.style }, { ...before.output.props.style });
    assert.deepEqual(after.element.style, before.element.style);
    before.cleanup?.(); after.cleanup?.();
  }
});

test('replacing and removing imported data notifies renderer subscriptions', () => {
  const runtime = createPetAnimationRuntime([]);
  let notified = 0;
  const unsubscribe = runtime.subscribe(() => notified++);
  runtime.setPacks([pack]);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running').pack, pack);
  runtime.setPacks([]);
  assert.equal(runtime.resolve(runtime.getSnapshot(), {petId: pack.petId}, 'running'), null);
  assert.equal(notified, 2);
  unsubscribe();
  runtime.setPacks([pack]);
  assert.equal(notified, 2);
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
    findModule: markers => ({ id: markers.includes('appServices:') ? 'services' : 'catalog' }),
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
  nativeCatalog.B4.pop();
  await assert.rejects(selection(load, 'use-lumi'), /尚未载入内置 Lumi/);
  assert.equal((await selection(load, 'pet-selection')).petId, 'panel-lumi');
  assert.equal((await selection(load, 'cancel-lumi')).petId, null);
  assert.equal(settingsWrites.length, 3);
});

test('cancel Lumi resolves aliases from local packs and ignores request-supplied IDs', async () => {
  const injector = await readFile(new URL('../scripts/codex-injector.mjs', import.meta.url), 'utf8');
  const start = injector.indexOf('...Object.fromEntries(["pet-selection", "use-lumi", "cancel-lumi"].map(');
  const end = injector.indexOf('\n          "interrupt-thread"', start);
  assert.ok(start > 0 && end > start);
  let selected = 'pet_unrelated', reads = 0;
  const writes = [];
  const load = () => ({ appServices: { settings: {
    async read() { return { configured: null, effective: selected }; },
    async write(key, value) { writes.push([key, value]); selected = value; },
  } } });
  load.m = {};
  const page = vm.createContext({
    __codexPanelRspack__: { require: load, findModule: () => ({ id: 'services' }) },
  });
  const cdp = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: await vm.runInContext(params.expression, page) } };
  } };
  const handlers = vm.runInNewContext(`({${injector.slice(start, end)}})`, {
    injectedTargets: new Map([['native', cdp]]), panelDataDirectory: '/isolated/panel-data',
    nativePetSelection, findCodexRspackRequire,
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
});
