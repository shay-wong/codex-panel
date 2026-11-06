import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { customProviderUltrafastAccess, withUltrafastTier, rewriteCodexProviderUltrafast, prepareCodexProviderUltrafast } from "../scripts/codex-provider-ultrafast.mjs";
import { createCodexProviderQuotaRuntime } from "../scripts/codex-provider-quota.mjs";

// Native hook/menu structure, with business dependencies supplied by the fixture.
const initial = `
function providerReader(){let i=r(config,{hostId:t,cwd:n}).data;return i==null||(r(provider,e)??i.model_provider??\`openai\`)!==\`openai\`}
function settings(e,t,n,r,i){let a=cache(),l=context(e),u=((0,react.use)(hostContext),l.hostId),v=query(threadTier,e);let{serviceTierAccess:D}=account(u),O;
 const queryValue=query;
 let tModel;
 if(a[0]!==D||a[1]!==v){let t=findModel(catalog?.models,state.model),A=normalize(t,v,D),k=selected(t,A),M=options(t).filter(e=>allowed(e.value,D));O={hasManagedNewThreadSettings:false,hostId:u,serviceTierAccess:D,serviceTierSettings:{availableOptions:M,selectedServiceTier:k,serviceTierForRequest:A},setServiceTier:save};a[0]=D;a[1]=v;a[2]=O}else O=a[2];return O;
}
function wrapper(e){let l=settings(e),u,d;({serviceTierAccess:d,...u}=l);let p=async tier=>allowed(tier,d)&&u.setServiceTier(tier);return {...u,setServiceTier:p}}
`;
const primary = `function menu(e){let{serviceTierSettings:rt,setServiceTier:it}=wrapper(e),at;let{serviceTierAccess:ot}=account(at),s;let Kt=rt.selectedServiceTier,Qt=true&&supported(model,Kt),show=ot!=null&&rt.availableOptions.length>1,command=\`composer.openModelPicker\`;return {show,icon:Qt,access:ot,options:rt.availableOptions,select:it}}`;

function fixture(enabled = true, modelId = "gpt-6-astra") {
  let providerValue = "custom", threadProvider, hostId = "local", tier = null;
  const model = {model: modelId, serviceTiers: [{id: "priority", name: "Fast"}]};
  const access = {fast: true, ultrafast: false};
  const runtime = createCodexProviderQuotaRuntime(enabled), memo = [];
  const saves = [];
  const scope = {
    __codexPanelProviderUltrafastV1__: runtime,
    react: {use() {}, useSyncExternalStore: (_, get) => get()}, hostContext: {},
    provider: "provider", config: "config", threadTier: "tier",
    cache: () => memo, context: () => ({hostId, cwd: "/disposable"}),
    query: key => key === "provider" ? threadProvider : key === "config" ? {data: {model_provider: providerValue}} : tier,
    account: () => ({serviceTierAccess: access}),
    catalog: {models: [model]}, state: {model: modelId}, model,
    findModel: (models, name) => models.find(model => model.model === name),
    allowed: (value, access) => value == null || access?.[value === "ultrafast" ? "ultrafast" : "fast"] === true,
    normalize: (_, value, access) => value == null || scope.allowed(value, access) ? value : null,
    selected: (model, tier) => model.serviceTiers.find(item => item.id === tier)?.id ?? null,
    supported: (model, tier) => model.serviceTiers.some(item => item.id === tier),
    options: model => [{value: null}, ...model.serviceTiers.map(item => ({value: item.id}))],
    save: async value => {tier = value; saves.push(value); return true;},
  };
  const context = vm.createContext(scope);
  const patched = rewriteCodexProviderUltrafast(initial, "app://-/assets/app-initial-test.js");
  assert.ok(patched);
  vm.runInContext(patched + rewriteCodexProviderUltrafast(primary, "app://-/assets/app-primary-test.js"), context);
  return { runtime, saves, scope, menu: () => context.menu("thread"), settings: () => context.wrapper("thread"),
    provider: value => {providerValue=value;}, thread: value => {threadProvider=value;}, host: value => {hostId=value;} };
}

