import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_PROVIDER_QUOTA_ASSET,
  createCodexProviderQuotaRuntime,
  watchCodexProviderQuotaPreferences,
  prepareCodexProviderQuotaFix,
  rewriteCodexProviderQuota,
} from "../scripts/codex-provider-quota.mjs";

// Preserve the native compiler's quota expression and its shared submit state.
const source = `function m7(e){
  const options = e;
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
  const original = vm.runInNewContext(`${source};m7`);
  const runtime = createCodexProviderQuotaRuntime(true);
  const patched = vm.runInNewContext(`${rewriteCodexProviderQuota(source)};m7`, {
    __codexPanelProviderQuotaV1__: runtime,
    h7: {useSyncExternalStore: (_, getSnapshot) => getSnapshot()},
  });
  assert.equal(original({threadProvider: "custom"}).submit(), false);
  assert.equal(patched({threadProvider: "custom"}).submit(), "hello");
  assert.equal(patched({configProvider: "custom"}).submitDisabled, false);
  runtime.setEnabled(false);
  assert.equal(patched({threadProvider: "custom"}).submit(), false);
  runtime.setEnabled(true);
  assert.equal(patched({threadProvider: "custom"}).submit(), "hello");
  assert.equal(patched({threadProvider: "openai", configProvider: "custom"}).submit(), false);
  for (const options of [
    {}, {configProvider: "openai"},
    {threadProvider: "custom", text: ""},
    {threadProvider: "custom", uploading: true},
    {threadProvider: "custom", disabled: true},
    {threadProvider: "custom", host: "remote"},
  ]) assert.equal(patched(options).submit(), false, JSON.stringify(options));
});

test("the adapter installs once even when disabled and the same runtime changes the gate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-quota-switch-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const preferencesFile = join(directory, "preferences.json");
  assert.equal(await prepareCodexProviderQuotaFix({send() {assert.fail("no preferences");}}), "");
  for (const enabled of [undefined, false, true]) {
    if (enabled !== undefined) await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: enabled}));
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
      let callback, replacementSource, insertedMap, mapCount = 0;
      const document = {documentElement: null, createElement() { return {}; }};
      const window = {};
      window.top = window;
      const context = vm.createContext({
        document, window,
        h7: {useSyncExternalStore: (_, getSnapshot) => getSnapshot()},
        MutationObserver: class {constructor(handler) {callback = handler;} observe() {} disconnect() {}},
        Blob: class {constructor(parts) {replacementSource = parts.join("");}},
        URL: {createObjectURL() {return "blob:fixture";}},
      });
      vm.runInContext(bootstrap, context);
      assert.equal(insertedMap, undefined);
      document.documentElement = {prepend(map) {insertedMap = map; mapCount += 1;}};
      callback();
      assert.equal(insertedMap.type, "importmap");
      assert.deepEqual(JSON.parse(insertedMap.textContent), {imports: {[`app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}`]: "blob:fixture"}});
      const composer = vm.runInContext(`${replacementSource};m7`, context);
      const runtime = context.__codexPanelProviderQuotaV1__;
      assert.equal(runtime.installed, true);
      assert.equal(composer({threadProvider: "custom"}).submit(), enabled ? "hello" : false);
      let renders = 0;
      const unsubscribe = runtime.subscribe(() => { renders += 1; });
      for (const next of [!enabled, enabled]) {
        runtime.setEnabled(next);
        assert.equal(composer({threadProvider: "custom"}).submit(), next ? "hello" : false);
        runtime.setEnabled(next);
      }
      assert.equal(renders, 2);
      unsubscribe();
      vm.runInContext(bootstrap, context);
      assert.equal(mapCount, 1);
    }
  }
});

test("atomic preference saves notify the running injector without a service restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-quota-watch-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const preferencesFile = join(directory, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: false}));
  let onChange;
  const watcher = watchCodexProviderQuotaPreferences(preferencesFile, () => onChange?.());
  t.after(() => watcher.close());
  for (const enabled of [true, false, true]) {
    const changed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("preference notification timed out")), 1000);
      onChange = () => { clearTimeout(timeout); resolve(); };
    });
    await writeFile(preferencesFile + ".tmp", JSON.stringify({customProviderQuotaFix: enabled}));
    await rename(preferencesFile + ".tmp", preferencesFile);
    await changed;
    assert.equal(JSON.parse(await readFile(preferencesFile, "utf8")).customProviderQuotaFix, enabled);
  }
});

test("the replacement retains relative imports and import.meta.url from the original module", () => {
  const module = `import { value } from"./shared.js"; ${source}; const lazy = import(\`./lazy.js\`); export const url = import.meta.url;`;
  const patched = rewriteCodexProviderQuota(module, `app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}`);
  assert.match(patched, /from"app:\/\/-\/assets\/shared\.js"/);
  assert.match(patched, /import\("app:\/\/-\/assets\/lazy\.js"\)/);
  assert.match(patched, /export const url = "app:\/\/-\/assets\/app-primary-aaee46b7f0ce\.js"/);
});
