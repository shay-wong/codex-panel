import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { rewriteRspackDot, rewriteRspackUltrafast } from '../scripts/codex-rspack-capabilities.mjs';
import { rspackSourceContext } from '../scripts/codex-rspack-source.mjs';

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
// 原生编译后的菜单会多次缓存选中档位，并且没有独立速度图标。
const modernMenuSource = `function(module,exports,load){var memo=load("memo"),native=load("access"),settings=load("settings"),view=load("view"),policy=load("policy");function rowList(){let one,two,output,cache=memo.c(15),{serviceTierAccess:access}=native.read(),{serviceTierSettings:tiers,setServiceTier:save}=settings.read();if(cache[2]!==access||cache[3]!==tiers.availableOptions||cache[4]!==tiers.isLoading||cache[5]!==tiers.selectedServiceTier||cache[6]!==save){let render;cache[8]!==access||cache[9]!==tiers.isLoading||cache[10]!==tiers.selectedServiceTier||cache[11]!==save?(render=option=>option.value==null?null:view.jsx("row",{enabled:policy.allowed(option.value,access)&&!tiers.isLoading,isSelected:option.value===tiers.selectedServiceTier,option,serviceTier:option.value,setServiceTier:save},option.value),cache[8]=access,cache[9]=tiers.isLoading,cache[10]=tiers.selectedServiceTier,cache[11]=save,cache[12]=render):render=cache[12],two=tiers.availableOptions.map(render),cache[2]=access,cache[3]=tiers.availableOptions,cache[4]=tiers.isLoading,cache[5]=tiers.selectedServiceTier,cache[6]=save,cache[7]=two}else two=cache[7];return output=view.jsx("fragment",{children:two}),output}load.d(exports,{menu:()=>rowList})}`;
const projectedHookSource = hookSource
  .replace('let result=function(e,selection,load){', 'function readSettings(e,selection,load){')
  .replace('}(thread,options,options.serviceTier);', '}let{serviceTierAccess:chosen,serviceTierSettings:tier,hasManagedNewThreadSettings:managed}=readSettings(thread,options,options.serviceTier);')
  .replace('let{serviceTierAccess:chosen,...rest}=result;', '')
  .replace('return {...rest,setServiceTier:set};', 'return {serviceTierSettings:tier,setServiceTier:set};');
const reorderedHookSource = projectedHookSource
    .replace('load.d(exports,{settings:()=>settings});', '')
    .replace('let{serviceTierAccess:chosen,serviceTierSettings:tier,hasManagedNewThreadSettings:managed}', 'const{hasManagedNewThreadSettings:managed,serviceTierSettings:tier,serviceTierAccess:chosen}')
    .replace('return {serviceTierSettings:tier,setServiceTier:set};', 'return {setServiceTier:set,serviceTierSettings:tier};')
    .replace('let host=context.hostId;', 'const host=context.hostId;const unrelated=0;')
    .replace('let selected=(0,model.select)(options?.models,selection.model),other=null;', 'const selected=(0,model.select)(options?.models,selection.model);let other=null;')
    .replace(/}\s*}$/, '}load.d(exports,{settings:()=>settings});}');


function context(sources) {
  const values = { 'target-module': 'function(){}', 'config-module': 'function(){}', 'provider-module': 'function(){}', ...sources };
  return rspackSourceContext(new Map(Object.entries(values).map(([id, source]) => [id, { id, source }])));
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

for (const [shape, source] of [['spread', hookSource], ['projected', projectedHookSource], ['reordered', reorderedHookSource]]) {
test(`Rspack Ultrafast ${shape} results keep model/provider boundaries and the same setter access`, () => {
  let enabled = true;
  const options = { model: 'gpt-6-astra', hostId: 'local', threadProvider: 'custom', configProvider: 'custom', models: [
    { model: 'gpt-6-astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'gpt-6.1-sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6 Astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6.1 Sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'gpt-6.2-astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'gpt-6.2-sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6.2 Astra', serviceTiers: [{ id: 'standard' }] },
    { model: 'GPT-6.2 Sol', serviceTiers: [{ id: 'standard' }] },
    { model: 'unsupported', serviceTiers: [{ id: 'standard' }, { id: 'ultrafast' }] },
  ] };
  const provider = shape === 'reordered' ? providerSource.replace('let{cwd:cwd,hostId:host}', 'const{hostId:host,cwd:cwd}').replace('{cwd:cwd,hostId:host}', '{hostId:host,cwd:cwd}') : providerSource;
  const rewritten = rewriteRspackUltrafast(source, context({ provider }));
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
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'GPT-6 Astra', 'GPT-6.1 Sol', 'gpt-6.2-astra', 'gpt-6.2-sol', 'GPT-6.2 Astra', 'GPT-6.2 Sol']) {
    options.model = model;
    assert.equal(settings('thread', options).serviceTierAccess.fast, true);
    assert.equal(settings('thread', options).serviceTierSettings.availableOptions.some(t => t.value === 'priority'), true);
    assert.equal(settings('thread', options).serviceTierAccess.ultrafast, true);
    assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
    assert.equal(settings('thread', options).serviceTierSettings.availableOptions.some(t => t.value === 'ultrafast'), true);
    assert.equal(settings('thread', options).serviceTierSettings.serviceTierForRequest, 'ultrafast');
  }
  options.model = 'unsupported';
  assert.equal(settings('thread', options).serviceTierAccess.ultrafast, false);
  options.model = 'gpt-6-astra';
  options.threadProvider = 'openai';
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
  options.threadProvider = undefined;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
  options.configProvider = undefined;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), true);
  assert.equal(settings('thread', options).serviceTierSettings.serviceTierForRequest, 'ultrafast');
  for (const invalid of ['', ' ', '\t', false, 7, {}, []]) {
    options.threadProvider = invalid;
    assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
  }
  options.threadProvider = 'custom'; options.hostId = 'remote';
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
  options.hostId = 'local'; enabled = false;
  assert.equal(settings('thread', options).setServiceTier('ultrafast'), false);
});
}

