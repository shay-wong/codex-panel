import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { rewriteRspackQuota } from "../scripts/codex-rspack-quota.mjs";
import { rspackSourceContext } from "../scripts/codex-rspack-source.mjs";

const composer = `function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId,external=false,loading=false,empty=false,status="ready",error=null}){(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);const hostQuota=(0,hooks.read)(quota.host,host),workQuota=(0,hooks.atom)("local"===host&&quota.work);let policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let disabled=external||loading||empty||policyBlock||hostQuota||workQuota;return {"data-codex-composer-root":"",submitDisabled:disabled,onSubmit:()=>!disabled};}}`;
const composerWithReasons = `function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota"),memo=n("memo");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId,external=false,loading=false,status="ready",error=null}){let reasons,cache=(0,memo.c)(6);(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);const hostQuota=(0,hooks.read)(quota.host,host),workQuota=(0,hooks.atom)("local"===host&&quota.work);let policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let externalReason=external&&"caller-disabled",policyReason=policyBlock&&"policy-violation",loadingReason=loading&&"service-tier-loading",hostReason=hostQuota&&"reserve-limit",workReason=workQuota&&"usage-limit";if(cache[0]!==externalReason||cache[1]!==policyReason||cache[2]!==loadingReason||cache[3]!==hostReason||cache[4]!==workReason){reasons=[externalReason,policyReason,loadingReason,hostReason,workReason].filter(Boolean);cache[0]=externalReason;cache[1]=policyReason;cache[2]=loadingReason;cache[3]=hostReason;cache[4]=workReason;cache[5]=reasons}else reasons=cache[5];let disabledReasons=reasons.join(",");return {"data-codex-composer-root":"",submitDisabledReasons:disabledReasons,onSubmit:()=>disabledReasons.length===0};}}`;
const composerWithQuotaSignal = `function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota-signal"),memo=n("memo");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId,external=false,loading=false,status="ready",error=null}){let reasons,cache=(0,memo.c)(5);(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);let quotaReason=(0,hooks.read)(quota.value,host);let policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let externalReason=external&&"caller-disabled",policyReason=policyBlock&&"policy-violation",loadingReason=loading&&"service-tier-loading";if(cache[0]!==externalReason||cache[1]!==policyReason||cache[2]!==loadingReason||cache[3]!==quotaReason){reasons=[externalReason,policyReason,loadingReason,quotaReason].filter(Boolean);cache[0]=externalReason;cache[1]=policyReason;cache[2]=loadingReason;cache[3]=quotaReason;cache[4]=reasons}else reasons=cache[4];let disabledReasons=reasons.join(",");return {"data-codex-composer-root":"",submitDisabledReasons:disabledReasons,onSubmit:()=>disabledReasons.length===0};}}`;
const quotaSignal = `function(e,t,n){var hooks=n("hooks"),scope=n("scope"),quota=n("quota");let usage=quota.usage,reason=(0,hooks.family)(scope.root,(host,{get:read})=>[read(quota.reserve,host)&&"reserve-limit","local"===host&&read(usage)&&"usage-limit"].filter(Boolean).join(","));n.d(t,{},{value:reason});}`;
const reader = `function(e,t,r){var target=r("targets"),config=r("config"),provider=r("providers");const kind="model_picker_upsell";function read(e,o,t="fresh"){let{cwd:l,hostId:i}=e.get(target.scope,o);if("local"!==i)return null;let{data:c}=e.get(config.options,{cwd:l,hostId:i});return null==c||(e.get(provider.name,o)??c.model_provider??"openai")!=="openai"?null:kind;}}`;
const modules = new Map([["composer", composer], ["reader", reader], ["targets", "function(){}"], ["config", "function(){}"], ["providers", "function(){}"], ["quota-signal", quotaSignal]]);
const context = rspackSourceContext(new Map([...modules].map(([id, source]) => [id, { id, source }])));

