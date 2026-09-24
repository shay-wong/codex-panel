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

const currentSource = source
  .replace("function m7(e){", "function h7(e){")
  .replaceAll("tv", "Yp").replaceAll("zl", "Rw").replaceAll("Hf", "dT")
  .replace('disabled = false}', 'disabled = false, policy = false}')
  .replace('const et = host, ye = disabled, $e = false, ot = false, nt = true, Rt = true;', `
    const eT = "host", nle = "quota", RK = "work-quota", mwe = "thread-state";
    const F = atom => atom === eT ? host : true, X = () => true;
    const et=F(eT,Qe), nt=F(nle,et), Rt=X(RK)&&et===\x60local\x60;
    const ye = disabled, $e = false, it = policy ? "failed" : "idle", at = {codexErrorInfo: "misalignmentPolicyViolation"};
    const ot=it===\x60failed\x60&&at?.codexErrorInfo===\x60misalignmentPolicyViolation\x60;
    Me.get(mwe,Qe);
    (0,g7.useState)(null);
    const root = {"data-codex-composer-root": ""};
  `)
  .replace('const submissionState = {submitDisabled: cn || uploading || !text.trim()};',
    'const submissionState = {submitDisabled:cn,}; submissionState.submitDisabled ||= uploading || !text.trim();')
  + '\nfunction providerQuota(e,t,n=\x60fresh\x60){let{cwd:r,hostId:i}=e.get(Yp,t);if(i!==\x60local\x60)return null;let{data:a}=e.get(dT,{cwd:r,hostId:i});return a==null||(e.get(Rw,t)??a.model_provider??\x60openai\x60)!==\x60openai\x60?null:quotaStatus(e,n)}';
const renamed = {h7: "composer$9", g7: "react$9", Yp: "target$9", Rw: "provider$9", dT: "config$9", Me: "store$9", Qe: "thread$9", et: "host$9", cn: "disabled$9", nt: "quota$9", Rt: "workQuota$9", ye: "external$9", $e: "pending$9", ot: "policy$9"};
const builds = [
  {asset: CODEX_PROVIDER_QUOTA_ASSET, composer: "m7", react: "h7", source},
  {asset: "app-primary-d66705000d76.js", composer: "h7", react: "g7", source: currentSource},
  {asset: "app-primary-renamed.js", composer: renamed.h7, react: renamed.g7,
    source: currentSource.replace(/[A-Za-z_$][\w$]*/g, name => renamed[name] ?? name)},
];

for (const build of builds) {
  const sourceUrl = `app://-/assets/${build.asset}`;

  test(`${build.asset}: custom local provider can submit despite account quotas; native blockers and OpenAI quotas still apply`, () => {
    const original = vm.runInNewContext(`${build.source};${build.composer}`, {[build.react]: {useState: () => [null]}});
    const runtime = createCodexProviderQuotaRuntime(true);
    const patched = vm.runInNewContext(`${rewriteCodexProviderQuota(build.source, sourceUrl)};${build.composer}`, {
      __codexPanelProviderQuotaV1__: runtime,
      [build.react]: {useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useState: () => [null]},
    });
    assert.equal(original({threadProvider: "custom"}).submit(), false);
    assert.equal(patched({threadProvider: "custom"}).submit(), "hello");
    assert.equal(patched({configProvider: "custom"}).submitDisabled, false);
    if (build.asset !== CODEX_PROVIDER_QUOTA_ASSET) assert.equal(patched({threadProvider: "custom", policy: true}).submit(), false);
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

  test(`${build.asset}: the adapter installs once even when disabled and the same runtime changes the gate`, async (t) => {
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
            // Exercise discovery itself: missing build assets may reject or return 404.
            const value = await vm.runInNewContext(params.expression, {
              URL, location: {href: "app://-/index.html"},
              performance: {getEntriesByType: () => enabled ? [{name: sourceUrl}] : []},
              document: {querySelectorAll: () => enabled === false ? [{src: sourceUrl}] : build.asset === CODEX_PROVIDER_QUOTA_ASSET ? [] : [{href: sourceUrl}]},
              async fetch(url) {
                if (url !== sourceUrl) {
                  if (enabled) throw new Error("asset unavailable");
                  return {ok: false};
                }
                return {ok: true, text: async () => scenario === "unknown" ? "other source" : build.source};
              },
            });
            return {result: {value}};
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
          [build.react]: {useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useState: () => [null]},
          MutationObserver: class {constructor(handler) {callback = handler;} observe() {} disconnect() {}},
          Blob: class {constructor(parts) {replacementSource = parts.join("");}},
          URL: {createObjectURL() {return "blob:fixture";}},
        });
        vm.runInContext(bootstrap, context);
        assert.equal(insertedMap, undefined);
        document.documentElement = {prepend(map) {insertedMap = map; mapCount += 1;}};
        callback();
        assert.equal(insertedMap.type, "importmap");
        assert.deepEqual(JSON.parse(insertedMap.textContent), {imports: {[sourceUrl]: "blob:fixture"}});
        const composer = vm.runInContext(`${replacementSource};${build.composer}`, context);
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

}

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

// Changed semantics must not be treated as a routine minifier rename.
test("ambiguous or changed quota structures keep the native module", () => {
  const url = "app://-/assets/app-primary-unknown.js";
  assert.equal(rewriteCodexProviderQuota(currentSource.replace("cn=ye||$e||ot||nt||Rt", "cn=ye||$e||ot||nt&&Rt"), url), null);
  assert.equal(rewriteCodexProviderQuota(currentSource + currentSource, url), null);
});