test('Rspack model menu gets adapted access in standalone and comma declarations', () => {
  const source = `function(module,exports,load){load.d(exports,{menu:()=>menu});var settings=load("settings"),access=load("access"),native=load("native");function menu(){let{serviceTierSettings:tier,setServiceTier:set}=(0,settings.read)("thread",null);let target="host";let{serviceTierAccess:allowed}=(0,access.read)(target),other=null;let visible=tier.availableOptions.length>1;let chosen=tier.selectedServiceTier;let icon=true&&(0,native.icon)(null,chosen);const command="composer.openModelPicker";return {allowed,icon,visible}}}`;
  for (const declaration of [source, source.replace('let{serviceTierSettings:', 'let previous=null,{serviceTierSettings:')]) {
    const rewritten = rewriteRspackUltrafast(declaration, context({}));
    const menu = execute(rewritten, {
      settings: { read: () => ({ serviceTierSettings: { availableOptions: [{ value: 'standard' }, { value: 'ultrafast' }], selectedServiceTier: 'ultrafast' }, serviceTierAccess: { ultrafast: true }, setServiceTier() {} }) },
      access: { read: () => ({ serviceTierAccess: { ultrafast: false } }) },
      native: { icon: () => false },
    }).menu;
    assert.equal(menu().allowed.ultrafast, true);
    assert.equal(menu().icon, true);
  }
});

test('compiled native menu selects OpenAI Ultrafast and produces the request service tier', () => {
  let enabled = true;
  const options = {model: 'gpt-6.1-sol', hostId: 'local', threadProvider: undefined, configProvider: undefined, serviceTier: null,
    models: [{model: 'gpt-6.1-sol', serviceTiers: [{id: 'standard'}]}, {model: 'unsupported', serviceTiers: [{id: 'standard'}]}]};
  const source = hookSource.replace('serviceTierForRequest:available.some(t=>t.value==="ultrafast")?"ultrafast":null', 'serviceTierForRequest:selection.serviceTier!=="ultrafast"||allowed.ultrafast?selection.serviceTier:null')
    .replace('setServiceTier:t=>t!=="ultrafast"||allowed.ultrafast', 'setServiceTier:t=>{if(t==="ultrafast"&&!allowed.ultrafast)return false;selection.serviceTier=t;return true}')
    .replace('let set=value=>value!=="ultrafast"||chosen.ultrafast;', 'let set=value=>(value!=="ultrafast"||chosen.ultrafast)&&rest.setServiceTier(value);');
  const dependencies = {
    react: {use() {}, useSyncExternalStore: (_, read) => read()},
    signal: {read(atom) {return atom === 'target' ? {hostId: options.hostId, cwd: '/disposable'} : atom === 'provider' ? options.threadProvider : atom === 'config' ? {data: {model_provider: options.configProvider}} : null;}},
    scope: {target: () => ({hostId: options.hostId})}, access: {read: () => ({serviceTierAccess: {ultrafast: false, standard: true}})},
    model: {select: (models, selected) => models.find(model => model.model === selected)}, extra: {atom: 'extra'},
    'target-module': {atom: 'target'}, 'config-module': {atom: 'config'}, 'provider-module': {atom: 'provider'},
  };
  const settings = execute(rewriteRspackUltrafast(source, context({provider: providerSource})), dependencies,
    {__codexPanelProviderUltrafastV1__: {subscribe() {}, getSnapshot: () => enabled}}).settings;
  const menu = execute(rewriteRspackUltrafast(modernMenuSource, context({})), {
    memo: {c: () => []}, access: dependencies.access, settings: {read: () => settings('thread', options)},
    view: {jsx: (type, props) => ({type, props})}, policy: {allowed: (tier, access) => tier !== 'ultrafast' || access?.ultrafast === true},
  }).menu;
  for (const provider of ['openai', undefined, 'custom']) {
    options.threadProvider = provider;
    const row = menu().props.children.find(row => row?.props.serviceTier === 'ultrafast');
    assert.equal(row.props.enabled, true);
    assert.equal(row.props.setServiceTier('ultrafast'), true);
    const request = JSON.parse(JSON.stringify({serviceTier: settings('thread', options).serviceTierSettings.serviceTierForRequest}));
    assert.equal(request.serviceTier, 'ultrafast');
  }
  for (const provider of ['', ' ', 1]) {options.threadProvider = provider;assert.equal(menu().props.children.some(row => row?.props.serviceTier === 'ultrafast'), false);}
  options.threadProvider = 'openai';options.hostId = 'remote';
  assert.equal(menu().props.children.some(row => row?.props.serviceTier === 'ultrafast'), false);
  options.hostId = 'local';enabled = false;
  assert.equal(menu().props.children.some(row => row?.props.serviceTier === 'ultrafast'), false);
  assert.equal(settings('thread', options).serviceTierSettings.serviceTierForRequest, null);
  enabled = true;options.model = 'unsupported';
  assert.equal(menu().props.children.some(row => row?.props.serviceTier === 'ultrafast'), false);
  assert.equal(settings('thread', options).serviceTierSettings.serviceTierForRequest, null);
});