function load({ source = composer, enabled = true, host = "local", provider = "custom", configProvider = "openai", hostQuota = true, workQuota = true, sourceContext = context } = {}) {
  const state = { enabled, host, provider, configProvider, hostQuota, workQuota };
  const runtime = { subscribe: () => () => {}, getSnapshot: () => state.enabled };
  const memoCache = [];
  const dependency = {
    react: { useState: () => [null], useSyncExternalStore: (_subscribe, get) => get() },
    memo: { c: () => memoCache },
    hooks: {
      read(atom) {
        if (atom === "thread-host") return state.host;
        if (atom === "host-quota") return state.hostQuota;
        if (atom === "scope") return { cwd: "/isolated", hostId: state.host };
        if (atom === "provider") return state.provider;
        if (atom === "config") return { data: { model_provider: state.configProvider } };
        if (atom === "quota-reason") return [state.hostQuota && "reserve-limit", state.host === "local" && state.workQuota && "usage-limit"].filter(Boolean).join(",");
        throw new Error(`Unknown atom ${atom}`);
      },
      atom: value => value && state.workQuota,
    },
    thread: { host: "thread-host" }, quota: { host: "host-quota", work: "work-quota" },
    targets: { scope: "scope" }, config: { options: "config" }, providers: { name: "provider" },
    "quota-signal": { value: "quota-reason" },
  };
  const exports = {};
  const require = id => dependency[id];
  require.d = (target, values) => {
    for (const [name, get] of Object.entries(values)) Object.defineProperty(target, name, { get });
  };
  const patched = rewriteRspackQuota(source, sourceContext);
  const factory = vm.runInNewContext(`(${patched})`, { __codexPanelProviderQuotaV1__: runtime });
  factory({}, exports, require);
  return { state, render: options => exports.CodexComposerAdapter({ threadId: "isolated-thread", ...options }) };
}

test("Rspack composer bypasses only quota terms for an explicitly enabled local custom provider", () => {
  const { state, render } = load();
  assert.equal(render().submitDisabled, false);
  assert.equal(render().onSubmit(), true);
  state.enabled = false;
  assert.equal(render().submitDisabled, true);
  assert.equal(render().onSubmit(), false);
  state.enabled = true;
  state.provider = "openai";
  assert.equal(render().submitDisabled, true);
  state.provider = "custom";
  state.host = "remote-host";
  assert.equal(render().submitDisabled, true);
});

test("Rspack composer preserves all non-quota blockers and resolves the effective provider", () => {
  const { state, render } = load();
  for (const options of [{ external: true }, { loading: true }, { empty: true }, { status: "failed", error: { codexErrorInfo: "misalignmentPolicyViolation" } }]) {
    assert.equal(render(options).submitDisabled, true);
    assert.equal(render(options).onSubmit(), false);
  }
  state.provider = undefined;
  state.configProvider = "custom";
  assert.equal(render().submitDisabled, false);
  for (const value of [undefined, null, "", "openai"]) {
    state.configProvider = value;
    assert.equal(render().submitDisabled, true);
  }
  state.provider = "openai";
  state.configProvider = "custom";
  assert.equal(render().submitDisabled, true, "thread provider overrides the global config");
  state.enabled = false;
  state.hostQuota = false;
  state.workQuota = false;
  assert.equal(render().submitDisabled, false, "normal unblocked sends retain native behavior");
});

test("Rspack cached submit reasons react to quota toggle and effective provider changes", () => {
  const { state, render } = load({ source: composerWithReasons });
  const expectBlocked = (blocked, reasons = "reserve-limit,usage-limit") => {
    const result = render();
    assert.equal(result.submitDisabledReasons, blocked ? reasons : "");
    assert.equal(result.onSubmit(), !blocked);
  };
  expectBlocked(false);
  state.enabled = false;
  expectBlocked(true);
  state.enabled = true;
  expectBlocked(false);
  state.provider = "openai";
  expectBlocked(true);
  state.provider = "custom";
  state.host = "remote-host";
  expectBlocked(true, "reserve-limit");
  state.host = "local";
  state.provider = undefined;
  state.configProvider = "custom";
  expectBlocked(false);
  state.provider = "openai";
  expectBlocked(true);
});

test("Rspack submit reasons preserve non-quota causes through cached renders", () => {
  const { state, render } = load({ source: composerWithReasons });
  const options = { external: true, loading: true, status: "failed", error: { codexErrorInfo: "misalignmentPolicyViolation" } };
  const retained = ["caller-disabled", "policy-violation", "service-tier-loading"];
  assert.deepEqual(render(options).submitDisabledReasons.split(","), retained);
  assert.equal(render(options).onSubmit(), false);
  state.enabled = false;
  assert.deepEqual(render(options).submitDisabledReasons.split(","), [...retained, "reserve-limit", "usage-limit"]);
  state.enabled = true;
  assert.deepEqual(render(options).submitDisabledReasons.split(","), retained);
  assert.equal(render().submitDisabledReasons, "");
});

test("Rspack submit reasons retain dollar-suffixed native identifiers", () => {
  for (const name of ["hostQuota", "policyBlock"]) {
    const source = composerWithReasons.replaceAll(name, `${name}$`);
    const { state, render } = load({ source });
    assert.equal(render().submitDisabledReasons, "");
    assert.equal(render({ status: "failed", error: { codexErrorInfo: "misalignmentPolicyViolation" } }).submitDisabledReasons, "policy-violation");
    state.enabled = false;
    assert.equal(render().submitDisabledReasons, "reserve-limit,usage-limit");
  }
});

