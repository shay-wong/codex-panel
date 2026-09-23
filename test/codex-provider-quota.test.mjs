import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
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

test("only the supported native asset is intercepted, and failed or unknown responses are released", async () => {
  for (const scenario of ["supported", "unknown", "read-error", "http-error"]) {
    let handler;
    const calls = [];
    const cdp = {
      on(event, callback) { assert.equal(event, "Fetch.requestPaused"); handler = callback; },
      async send(method, params) {
        calls.push({method, params});
        if (method === "Fetch.getResponseBody") {
          if (scenario === "read-error") throw new Error("body unavailable");
          return {base64Encoded: true, body: Buffer.from(scenario === "unknown" ? "other source" : source).toString("base64")};
        }
        return {};
      },
    };
    await installCodexProviderQuotaFix(cdp, () => {});
    assert.deepEqual(calls[0].params.patterns, [{urlPattern: `*/assets/${CODEX_PROVIDER_QUOTA_ASSET}`, resourceType: "Script", requestStage: "Response"}]);
    await handler({requestId: "native-script", responseStatusCode: scenario === "http-error" ? 404 : 200, responseHeaders: [{name: "Content-Type", value: "text/javascript"}, {name: "Content-Length", value: "1"}]});
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
});
