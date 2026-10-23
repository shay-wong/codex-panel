import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { rewriteCodexDotEntry, prepareCodexDotEntry } from "../scripts/codex-dot-entry.mjs";
import { createCodexProviderQuotaRuntime, prepareCodexProviderQuotaFix } from "../scripts/codex-provider-quota.mjs";

// Native capability shape from 26.1016.62342; account/config readers are local fixtures.
const initial = `
function stored(e,t){let n=signal(scope,n=>read(e(n),t),{getServerSnapshot:()=>t,onMount(r,i){r(t)}});return n}
const definitions={orbit:{accessPolicy:\`orbit\`,requiresFirstPartyInference:!0},cloud:{requiresFirstPartyInference:!0}};
let capability;
capability=derived(scope,(request,{get:get})=>{let config=definitions[request.name];
if(config==null)return{isCapable:false};
let results=config.accessPolicy?[get(account)]:[];
if(config.requiresFirstPartyInference&&get(flag)){let provider=get(providerConfig);results.push({isCapable:provider===\`openai\`})}
return {isCapable:results.every(result=>result.isCapable)};
});
`;
const url = "app://-/assets/app-initial-fixture.js";

test("Dot toggle bypasses local account and provider gates and restores them when disabled", () => {
  const runtime = createCodexProviderQuotaRuntime(false);
  let allowed = true, provider = "custom", mounted, updated = 0;
  const context = {
    __codexPanelDotEntryV1__: runtime, scope: {}, account: "account", flag: "flag", providerConfig: "provider",
    signal(_, initial, options) {
      const atom = {value: initial()};
      mounted = options.onMount(value => {atom.value = value; updated++;});
      return atom;
    },
    derived(_, reader) { return name => reader({name}, {get: (...args) => {
      const [key] = args;
      if (key === "account") return {isCapable: allowed};
      if (key === "provider") return provider;
      if (key === "flag") return true;
      // 原生 signal family 必须带 key 调用；省略时会把布尔值当作 atom 读取并崩溃。
      assert.equal(args.length, 2, "read signal family with an explicit undefined key");
      assert.equal(args[1], undefined);
      return key.value;
    }}); },
  };
  const patched = rewriteCodexDotEntry(initial, url);
  assert.ok(patched);
  const capability = vm.runInNewContext(patched + ';capability', context);
  assert.equal(capability("orbit").isCapable, false);
  runtime.setEnabled(true);
  assert.equal(capability("orbit").isCapable, true);
  assert.equal(capability("cloud").isCapable, false);
  allowed = false;
  const enabled = capability("orbit");
  assert.equal(enabled.isCapable, true);
  assert.equal(enabled.isLoading, false);
  assert.equal(enabled.isError, false);
  runtime.setEnabled(false);
  provider = "openai";
  assert.equal(capability("orbit").isCapable, false, "disabling restores the account gate even with an official provider");
  allowed = true;
  provider = "custom";
  assert.equal(capability("orbit").isCapable, false, "disabling restores the provider gate");
  provider = "openai";
  assert.equal(capability("orbit").isCapable, true);
  assert.equal(updated, 3);
  mounted();
  runtime.setEnabled(true);
  assert.equal(updated, 3);
});

test("Dot modules compose with existing patches and install when the composer quota adapter is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "panel-dot-"));
  try {
    const prefs = path.join(root, "preferences.json");
    await writeFile(prefs, JSON.stringify({showCustomProviderDot: true}));
    const modules = [{url, source: initial + '\nconst existingUltrafast = true;'}];
    const prepared = await prepareCodexDotEntry({send() {throw Error("must reuse existing source")}}, modules, () => {});
    assert.equal(prepared.prepared, true);
    assert.match(prepared.modules[0].source, /existingUltrafast = true/);
    const bootstrap = await prepareCodexProviderQuotaFix({async send() {return {exceptionDetails: {text: "unmatched composer"}}}}, prefs, () => {}, prepared.modules, true, false);
    let map;
    const context = {
      document: {documentElement: {prepend(value) {map=value}}, createElement: () => ({})},
      MutationObserver: class {observe() {} disconnect() {}},
      URL: {createObjectURL: () => "blob:dot"}, Blob,
    };
    context.window = context; context.top = context;
    vm.runInNewContext(bootstrap, context);
    assert.deepEqual(JSON.parse(map.textContent).imports, {[url]: "blob:dot"});
    assert.equal(context.__codexPanelDotBootstrapPrepared__, true);
    assert.equal(context.__codexPanelUltrafastBootstrapPrepared__, false);
    assert.equal(context.__codexPanelDotEntryV1__.getSnapshot(), true);
    assert.equal(rewriteCodexDotEntry("unknown build", url), null);
  } finally { await rm(root, {recursive: true, force: true}); }
});