test('Rspack Dot changes only existing orbit capabilities and tracks the preference', () => {
  const native = `function(module,exports,load){var state=load("state");load.d(exports,{signal:()=>state.value});}`;
  const implementation = `function(module,exports,load){load.d(exports,{}, {value:function(scope,read,options){let atom=(0,other.build)("signal",scope,read);return atom}})}`;
  const source = `function(module,exports,load){load.d(exports,{capability:()=>capability});var reactive=load("reactive"),scope=load("scope");const a="Duplicate capability name:",b="Explicit-host capability requires hostId:";let definitions={orbit:{},"orbit.navigation":{},"other":{}},capability=(0,reactive.family)(scope.value,(request,{get:read})=>{var unused;let config=definitions[request.name];if(config==null)return{isLoading:false,isError:false,isCapable:false};return {isLoading:false,isError:false,isCapable:false}})}`;
  const rewritten = rewriteRspackDot(source, context({ reactive: native, state: implementation }));
  let enabled = true;
  const capability = execute(rewritten, {
    state: { value: (_, read) => ({ read }) },
    reactive: { family: (_, read) => request => read(request, { get(atom, ...keys) { assert.equal(keys.length, 0, 'scalar signals use a single argument'); return atom.read(); } }), signal: (_, read) => ({ read }) },
    scope: { value: 'scope' },
  }, { __codexPanelDotEntryV1__: { getSnapshot: () => enabled, subscribe() {} } }).capability;
  for (const name of ['orbit', 'orbit.navigation']) assert.equal(capability({ name }).isCapable, true);
  for (const name of ['other', 'missing']) assert.equal(capability({ name }).isCapable, false);
  enabled = false;
  assert.equal(capability({ name: 'orbit' }).isCapable, false);
});

test('structural rewriters reject unsupported native candidates', () => {
  for (const rewrite of [rewriteRspackUltrafast, rewriteRspackDot]) assert.equal(rewrite('function(a,b,c){}', context({})), null);
  assert.throws(() => rewriteRspackUltrafast(hookSource, context({})), /provider reader is unavailable/);
});

test('Dot follows capability and signal data without diagnostic strings or declaration adjacency', () => {
  const sources = {
    reactive: 'function(module,exports,load){var forwarded=load("bridge");load.d(exports,{signal:()=>forwarded.forward});}',
    bridge: 'function(module,exports,load){var state=load("state");load.d(exports,{forward:()=>state.value});}',
    state: 'function(module,exports,load){function create(scope,read,options){const unrelated=0;const result=(0,other.build)("signal",scope,read);return result}load.d(exports,{value:()=>create});}',
    unrelated: 'function(module,exports,load){load.d(exports,{create:()=>create});function create(scope,read){return other.build("signal",scope,read)}}',
  };
  const source = 'function(module,exports,load){var reactive=load("reactive"),scope=load("scope");const definitions={orbit:{},"orbit.navigation":{},other:{}};const capability=(0,reactive.family)(scope.value,(request,{get:read})=>{const unrelated=0;const config=definitions[request.name];if(config==null)return{isCapable:false,isError:false,isLoading:false};return{isCapable:false,isError:false,isLoading:false}});load.d(exports,{capability:()=>capability})}';
  const rewritten = rewriteRspackDot(source, context(sources));
  const capability = execute(rewritten, {
    state: { value: (_, read) => ({ read }) },
    reactive: { signal: (_, read) => ({ read }), family: (_, read) => request => read(request, { get: atom => atom.read() }) },
    scope: { value: 'scope' },
  }, { __codexPanelDotEntryV1__: { getSnapshot: () => true } }).capability;
  assert.equal(capability({ name: 'orbit' }).isCapable, true);
  assert.equal(capability({ name: 'missing' }).isCapable, false);
});
