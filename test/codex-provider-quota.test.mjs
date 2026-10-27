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
// 26.928.20755 also gates submission on pending sessions and service-tier loading.
const latestSource = currentSource.replace('const cn=ye||$e||ot||nt||Rt;', `
  const sessionPending = e.sessionPending, isNewSession = e.isNewSession;
  const threadUnavailable = e.threadUnavailable, settings = e.settings;
  const cn=ye||$e||sessionPending&&isNewSession||threadUnavailable||ot||settings?.isLoading===!0||nt||Rt;
`);
const builds = [
  {asset: CODEX_PROVIDER_QUOTA_ASSET, composer: "m7", react: "h7", source},
  {asset: "app-primary-d66705000d76.js", composer: "h7", react: "g7", source: currentSource},
  {asset: "app-primary-92c16ff2fe4e.js", composer: "h7", react: "g7", source: latestSource, sessionChecks: true},
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
    if (build.sessionChecks) {
      for (const blockers of [
        {sessionPending: true, isNewSession: true},
        {threadUnavailable: true},
        {settings: {isLoading: true}},
      ]) assert.equal(patched({threadProvider: "custom", ...blockers}).submit(), false);
      assert.equal(patched({threadProvider: "custom", sessionPending: true, isNewSession: false}).submit(), "hello");
      assert.equal(patched({threadProvider: "custom", settings: {isLoading: false}}).submit(), "hello");
    }
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
        // 原生模块尚未被首页加载时，重复注入只更新开关，不重建 importmap。
        assert.equal(context.__codexPanelProviderQuotaV1__.prepared, true);
        assert.equal(context.__codexPanelProviderQuotaV1__.installed, false);
        vm.runInContext(bootstrap, context);
        assert.equal(mapCount, 1);
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


test("reinstallation discovers the original composer from import maps after blob loading", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-quota-reinstall-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const preferencesFile = join(directory, "preferences.json");
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: true}));
  const sourceUrl = "app://-/assets/app-primary-83ab2f0c1a5c.js";
  const reports = [];
  const cdp = {
    on() {},
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      const value = await vm.runInNewContext(params.expression, {
        URL, location: {href: "app://-/index.html"},
        performance: {getEntriesByType: () => [{name: "blob:already-patched"}]},
        document: {querySelectorAll: selector => selector === 'script[type="importmap"]'
          ? [{textContent: "invalid"}, {textContent: JSON.stringify({imports: {[sourceUrl]: "blob:already-patched"}})}]
          : []},
        async fetch(url) {
          assert.equal(url, sourceUrl, "重新注入必须读取映射中的当前版本，不能猜测旧版文件名");
          return {ok: true, text: async () => latestSource};
        },
      });
      return {result: {value}};
    },
  };
  const bootstrap = await prepareCodexProviderQuotaFix(cdp, preferencesFile, message => reports.push(message));
  assert.ok(bootstrap.includes(sourceUrl));
  assert.ok(bootstrap.includes("runtime.setEnabled(true)"));
  assert.match(reports.at(-1), /prepared/);
});

// 26.1021 moves the native submit gate into a lazy composer adapter.
const splitProviderSource = `import{target as Target,config as Config,provider as Provider}from"./app-initial-fixture.js";
function providerQuota(e,t,n=\x60fresh\x60){let{cwd:r,hostId:i}=e.get(Target,t);if(i!==\x60local\x60)return null;let{data:a}=e.get(Config,{cwd:r,hostId:i});return a==null||(e.get(Provider,t)??a.model_provider??\x60openai\x60)!==\x60openai\x60?null:quotaStatus(e,n)}
const adapter = "./codex-composer-adapter-fixture.js";`;
const splitSource = `function composer(e){
  const read=(atom,key)=>atom==="host"?(e.host??"local"):atom===panelQuotaTargetAtom?{hostId:e.host??"local",cwd:"/disposable/project"}:atom===panelQuotaProviderAtom?e.threadProvider:atom===panelQuotaConfigAtom?{data:{model_provider:e.configProvider}}:e.quota;
  const thread="fixture",Host="host",Quota="quota",host=read(Host,thread),quota=read(Quota,host),state=e.policy?"failed":"idle",error={codexErrorInfo:"misalignmentPolicyViolation"};
  const policy=state===\x60failed\x60&&error?.codexErrorInfo===\x60misalignmentPolicyViolation\x60;
  const Work="work-quota",use=value=>value?e.workQuota:false,work=use(host===\x60local\x60&&Work);
  (0,React.useState)(null);
  const disabled=e.disabled,pending=e.pending,newThread=e.newThread,settings=e.settings;
  let blocked=disabled||pending&&newThread||policy||settings?.isLoading===!0||quota||work,next;
  return {submitDisabled:blocked,submit:()=>blocked?false:"sent"};
}`;