test("switch exposes Ultrafast, native setter saves it, and requests retain it; disabling restores native rules", async () => {
  const f = fixture(false);
  assert.equal(f.menu().options.some(e => e.value === "ultrafast"), false);
  f.runtime.setEnabled(true);
  assert.equal(f.menu().options.some(e => e.value === "ultrafast"), true);
  assert.equal(await f.menu().select("ultrafast"), true);
  assert.deepEqual(f.saves, ["ultrafast"]);
  assert.equal(f.settings().serviceTierSettings.serviceTierForRequest, "ultrafast");
  assert.equal(f.settings().serviceTierSettings.selectedServiceTier, "ultrafast");
  assert.equal(f.menu().icon, true);
  f.runtime.setEnabled(false);
  assert.equal(f.settings().serviceTierSettings.serviceTierForRequest, null);
  assert.equal(await f.menu().select("ultrafast"), false);
  f.runtime.setEnabled(true);
  f.thread("openai");
  assert.equal(await f.menu().select("ultrafast"), false, "thread provider overrides custom config");
  f.thread("custom"); f.host("remote");
  assert.equal(await f.menu().select("ultrafast"), false);
});

test("official and unknown providers keep original access and existing catalog tiers are retained", () => {
  const access = {fast: false, ultrafast: false};
  for (const provider of [undefined, null, "", "openai"]) assert.equal(customProviderUltrafastAccess("local", provider, access), access);
  const model = {serviceTiers: [{id: "ultrafast", name: "Ultrafast", description: "Provider description"}]};
  assert.equal(withUltrafastTier(model), model);
  assert.equal(withUltrafastTier(null), null);
  assert.deepEqual(customProviderUltrafastAccess("local", "custom", access, "gpt-6-astra"), {fast: false, ultrafast: true});
});

test("discovers both native modules from an existing import map and rejects unsupported structures", async () => {
  const sources = new Map([["app://-/assets/app-initial-test.js", initial], ["app://-/assets/app-primary-test.js", primary]]);
  const cdp = {async send(_, params) {
    return {result: {value: await vm.runInNewContext(params.expression, {
      URL, location: {href: "app://-/index.html"}, performance: {getEntriesByType: () => []},
      document: {querySelectorAll: selector => selector.includes("importmap") ? [{textContent: JSON.stringify({imports: Object.fromEntries([...sources.keys()].map(url => [url, "blob:fixture"]))})}] : []},
      fetch: async url => ({ok: true, text: async () => sources.get(url)}),
    })}};
  }};
  assert.equal((await prepareCodexProviderUltrafast(cdp, () => {})).length, 2);
  sources.set("app://-/assets/app-initial-test.js", "unsupported");
  assert.deepEqual(await prepareCodexProviderUltrafast(cdp, () => {}), []);
  assert.equal(rewriteCodexProviderUltrafast(initial+initial, "app://-/assets/app-initial-test.js"), null);
});


test("only official Ultrafast models get access, including after changing a selected model", async () => {
  for (const modelId of ["gpt-6-astra", "gpt-6.1-sol", "GPT-6 Astra", "GPT-6.1 Sol"]) {
    const f = fixture(true, modelId);
    assert.equal(await f.menu().select("ultrafast"), true);
    assert.equal(f.settings().serviceTierSettings.serviceTierForRequest, "ultrafast");
    assert.equal(f.menu().options.some(option => option.value === "ultrafast"), true);
    for (const unsupported of ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "custom-alias"]) {
      f.scope.model.model = unsupported;
      f.scope.state.model = unsupported;
      assert.equal(f.menu().options.some(option => option.value === "ultrafast"), false);
      assert.equal(f.settings().serviceTierSettings.serviceTierForRequest, null);
      assert.equal(await f.menu().select("ultrafast"), false);
    }
  }
  const f = fixture(true, "gpt-5.6-sol");
  f.scope.model.serviceTiers.push({id: "ultrafast", name: "Ultrafast"});
  f.scope.account = () => ({serviceTierAccess: {fast: true, ultrafast: true}});
  assert.equal(f.menu().options.some(option => option.value === "ultrafast"), false, "stale catalog does not expand the official list");
  assert.equal(await f.menu().select("ultrafast"), false);
  assert.equal(await f.menu().select("priority"), true, "Fast still works");
});
