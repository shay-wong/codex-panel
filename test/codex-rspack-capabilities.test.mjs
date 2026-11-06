import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { rewriteRspackDot, rewriteRspackUltrafast } from '../scripts/codex-rspack-capabilities.mjs';

const providerSource = `function(module,exports,load){var target=load("target-module"),config=load("config-module"),provider=load("provider-module");const marker="model_picker_upsell";function read(store,thread){let{cwd:cwd,hostId:host}=store.get(target.atom,thread);if("local"!==host)return null;let{data:data}=store.get(config.atom,{cwd:cwd,hostId:host});return null==data||(store.get(provider.atom,thread)??data.model_provider??"openai")!=="openai"?null:quota(store)}}`;
const hookSource = `function(module,exports,load){
  load.d(exports,{settings:()=>settings});var react=load("react"),signal=load("signal"),scope=load("scope"),access=load("access"),model=load("model"),extra=load("extra");
  function settings(thread,options){
    let result=function(e,selection,load){let context=(0,scope.target)(e);(0,react.use)(null);let host=context.hostId;
      let unused=(0,signal.read)(extra.atom,e);
      let{serviceTierAccess:allowed}=(0,access.read)(context);
      let selected=(0,model.select)(options?.models,selection.model),other=null;
      let available=selected?.serviceTiers.filter(t=>t.id!=="ultrafast"||allowed.ultrafast).map(t=>({value:t.id}))??[];
      return {hasManagedNewThreadSettings:false,serviceTierAccess:allowed,serviceTierSettings:{availableOptions:available,serviceTierForRequest:available.some(t=>t.value==="ultrafast")?"ultrafast":null},setServiceTier:t=>t!=="ultrafast"||allowed.ultrafast};
    }(thread,options,options.serviceTier);
    let{serviceTierAccess:chosen,...rest}=result;
    let set=value=>value!=="ultrafast"||chosen.ultrafast;return {...rest,setServiceTier:set};
  }
}`;

function context(sources) {
  return {
    moduleSource: id => sources[id] ?? null,
    findModule(needle) {
      const needles = Array.isArray(needle) ? needle : [needle];
      const matches = Object.entries(sources).filter(([, source]) => needles.every(value => source.includes(value)));
      return matches.length === 1 ? { id: matches[0][0], source: matches[0][1] } : null;
    },
  };
}

function execute(source, dependencies, globals = {}) {
  const module = { exports: {} };
  const load = id => {
    assert.ok(id in dependencies, `unexpected module ${id}`);
    return dependencies[id];
  };
  load.d = (exports, getters) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get });
  };
  vm.runInNewContext('(' + source + ')', globals)(module, module.exports, load);
  return module.exports;
}

test('Rspack Ultrafast keeps model/provider boundaries and uses the same access for its setter', () => {
  let enabled = true;
  const options = { model: 'gpt-6-astra', hostId: 'local', threadProvider: 'custom', configProvider: 'custom', models: [
    { model: 'gpt-6-astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'gpt-6.1-sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6 Astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6.1 Sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'unsupported', serviceTiers: [{ id: 'standard' }, { id: 'ultrafast' }] },
  ] };
  const rewritten = rewriteRspackUltrafast(hookSource, context({ provider: providerSource }));
  const settings = execute(rewritten, {
    react: { use() {}, useSyncExternalStore: (_, read) => read() },
    signal: { read(atom) {
      if (atom === 'target') return { hostId: options.hostId, cwd: '/disposable' };
      if (atom === 'config') return { data: { model_provider: options.configProvider } };
      if (atom === 'provider') return options.threadProvider;
    } },
    scope: { target: () => ({ hostId: options.hostId }) },
    access: { read: () => ({ serviceTierAccess: { ultrafast: false, standard: true } }) },
    model: { select: (models, selected) => models.find(model => model.model === selected) },
    extra: { atom: 'extra' },
    'target-module': { atom: 'target' }, 'config-module': { atom: 'config' }, 'provider-module': { atom: 'provider' },
  }, { __codexPanelProviderUltrafastV1__: { subscribe() {}, getSnapshot: () => enabled } }).settings;
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'GPT-6 Astra', 'GPT-6.1 Sol']) {
    options.model = model;
    assert.equal(settings('thread', options).serviceTierAccess.ultrafast, true);
    assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
    assert.equal(settings('thread', options).serviceTierSettings.availableOptions.some(t => t.value === 'ultrafast'), true);
  }
  options.model = 'unsupported';
  assert.equal(settings('thread', options).serviceTierAccess.ultrafast, false);
  options.model = 'gpt-6-astra';
  options.threadProvider = 'openai';
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
  options.threadProvider = undefined;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
  options.configProvider = undefined;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
  options.threadProvider = 'custom'; options.hostId = 'remote';
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
  options.hostId = 'local'; enabled = false;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
});

