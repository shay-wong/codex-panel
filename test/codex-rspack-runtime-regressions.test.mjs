import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { rewriteRspackDot, rewriteRspackUltrafast } from '../scripts/codex-rspack-capabilities.mjs';
import { rewriteRspackQuota } from '../scripts/codex-rspack-quota.mjs';

function context(sources) {
  return {
    moduleSource: id => sources[id] ?? null,
    findModule(markers) {
      const terms = Array.isArray(markers) ? markers : [markers];
      const found = Object.entries(sources).filter(([, source]) => terms.every(term => source.includes(term)));
      return found.length === 1 ? { id: found[0][0], source: found[0][1] } : null;
    },
  };
}

function execute(source, modules, globals = {}) {
  const result = {};
  const load = id => modules[id];
  load.d = (target, getters, values = {}) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get });
    Object.assign(target, values);
  };
  vm.runInNewContext(`(${source})`, globals)({}, result, load);
  return result;
}

// Codex 25241 GNwQ.T treats a second argument as a family key, even when it is undefined.
const nativeReader = `function T(e,t,n,i,r){return function(o,a,s){if(_(o))return x(t,e,o,n,C(i,2==arguments.length&&f(o)?a:void 0),r);if(f(o)&&2==arguments.length){let s=(0,A.u6)(t,e,o.scope),l=m(o,C(i,a)),c=r?.(l,s,e,n)??l.resolve(s,e);return p(s,c,n)}if(void 0!==a||arguments.length>=2){let l=(0,A.u6)(t,e,o.scope);if(O(o))return o.read(l,e,a,n,C(i,s),r);let c=o[E.ak](l,e,a);return null!=c.disposal&&null!=n&&n(c.disposal.atom),c.value}let l=(0,A.u6)(t,e,o.scope),c=m(o,C(i,s)),d=r?.(c,l,e,n)??c.resolve(l,e);return p(l,d,n)}}`;

test('Dot reads the native scalar signal without entering the family-key branch', () => {
  const familyKey = Symbol('family-key');
  const nativeGet = vm.runInNewContext(`(${nativeReader})`, {
    _: () => false, f: () => false, O: () => false,
    A: { u6: () => ({}) }, E: { ak: familyKey },
    C: (_i, value) => value, m: value => value, p: (_scope, atom) => atom.value,
  })({}, {});
  const signal = (_scope, read) => ({ cache: 'signal', scope: {}, resolve: () => ({ value: read() }) });
  assert.throws(() => nativeGet(signal(null, () => true), undefined), /o\[E.ak\] is not a function/);
  const sources = {
    reactive: 'function(module,exports,load){var state=load("state");load.d(exports,{signal:()=>state.value});}',
    state: 'function(module,exports,load){load.d(exports,{}, {value:function(scope,read,options){let atom=(0,other.build)("signal",scope,read);return atom}})}',
  };
  const source = 'function(module,exports,load){load.d(exports,{capability:()=>capability});var reactive=load("reactive"),scope=load("scope");const a="Duplicate capability name:",b="Explicit-host capability requires hostId:";let definitions={orbit:{},"orbit.navigation":{},other:{}},capability=(0,reactive.family)(scope.value,(request,{get:read})=>{var unused;let config=definitions[request.name];if(config==null)return{isLoading:false,isError:false,isCapable:false};return{isLoading:false,isError:false,isCapable:false}})}';
  let enabled = true;
  const { capability } = execute(rewriteRspackDot(source, context(sources)), {
    reactive: { signal, family: (_scope, read) => request => read(request, { get: nativeGet }) },
    scope: { value: {} },
  }, { __codexPanelDotEntryV1__: { getSnapshot: () => enabled, subscribe() {} } });
  assert.equal(capability({ name: 'orbit' }).isCapable, true);
  assert.equal(capability({ name: 'orbit.navigation' }).isCapable, true);
  enabled = false;
  assert.equal(capability({ name: 'orbit' }).isCapable, false);
  assert.equal(capability({ name: 'other' }).isCapable, false);
});

