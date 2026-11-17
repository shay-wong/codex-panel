import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildRspackPlan, createCodexRspackRuntime, rewriteRspackQueue } from '../scripts/codex-rspack.mjs';

// Native MYVk factory: its mount callback shadows the factory's require argument.
const queueSource = 'function(e,t,n){var r=n("SZCv"),i=n.n(r),a=n("zTeN"),s=n("DBCl"),o=n("bBSc"),l=n("vdpW"),u=n("Ryoj"),d=n("OWtl");let c=(0,a.T1)(d.u,e=>({messages:void 0}),{autoDispose:6e4}),p=(0,a.A4)(d.u,(e,{get:t})=>t(c,e).messages,(e,{get:t,set:n,scope:r})=>{if(null==e)return;let i=t(c,e);return(0,o.j)(r,e,(e,t,n)=>e.rpc.subscribe({type:"thread",key:t,field:"queuedMessages",listener:n}),t=>{for(let a of(i.messages=t,n(t),t??[]))(0,u.L)(r,e,(0,s.sx6)(a))},()=>{i.messages=void 0,n(void 0)})},{isEqual:i()}),h=(0,a.i1)(d.u,(e,{get:t})=>{let n=t(p,e);if(null==e||null==n||0===n.length)return[];let r=n.flatMap(e=>e.pausedReason||e.submission?.status==="outcome-unknown"?[]:[(0,s.sx6)(e)]);if(0===r.length)return[];let i=t(l.M,e)??[],a=new Set;for(let e=i.length-1;e>=0;e--){let n=i[e],s=t(l.Ko,n);if(s?.params.clientUserMessageId!=null&&(a.add(s.params.clientUserMessageId),r.every(e=>a.has(e))))break;for(let{itemId:e,type:i}of t(l.cC,n)??[]){if("userMessage"!==i&&"steeringUserMessage"!==i)continue;let s=t(l.Hc,{...n,itemId:e});if(null!=s&&(a.add(s),r.every(e=>a.has(e))))break}if(r.every(e=>a.has(e)))break}return r.filter(e=>a.has(e))},{autoDispose:!0,isEqual:i()}),f=(0,a.i1)(d.u,({clientUserMessageId:e,...t},{get:n})=>null!=e&&!n(h,t).includes(e)&&n(p,t)?.some(t=>null!=t.submission&&(0,s.sx6)(t)===e)===!0);n.d(t,{},{Ax:p,JZ:h,Zg:f})}';

// jMec's publication signal and derived readiness retain their native export shape.
const publicationSource = 'function(e,t,n){var r=n("zTeN"),i=n("OWtl"),a=n("GaA7");let d=(0,r.vP)(i.u,()=>void 0,{onMount:e=>a.appServices.statsigEvaluations.subscribe(e)}),c=(0,r.un)(i.u,({get:e})=>{let t=e(d);if(t?.hasEvaluations!==void 0)return t.hasEvaluations?t.defaultEnableFeatures:{} });n.d(t,{},{B:c,L:d})}';
const versionSource = 'function(e,t,n){var r=n("zTeN"),i=n("rljs"),a=n("OWtl");let s=(0,r.i1)(a.u,(e,{get:t})=>t(t(i.kA,e).appServerVersion$)??null),o=(0,r.vP)(a.u,()=>["local"]);n.d(t,{},{B:s,D:o})}';
const otherSource = 'function(e,t,n){t.read=()=>"native";t.subscribe=(e,t,n)=>e.rpc.subscribe({type:"thread",key:t,field:"queuedMessages",listener:n})}';

function scopeFixture() {
  const read = (atom, keys, get) => {
    if (atom.kind === 'family') {
      if (!atom.values.has(keys[0])) atom.values.set(keys[0], atom.create(keys[0]));
      return atom.values.get(keys[0]);
    }
    if (atom.kind === 'derived') return atom.read(keys[0], { get });
    assert.equal(keys.length, 0, 'publication is a scalar signal');
    return atom.value;
  };
  const get = (atom, ...keys) => read(atom, keys, get);
  return {
    get,
    set(atom, value) {
      atom.value = value;
      for (const notify of [...atom.listeners]) notify();
    },
    watch(effect) {
      let cleanup;
      const dependencies = new Set();
      const clear = () => {
        for (const atom of dependencies) atom.listeners.delete(run);
        dependencies.clear();
        cleanup?.();
        cleanup = undefined;
      };
      const run = () => {
        clear();
        const tracked = (atom, ...keys) => {
          if (atom.listeners) { dependencies.add(atom); atom.listeners.add(run); }
          return read(atom, keys, tracked);
        };
        cleanup = effect({ get: tracked });
      };
      run();
      return clear;
    },
  };
}