test('Rspack model menu gets the adapted access and shows selected Ultrafast icon', () => {
  const source = `function(module,exports,load){load.d(exports,{menu:()=>menu});var settings=load("settings"),access=load("access"),native=load("native");function menu(){let{serviceTierSettings:tier,setServiceTier:set}=(0,settings.read)("thread",null);let target="host";let{serviceTierAccess:allowed}=(0,access.read)(target),other=null;let visible=tier.availableOptions.length>1;let chosen=tier.selectedServiceTier;let icon=true&&(0,native.icon)(null,chosen);const command="composer.openModelPicker";return {allowed,icon,visible}}}`;
  const rewritten = rewriteRspackUltrafast(source, context({}));
  const menu = execute(rewritten, {
    settings: { read: () => ({ serviceTierSettings: { availableOptions: [{ value: 'standard' }, { value: 'ultrafast' }], selectedServiceTier: 'ultrafast' }, serviceTierAccess: { ultrafast: true }, setServiceTier() {} }) },
    access: { read: () => ({ serviceTierAccess: { ultrafast: false } }) },
    native: { icon: () => false },
  }).menu;
  assert.equal(menu().allowed.ultrafast, true);
  assert.equal(menu().icon, true);
});

test('Rspack Dot changes only existing orbit capabilities and tracks the preference', () => {
  const native = `function(module,exports,load){var state=load("state");load.d(exports,{signal:()=>state.value});}`;
  const implementation = `function(module,exports,load){load.d(exports,{}, {value:function(scope,read,options){let atom=(0,other.build)("signal",scope,read);return atom}})}`;
  const source = `function(module,exports,load){load.d(exports,{capability:()=>capability});var reactive=load("reactive"),scope=load("scope");const a="Duplicate capability name:",b="Explicit-host capability requires hostId:";let definitions={orbit:{},"orbit.navigation":{},"other":{}},capability=(0,reactive.family)(scope.value,(request,{get:read})=>{var unused;let config=definitions[request.name];if(config==null)return{isLoading:false,isError:false,isCapable:false};return {isLoading:false,isError:false,isCapable:false}})}`;
  const rewritten = rewriteRspackDot(source, context({ reactive: native, state: implementation }));
  let enabled = true;
  const capability = execute(rewritten, {
    reactive: { family: (_, read) => request => read(request, { get(atom, ...keys) { assert.equal(keys.length, 0, 'scalar signals use a single argument'); return atom.read(); } }), signal: (_, read) => ({ read }) },
    scope: { value: 'scope' },
  }, { __codexPanelDotEntryV1__: { getSnapshot: () => enabled, subscribe() {} } }).capability;
  for (const name of ['orbit', 'orbit.navigation']) assert.equal(capability({ name }).isCapable, true);
  for (const name of ['other', 'missing']) assert.equal(capability({ name }).isCapable, false);
  enabled = false;
  assert.equal(capability({ name: 'orbit' }).isCapable, false);
});

test('serialized rewriters have no dependency on the module closure and reject incomplete matches', () => {
  for (const rewrite of [rewriteRspackUltrafast, rewriteRspackDot]) {
    const copied = vm.runInNewContext('(' + rewrite.toString() + ')');
    assert.equal(copied('function(a,b,c){}', context({})), null);
  }
  assert.throws(() => rewriteRspackUltrafast(hookSource, context({})), /Unsupported/);
  assert.throws(() => rewriteRspackDot('function(a,b,c){"Duplicate capability name:";"Explicit-host capability requires hostId:"}', context({})), /Unsupported/);
});