test("Rspack host quota signals keep policy blockers and track local custom-provider changes", () => {
  const { state, render } = load({ source: composerWithQuotaSignal });
  assert.equal(render().onSubmit(), true);
  assert.equal(render({ external: true, loading: true, status: "failed", error: { codexErrorInfo: "misalignmentPolicyViolation" } }).submitDisabledReasons, "caller-disabled,policy-violation,service-tier-loading");
  state.enabled = false;
  assert.equal(render().submitDisabledReasons, "reserve-limit,usage-limit");
  state.enabled = true;
  state.provider = "openai";
  assert.equal(render().submitDisabledReasons, "reserve-limit,usage-limit");
  state.provider = "custom";
  state.host = "remote";
  assert.equal(render().submitDisabledReasons, "reserve-limit");
  state.host = "local";
  state.provider = undefined;
  state.configProvider = "custom";
  assert.equal(render().submitDisabledReasons, "");
  state.configProvider = undefined;
  assert.equal(render().onSubmit(), false);
  assert.throws(() => rewriteRspackQuota(composerWithQuotaSignal, {
    ...context,
    resolve: (ast, node) => {
      const value = context.resolve(ast, node);
      return value?.ast.source === quotaSignal ? null : value;
    },
  }), /quota gate is unsupported/);
});

test("Rspack rewrite ignores unrelated factories and fails clearly on unsupported candidates", () => {
  assert.equal(rewriteRspackQuota("function(e,t,n){return 1}", context), null);
  assert.throws(() => rewriteRspackQuota(composer.replace("||hostQuota||workQuota", "||hostQuota"), context), /quota/);
  assert.throws(() => rewriteRspackQuota(composer, { ...context, modulesContaining: () => [] }), /provider reader is unavailable/);
  assert.throws(() => rewriteRspackQuota(composer, { ...context, moduleSource: () => null }), /provider dependency is unavailable/);
  assert.equal(rewriteRspackQuota(rewriteRspackQuota(composer, context), context), null);
});

test('quota discovery follows bindings across reordered declarations, fields, and exports', () => {
  const source = composerWithQuotaSignal
    .replace('n.d(t,{CodexComposerAdapter:()=>Composer});', '')
    .replace('let quotaReason=', 'const quotaReason=')
    .replace('externalReason=external&&"caller-disabled",policyReason=policyBlock&&"policy-violation",loadingReason=loading&&"service-tier-loading"', 'loadingReason=loading&&"service-tier-loading",externalReason=external&&"caller-disabled",policyReason=policyBlock&&"policy-violation"')
    .replace('submitDisabledReasons:disabledReasons,onSubmit:', 'onSubmit:')
    .replace('()=>disabledReasons.length===0};}}', '()=>disabledReasons.length===0,submitDisabledReasons:disabledReasons};}n.d(t,{CodexComposerAdapter:()=>Composer});}');
  const shuffledReader = reader.replace('let{cwd:l,hostId:i}', 'const{hostId:i,cwd:l}')
    .replace('{cwd:l,hostId:i}', '{hostId:i,cwd:l}')
    .replace('const kind="model_picker_upsell";', 'const kind="unrelated-label";');
  const shuffledSignal = quotaSignal.replace('[read(quota.reserve,host)&&"reserve-limit","local"===host&&read(usage)&&"usage-limit"]', '["local"===host&&read(usage)&&"usage-limit",read(quota.reserve,host)&&"reserve-limit"]')
    .replace('n.d(t,{},{value:reason});', 'n.d(t,{},{other:1,value:reason});');
  const shuffled = new Map(modules);
  shuffled.set('reader', shuffledReader);
  shuffled.set('quota-signal', shuffledSignal);
  const scoped = rspackSourceContext(new Map([...shuffled].map(([id, source]) => [id, { id, source }])));
  const rewritten = rewriteRspackQuota(source, scoped);
  assert.ok(rewritten.includes('panelCustomQuota'));
  const { state, render } = load({ source, sourceContext: scoped });
  assert.equal(render().onSubmit(), true);
  state.enabled = false;
  assert.equal(render().submitDisabledReasons, 'reserve-limit,usage-limit');
});

test('direct quota reasons do not require quota declarations to be adjacent or ordered', () => {
  const source = composerWithReasons.replace('hostReason=hostQuota&&"reserve-limit",workReason=workQuota&&"usage-limit"', 'workReason=workQuota&&"usage-limit";const unrelated=0;const hostReason=hostQuota&&"reserve-limit"');
  const { state, render } = load({ source });
  assert.equal(render().onSubmit(), true);
  state.enabled = false;
  assert.equal(render().submitDisabledReasons, 'reserve-limit,usage-limit');
});