test("split native composer preserves policy, pending and loading gates while bypassing only custom local quotas", () => {
  const patched = rewriteCodexProviderQuota(splitSource, "app://-/assets/codex-composer-adapter-fixture.js", splitProviderSource);
  assert.ok(patched);
  const runtime = createCodexProviderQuotaRuntime(true);
  const composer = vm.runInNewContext(patched.replace(/^import[^;]+;/, "") + ";composer", {
    panelQuotaTargetAtom:"target",panelQuotaConfigAtom:"config",panelQuotaProviderAtom:"provider",
    React:{useState:()=>[],useSyncExternalStore:(_,get)=>get()},
    __codexPanelProviderQuotaV1__:runtime,
  });
  const allowed={threadProvider:"custom",quota:true,workQuota:true};
  assert.equal(composer(allowed).submit(),"sent");
  assert.equal(composer({...allowed,threadProvider:undefined,configProvider:"custom"}).submit(),"sent");
  for(const option of [{policy:true},{disabled:true},{pending:true,newThread:true},{settings:{isLoading:true}},{host:"remote"},{threadProvider:"openai",configProvider:"custom"},{threadProvider:""},{threadProvider:undefined}]) {
    assert.equal(composer({...allowed,...option}).submit(),false,JSON.stringify(option));
  }
  runtime.setEnabled(false);
  assert.equal(composer(allowed).submit(),false);
  assert.equal(rewriteCodexProviderQuota(splitSource+splitSource,"app://-/assets/codex-composer-adapter-fixture.js",splitProviderSource),null);
});

test("split composer discovery installs its adapter and reports quota application only when that module executes", async t => {
  const directory=await mkdtemp(join(tmpdir(),"panel-quota-split-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const preferencesFile=join(directory,"preferences.json");
  await writeFile(preferencesFile,'{"customProviderQuotaFix":true}');
  const primaryUrl="app://-/assets/app-primary-fixture.js",adapterUrl="app://-/assets/codex-composer-adapter-fixture.js";
  for(const supported of [true,false]) {
    const cdp={on(){},async send(_,params){return {result:{value:await vm.runInNewContext(params.expression,{
      URL,location:{href:"app://-/index.html"},performance:{getEntriesByType:()=>[{name:primaryUrl}]},document:{querySelectorAll:()=>[]},
      fetch:async url=>({ok:true,text:async()=>url===primaryUrl?splitProviderSource:supported?splitSource:"unsupported"}),
    })}};}};
    const bootstrap=await prepareCodexProviderQuotaFix(cdp,preferencesFile,()=>{},[{url:"app://-/assets/dot.js",source:"void 0;"}],true,false);
    const window={};window.top=window;
    const blobs=[];
    const context=vm.createContext({window,document:{documentElement:{prepend(){}},createElement:()=>({})},MutationObserver:class{observe(){}disconnect(){}},URL:{createObjectURL:()=>"blob:fixture"},Blob:class{constructor(parts){blobs.push(parts.join(""));}}});
    vm.runInContext(bootstrap,context);
    assert.equal(window.__codexPanelQuotaBootstrapPrepared__,supported);
    assert.equal(context.__codexPanelProviderQuotaV1__.applied,false);
    vm.runInContext(blobs[0],context);
    assert.equal(context.__codexPanelProviderQuotaV1__.applied,false,"Dot execution does not prove quota applied");
    if(supported){assert.ok(bootstrap.includes(adapterUrl));vm.runInContext(blobs[1].replace(/^import[^;]+;/,""),context);assert.equal(context.__codexPanelProviderQuotaV1__.applied,true);}
  }
});
