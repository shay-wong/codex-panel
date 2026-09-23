import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_PROVIDER_QUOTA_ASSET,
  installCodexProviderQuotaFix,
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

test("the saved switch controls interception of the supported native asset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-quota-switch-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const preferencesFile = join(directory, "preferences.json");
  const untouchedCdp = {on() {assert.fail("disabled preference installed an interceptor");}, send() {assert.fail("disabled preference enabled interception");}};
  await installCodexProviderQuotaFix(untouchedCdp, undefined, () => {});
  for (const preferences of [{}, {customProviderQuotaFix: false}]) {
    await writeFile(preferencesFile, JSON.stringify(preferences));
    await installCodexProviderQuotaFix(untouchedCdp, preferencesFile, () => {});
  }
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: true}));
  for (const scenario of ["supported", "unknown", "read-error", "http-error"]) {
    const handlers = new Map();
    const calls = [];
    const cdp = {
      on(event, callback) { handlers.set(event, callback); },
      async send(method, params) {
        calls.push({method, params});
        if (method === "Fetch.getResponseBody") {
          if (scenario === "read-error") throw new Error("body unavailable");
          return {base64Encoded: true, body: Buffer.from(scenario === "unknown" ? "other source" : source).toString("base64")};
        }
        return {};
      },
    };
    const reports = [];
    await installCodexProviderQuotaFix(cdp, preferencesFile, message => reports.push(message));
    assert.deepEqual(calls.find(call => call.method === "Fetch.enable").params.patterns, [{urlPattern: `*/assets/${CODEX_PROVIDER_QUOTA_ASSET}`, resourceType: "Script", requestStage: "Response"}]);
    handlers.get("Network.responseReceived")({response: {url: `app://-/assets/${CODEX_PROVIDER_QUOTA_ASSET}?private-value`, status: 200, fromDiskCache: true}, type: "Script"});
    assert.match(reports.at(-1), /type=Script status=200 diskCache=true/);
    assert.doesNotMatch(reports.at(-1), /private-value/);
    await handlers.get("Fetch.requestPaused")({requestId: "native-script", resourceType: "Script", responseStatusCode: scenario === "http-error" ? 404 : 200, responseHeaders: [{name: "Content-Type", value: "text/javascript"}, {name: "Content-Length", value: "1"}]});
    const final = calls.at(-1);
    if (scenario === "supported") {
      assert.equal(final.method, "Fetch.fulfillRequest");
      const received = vm.runInNewContext(`${Buffer.from(final.params.body, "base64")};composer`);
      assert.equal(received({threadProvider: "custom"}).submit(), "hello");
      assert.deepEqual(final.params.responseHeaders, [{name: "Content-Type", value: "text/javascript"}]);
    } else {
      assert.equal(final.method, "Fetch.continueRequest");
    }
  }
  await writeFile(preferencesFile, JSON.stringify({customProviderQuotaFix: false}));
  await installCodexProviderQuotaFix(untouchedCdp, preferencesFile, () => {});
});
