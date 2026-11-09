import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { rewriteRspackQuota } from "../scripts/codex-rspack-quota.mjs";

const composer = `function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId,external=false,loading=false,empty=false,status="ready",error=null}){(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);const hostQuota=(0,hooks.read)(quota.host,host),workQuota=(0,hooks.atom)("local"===host&&quota.work);let policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let disabled=external||loading||empty||policyBlock||hostQuota||workQuota;return {"data-codex-composer-root":"",submitDisabled:disabled,onSubmit:()=>!disabled};}}`;
const composerWithReasons = `function(e,t,n){var React=n("react"),hooks=n("hooks"),thread=n("thread"),quota=n("quota"),memo=n("memo");n.d(t,{CodexComposerAdapter:()=>Composer});function Composer({threadId,external=false,loading=false,status="ready",error=null}){let reasons,cache=(0,memo.c)(6);(0,React.useState)(null);const host=(0,hooks.read)(thread.host,threadId);const hostQuota=(0,hooks.read)(quota.host,host),workQuota=(0,hooks.atom)("local"===host&&quota.work);let policyBlock="failed"===status&&error?.codexErrorInfo==="misalignmentPolicyViolation";let externalReason=external&&"caller-disabled",policyReason=policyBlock&&"policy-violation",loadingReason=loading&&"service-tier-loading",hostReason=hostQuota&&"reserve-limit",workReason=workQuota&&"usage-limit";if(cache[0]!==externalReason||cache[1]!==policyReason||cache[2]!==loadingReason||cache[3]!==hostReason||cache[4]!==workReason){reasons=[externalReason,policyReason,loadingReason,hostReason,workReason].filter(Boolean);cache[0]=externalReason;cache[1]=policyReason;cache[2]=loadingReason;cache[3]=hostReason;cache[4]=workReason;cache[5]=reasons}else reasons=cache[5];let disabledReasons=reasons.join(",");return {"data-codex-composer-root":"",submitDisabledReasons:disabledReasons,onSubmit:()=>disabledReasons.length===0};}}`;
const reader = `function(e,t,r){var target=r("targets"),config=r("config"),provider=r("providers");const kind="model_picker_upsell";function read(e,o,t="fresh"){let{cwd:l,hostId:i}=e.get(target.scope,o);if("local"!==i)return null;let{data:c}=e.get(config.options,{cwd:l,hostId:i});return null==c||(e.get(provider.name,o)??c.model_provider??"openai")!=="openai"?null:kind;}}`;
const modules = new Map([["composer", composer], ["reader", reader], ["targets", "function(){}"], ["config", "function(){}"], ["providers", "function(){}"]]);
const context = {
  moduleId: "composer",
  findModule(needles) {
    const values = [...modules].filter(([, source]) => (Array.isArray(needles) ? needles : [needles]).every(needle => source.includes(needle)));
    return values.length === 1 ? { id: values[0][0], source: values[0][1] } : null;
  },
  moduleSource: id => modules.get(id) ?? null,
};

function load({ source = composer, enabled = true, host = "local", provider = "custom", configProvider = "openai", hostQuota = true, workQuota = true } = {}) {
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
        throw new Error(`Unknown atom ${atom}`);
      },
      atom: value => value && state.workQuota,
    },
    thread: { host: "thread-host" }, quota: { host: "host-quota", work: "work-quota" },
    targets: { scope: "scope" }, config: { options: "config" }, providers: { name: "provider" },
  };
  const exports = {};
  const require = id => dependency[id];
  require.d = (target, values) => {
    for (const [name, get] of Object.entries(values)) Object.defineProperty(target, name, { get });
  };
  const patched = rewriteRspackQuota(source, context);
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

test("Rspack rewrite ignores unrelated factories and fails clearly on unsupported candidates", () => {
  assert.equal(rewriteRspackQuota("function(e,t,n){return 1}", context), null);
  assert.throws(() => rewriteRspackQuota(composer.replace("||hostQuota||workQuota", "||hostQuota"), context), /quota/);
  assert.throws(() => rewriteRspackQuota(composer, { ...context, findModule: () => null }), /provider reader is unavailable/);
  assert.throws(() => rewriteRspackQuota(composer, { ...context, moduleSource: () => null }), /provider dependency is unavailable/);
  assert.equal(rewriteRspackQuota(rewriteRspackQuota(composer, context), context), null);
});