function harness(adapt, { settingsReady = false, versionReady = true } = {}) {
  const scope = scopeFixture(), key = { hostId: 'local', threadId: 'fixture-thread' };
  const coreMessages = [{ id: 'queued-before-reload' }], snapshots = [], subscriptions = [], active = new Set();
  let mainReady = settingsReady;
  const version = { value: versionReady ? '0.169.0-fixture' : null, listeners: new Set() };
  const rpc = {
    subscribe({ type, key: thread, field, listener }) {
      assert.equal(type, 'thread');
      assert.equal(thread, key);
      assert.equal(field, 'queuedMessages');
      const entry = { disposed: 0 };
      subscriptions.push(entry);
      active.add(entry);
      assert.equal(active.size, 1, 'old RPC subscription is disposed before resubscribing');
      listener(mainReady && version.value ? coreMessages : []);
      return () => { entry.disposed++; active.delete(entry); };
    },
  };
  const reactive = {
    T1: (_scope, create) => ({ kind: 'family', create, values: new Map() }),
    A4: (_scope, read, mount) => ({ kind: 'derived', read, mount }),
    i1: (_scope, read) => ({ kind: 'derived', read }),
    un: (_scope, read) => ({ kind: 'derived', read }),
    vP: (_scope, initial) => ({ value: initial(), listeners: new Set() }),
  };
  const dependencies = {
    SZCv: () => Object.is, zTeN: reactive, DBCl: { sx6: message => message.id },
    bBSc: { j: (_scope, thread, subscribe, onData) => subscribe({ rpc }, thread, onData) },
    vdpW: {}, Ryoj: { L() {} }, OWtl: { u: Symbol('scope') }, GaA7: {},
    rljs: { kA: { kind: 'derived', read: () => ({ appServerVersion$: version }) } },
  };
  const sources = { MYVk: queueSource, jMec: publicationSource, CfsC: versionSource, other: otherSource };
  const factories = new Map(Object.entries(sources).map(([id, source]) => [id, { id, source, chunkIds: [42] }]));
  const plan = buildRspackPlan({ factories }, adapt ? { queue: rewriteRspackQueue } : {});
  const table = Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, vm.runInNewContext(`(${source})`)]));
  const originalOther = table.other, cache = new Map();
  const load = id => {
    if (id in dependencies) return dependencies[id];
    if (!cache.has(id)) {
      const module = { exports: {} };
      cache.set(id, module);
      load.m[id](module, module.exports, load);
    }
    return cache.get(id).exports;
  };
  load.n = value => () => value;
  load.d = (exports, getters, values = {}) => {
    for (const [name, getter] of Object.entries(getters)) Object.defineProperty(exports, name, { get: getter });
    Object.assign(exports, values);
  };
  load.m = createCodexRspackRuntime(plan).wrapFactories(table, load);
  const published = load('jMec').L, queue = load('MYVk').Ax;
  if (settingsReady) published.value = { hasEvaluations: true, defaultEnableFeatures: {} };
  const stop = queue.mount(key, { get: scope.get, set: value => snapshots.push(value), scope });
  return {
    plan, coreMessages, snapshots, subscriptions, active, published, stop,
    otherUnchanged: load.m.other === originalOther,
    otherValue: load('other').read(),
    messages: () => scope.get(queue, key),
    version,
    publishVersion(value) { scope.set(version, value); },
    publish(ready) {
      mainReady = ready;
      scope.set(published, { hasEvaluations: ready, defaultEnableFeatures: {} });
    },
  };
}

test('an empty native startup subscription stays empty when only readiness changes', t => {
  const native = harness(false);
  t.after(native.stop);
  assert.equal(native.coreMessages.length, 1);
  assert.equal(native.messages().length, 0);
  native.publish(true);
  assert.equal(native.messages().length, 0, 'reproduces the stale UI despite the retained server queue');
  assert.equal(native.snapshots.length, 1);
  assert.equal(native.subscriptions.length, 1);
});

test('republishing evaluations restores the native queue and disposes every RPC subscription', t => {
  const adapted = harness(true);
  t.after(adapted.stop);
  assert.equal(adapted.plan.prepared.queue, true);
  assert.deepEqual(Object.keys(adapted.plan.patches), ['MYVk']);
  assert.deepEqual(adapted.plan.chunks, { jMec: [42], CfsC: [42] });
  assert.equal(adapted.otherUnchanged, true);
  assert.equal(adapted.otherValue, 'native');
  assert.equal(adapted.coreMessages.length, 1);
  assert.equal(adapted.messages().length, 0);
  adapted.publish(true);
  assert.equal(adapted.messages().length, 1, 'the existing mount updates without navigating or remounting');
  assert.equal(adapted.messages()[0], adapted.coreMessages[0]);
  adapted.publish(false);
  assert.equal(adapted.messages().length, 0);
  adapted.publish(true);
  assert.equal(adapted.messages().length, 1);
  assert.equal(adapted.subscriptions.length, 4);
  assert.deepEqual(adapted.subscriptions.map(entry => entry.disposed), [1, 1, 1, 0]);
  adapted.stop();
  assert.equal(adapted.active.size, 0);
  assert.equal(adapted.published.listeners.size, 0);
  assert.equal(adapted.version.listeners.size, 0);
  assert.ok(adapted.subscriptions.every(entry => entry.disposed === 1));
  adapted.publish(false);
  assert.equal(adapted.subscriptions.length, 4, 'disposing the watch also removes its publication listener');
});

test('a late core version refreshes the queue without republishing ready settings', t => {
  const native = harness(false, { settingsReady: true, versionReady: false });
  const adapted = harness(true, { settingsReady: true, versionReady: false });
  t.after(native.stop);
  t.after(adapted.stop);
  const published = adapted.published.value;
  assert.equal(adapted.messages().length, 0);
  native.publishVersion('0.169.0-fixture');
  adapted.publishVersion('0.169.0-fixture');
  assert.equal(native.messages().length, 0);
  assert.equal(adapted.published.value, published);
  assert.equal(adapted.messages()[0], adapted.coreMessages[0]);
  assert.equal(adapted.subscriptions.length, 2);
  assert.deepEqual(adapted.subscriptions.map(entry => entry.disposed), [1, 0]);
});
