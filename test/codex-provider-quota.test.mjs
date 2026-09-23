import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_PROVIDER_QUOTA_ASSET,
  prepareCodexProviderQuotaFix,
  rewriteCodexProviderQuota,
} from "../scripts/codex-provider-quota.mjs";

// Preserve the native compiler's quota expression and its shared submit state.
const source = `function composer(options) {
  const {threadProvider, configProvider, host = "local", text = "hello", uploading = false, disabled = false} = options;
  const tv = "target", zl = "thread-provider", Hf = "config", Qe = "thread";
  const Me = {get(atom) {
    if (atom === tv) return {hostId: host, cwd: "/disposable/workspace"};
    if (atom === zl) return threadProvider;
    if (atom === Hf) return {data: {model_provider: configProvider}};
  }};
  const et = host, ye = disabled, $e = false, ot = false, nt = true, Rt = true;
  const cn=ye||$e||ot||nt||Rt;
  const submissionState = {submitDisabled: cn || uploading || !text.trim()};
  return {...submissionState, submit() {if (submissionState.submitDisabled) return false; return text;}};
}`;

test("custom local provider can submit despite account quotas; native blockers and OpenAI quotas still apply", () => {
  const original = vm.runInNewContext(`${source};composer`);
  const patched = vm.runInNewContext(`${rewriteCodexProviderQuota(source)};composer`);
  assert.equal(original({threadProvider: "custom"}).submit(), false);
  assert.equal(patched({threadProvider: "custom"}).submit(), "hello");
  assert.equal(patched({configProvider: "custom"}).submitDisabled, false);
  assert.equal(patched({threadProvider: "openai", configProvider: "custom"}).submit(), false);
  for (const options of [
    {}, {configProvider: "openai"},
    {threadProvider: "custom", text: ""},
    {threadProvider: "custom", uploading: true},
    {threadProvider: "custom", disabled: true},
    {threadProvider: "custom", host: "remote"},
  ]) assert.equal(patched(options).submit(), false, JSON.stringify(options));
});

test("the saved switch prepares a module replacement only for supported source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-quota-switch-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const preferencesFile = join(directory, "preferences.json");
  const untouchedCdp = {on() {assert.fail("disabled preference registered a listener");}, send() {assert.fail("disabled preference read the composer");}};
  assert.equal(await prepareCodexProviderQuotaFix(untouchedCdp), "");
  for (const preferences of [{}, {customProviderQuotaFix: false}]) {
    await writeFile(preferencesFile, JSON.stringify(preferences));
    assert.equal(await prepareCodexProviderQuotaFix(untouchedCdp, preferencesFile), "");
  }
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: true}));
  for (const scenario of ["supported", "unknown", "read-error"]) {
    const reports = [];
    const cdp = {
      on(event) { assert.equal(event, "Runtime.consoleAPICalled"); },
      async send(method, params) {
        assert.equal(method, "Runtime.evaluate");
        assert.equal(params.awaitPromise, true);
        if (scenario === "read-error") return {exceptionDetails: {text: "failed"}};
        return {result: {value: {url: `app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}`, source: scenario === "unknown" ? "other source" : source}}};
      },
    };
    const bootstrap = await prepareCodexProviderQuotaFix(cdp, preferencesFile, message => reports.push(message));
    if (scenario !== "supported") {
      assert.equal(bootstrap, "");
      assert.match(reports.at(-1), /unavailable/);
      continue;
    }
    let callback, replacementSource, insertedMap;
    const document = {documentElement: null, createElement() { return {}; }};
    const window = {};
    window.top = window;
    vm.runInNewContext(bootstrap, {
      document, window,
      MutationObserver: class {constructor(handler) {callback = handler;} observe() {} disconnect() {}},
      Blob: class {constructor(parts) {replacementSource = parts.join("");}},
      URL: {createObjectURL() {return "blob:fixture";}},
    });
    assert.equal(insertedMap, undefined);
    document.documentElement = {prepend(map) {insertedMap = map;}};
    callback();
    assert.equal(insertedMap.type, "importmap");
    assert.deepEqual(JSON.parse(insertedMap.textContent), {imports: {[`app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}`]: "blob:fixture"}});
    assert.equal(vm.runInNewContext(`${replacementSource};composer`)({threadProvider: "custom"}).submit(), "hello");
  }
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: false}));
  assert.equal(await prepareCodexProviderQuotaFix(untouchedCdp, preferencesFile), "");
});

test("the replacement retains relative imports and import.meta.url from the original module", () => {
  const module = `import { value } from"./shared.js"; ${source}; const lazy = import(\`./lazy.js\`); export const url = import.meta.url;`;
  const patched = rewriteCodexProviderQuota(module, `app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}`);
  assert.match(patched, /from"app:\/\/-\/assets\/shared\.js"/);
  assert.match(patched, /import\("app:\/\/-\/assets\/lazy\.js"\)/);
  assert.match(patched, /export const url = "app:\/\/-\/assets\/app-primary-aaee46b7f0ce\.js"/);
});