test('Ultrafast keeps the factory require when the native hook shadows its name', () => {
  const provider = 'function(module,exports,load){var target=load("target"),config=load("config"),provider=load("provider");const marker="model_picker_upsell";function read(store,thread){let{cwd:cwd,hostId:host}=store.get(target.atom,thread);if("local"!==host)return null;let{data:data}=store.get(config.atom,{cwd:cwd,hostId:host});return null==data||(store.get(provider.atom,thread)??data.model_provider??"openai")!=="openai"?null:quota(store)}}';
  const source = `function(module,exports,load){load.d(exports,{settings:()=>settings});var react=load("react"),signal=load("signal"),scope=load("scope"),access=load("access"),model=load("model"),extra=load("extra");function settings(thread,options){let result=function(e,selection,load){let context=(0,scope.target)(e);(0,react.use)(null);let host=context.hostId;let unused=(0,signal.read)(extra.atom,e);let{serviceTierAccess:allowed}=(0,access.read)(context);let selected=(0,model.select)(options?.models,selection.model),other=null;return{hasManagedNewThreadSettings:false,serviceTierAccess:allowed,serviceTierSettings:{serviceTierForRequest:selected.serviceTiers.find(t=>t.id==="ultrafast")?.id??null},setServiceTier:t=>t!=="ultrafast"||allowed.ultrafast}}(thread,options,null);let{serviceTierAccess:chosen,...rest}=result;let setter=value=>value!=="ultrafast"||chosen.ultrafast;return{...rest,setServiceTier:setter}}}`;
  const options = { model: 'gpt-6-astra', models: [{ model: 'gpt-6-astra', serviceTiers: [{ id: 'standard' }] }] };
  const modules = {
    react: { use() {}, useSyncExternalStore: (_subscribe, read) => read() },
    signal: { read: atom => atom === 'target' ? { hostId: 'local', cwd: '/disposable' }
      : atom === 'config' ? { data: { model_provider: 'custom' } } : atom === 'provider' ? 'custom' : null },
    scope: { target: () => ({ hostId: 'local' }) },
    access: { read: () => ({ serviceTierAccess: { ultrafast: false } }) },
    model: { select: (models, selected) => models.find(value => value.model === selected) },
    extra: {}, target: { atom: 'target' }, config: { atom: 'config' }, provider: { atom: 'provider' },
  };
  const globals = { __codexPanelProviderUltrafastV1__: { subscribe() {}, getSnapshot: () => true } };
  const rewritten = rewriteRspackUltrafast(source, context({ reader: provider }));
  const result = execute(rewritten, modules, globals).settings('thread', options);
  assert.equal(result.serviceTierAccess.ultrafast, true);
  assert.equal(result.serviceTierSettings.serviceTierForRequest, 'ultrafast');
  assert.equal(result.setServiceTier('ultrafast'), true);
});

test('quota rendering keeps the factory require when compiler temporaries reuse its name', () => {
  const reader = 'function(e,t,r){var target=r("targets"),config=r("config"),provider=r("providers");const kind="model_picker_upsell";function read(e,o,t="fresh"){let{cwd:l,hostId:i}=e.get(target.scope,o);if("local"!==i)return null;let{data:c}=e.get(config.options,{cwd:l,hostId:i});return null==c||(e.get(provider.name,o)??c.model_provider??"openai")!=="openai"?null:kind;}}';
  const source = 'function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId}){let n=null;(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);const hostQuota=(0,hooks.read)(quota.host,host),workQuota=(0,hooks.atom)("local"===host&&quota.work);let status="ready",error=null,policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let disabled=policyBlock||hostQuota||workQuota;return{"data-codex-composer-root":"",submitDisabled:disabled,onSubmit:()=>!disabled};}}';
  const dependencies = {
    react: { useState: () => [null], useSyncExternalStore: (_subscribe, get) => get() },
    hooks: {
      read: atom => atom === 'host' ? 'local' : atom === 'quota' ? true : atom === 'scope'
        ? { cwd: '/disposable', hostId: 'local' } : atom === 'config' ? { data: { model_provider: 'custom' } } : 'custom',
      atom: () => true,
    },
    thread: { host: 'host' }, quota: { host: 'quota', work: 'work' },
    targets: { scope: 'scope' }, config: { options: 'config' }, providers: { name: 'provider' },
  };
  const ctx = context({ reader, targets: 'function(){}', config: 'function(){}', providers: 'function(){}' });
  let enabled = true;
  const { CodexComposerAdapter } = execute(rewriteRspackQuota(source, ctx), dependencies,
    { __codexPanelProviderQuotaV1__: { subscribe() {}, getSnapshot: () => enabled } });
  assert.equal(CodexComposerAdapter({ threadId: 'thread' }).onSubmit(), true);
  enabled = false;
  assert.equal(CodexComposerAdapter({ threadId: 'thread' }).onSubmit(), false);
});
