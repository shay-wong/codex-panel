// ChatGPT 26.917.51856: keep the native composer and submission checks, but
// exclude ChatGPT account quotas when local Codex uses a custom provider.
import { readFile } from "node:fs/promises";

export const CODEX_PROVIDER_QUOTA_ASSET = "app-primary-aaee46b7f0ce.js";
const accountQuotaGate = "cn=ye||$e||ot||nt||Rt";
const providerQuotaGate = "cn=ye||$e||ot||((nt||Rt)&&!(()=>{const target=Me.get(tv,Qe);const provider=Me.get(zl,Qe)??Me.get(Hf,target).data?.model_provider;return et===`local`&&typeof provider===`string`&&provider!==`openai`})())";

export function rewriteCodexProviderQuota(source) {
  if (source.includes(providerQuotaGate)) return source;
  if (source.split(accountQuotaGate).length !== 2) return null;
  return source.replace(accountQuotaGate, providerQuotaGate);
}

export async function installCodexProviderQuotaFix(cdp, preferencesFile, report = console.error) {
  if (!preferencesFile) {
    report("Panel custom-provider quota fix disabled: no preferences file configured.");
    return;
  }
  try {
    const preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
    if (preferences.customProviderQuotaFix !== true) {
      report("Panel custom-provider quota fix disabled by preference.");
      return;
    }
  } catch (error) {
    report(`Panel custom-provider quota preference unavailable: ${error.message}`);
    return;
  }
  cdp.on("Network.responseReceived", ({ response, type }) => {
    const asset = response.url.split("/").at(-1)?.split(/[?#]/)[0];
    if (!/^app-primary-[\da-f]+\.js$/.test(asset ?? "")) return;
    report(`Panel custom-provider quota script loaded: asset=${asset} type=${type} status=${response.status} diskCache=${response.fromDiskCache === true} serviceWorker=${response.fromServiceWorker === true}`);
  });
  await cdp.send("Network.enable");
  cdp.on("Fetch.requestPaused", async (event) => {
    const { requestId, responseStatusCode } = event;
    report(`Panel custom-provider quota script intercepted: type=${event.resourceType} status=${responseStatusCode ?? "none"}`);
    let fulfilled = false;
    try {
      if (responseStatusCode >= 200 && responseStatusCode < 300) {
        const response = await cdp.send("Fetch.getResponseBody", { requestId });
        const original = response.base64Encoded
          ? Buffer.from(response.body, "base64").toString("utf8")
          : response.body;
        const patched = rewriteCodexProviderQuota(original);
        if (patched === null) {
          report("Panel custom-provider quota fix: unsupported composer source; keeping original.");
        } else {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: responseStatusCode,
            responseHeaders: (event.responseHeaders ?? []).filter(({ name }) => (
              !["content-length", "content-encoding", "etag"].includes(name.toLowerCase())
            )),
            body: Buffer.from(patched).toString("base64"),
          });
          fulfilled = true;
          report("Panel custom-provider quota fix applied to the native Codex composer.");
        }
      }
    } catch (error) {
      report(`Panel custom-provider quota fix unavailable: ${error.message}`);
    } finally {
      if (!fulfilled) await cdp.send("Fetch.continueRequest", { requestId });
    }
  });
  await cdp.send("Fetch.enable", {
    patterns: [{
      urlPattern: `*/assets/${CODEX_PROVIDER_QUOTA_ASSET}`,
      resourceType: "Script",
      requestStage: "Response",
    }],
  });
  report("Panel custom-provider quota fix enabled; waiting for the native composer script.");
}
