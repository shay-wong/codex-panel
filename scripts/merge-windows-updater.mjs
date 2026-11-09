#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { windowsReleaseMetadata } from "./release-metadata.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const [latestPath, installerPath, tag] = process.argv.slice(2);
if (!latestPath || !installerPath || !tag) {
  throw new Error("Usage: merge-windows-updater.mjs <latest.json> <installer.exe> <tag>");
}
let latest;
try {
  latest = JSON.parse(await readFile(latestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  latest = { version: tag.replace(/^v/, ""), platforms: {} };
}
const metadata = windowsReleaseMetadata(latest.version, tag);
if (path.basename(installerPath) !== metadata.archive || !latest.platforms
  || typeof latest.platforms !== "object" || Array.isArray(latest.platforms)) {
  throw new Error("Windows 安装器名称或更新清单不匹配");
}
const signature = (await readFile(`${installerPath}.sig`, "utf8")).trim();
// 发布前再次验签；跨 job 传递的安装器必须与写入清单的签名一致。
await verifyUpdaterSignature({
  publicKey: process.env.CODEX_PANEL_UPDATER_PUBLIC_KEY || "",
  artifactPath: installerPath,
  signature,
});
for (const platform of [metadata.platform, `${metadata.platform}-nsis`]) {
  latest.platforms[platform] = { signature, url: metadata.url };
}
await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
