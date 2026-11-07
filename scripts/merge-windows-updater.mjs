#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { windowsReleaseMetadata } from "./release-metadata.mjs";

const [latestPath, packageVersion, tag, signature] = process.argv.slice(2);
if (!latestPath || !packageVersion || !tag || !signature) {
  throw new Error("Usage: merge-windows-updater.mjs <latest.json> <version> <tag> <signature>");
}
const metadata = windowsReleaseMetadata(packageVersion, tag);
const latest = JSON.parse(await readFile(latestPath, "utf8"));
if (latest.version !== packageVersion || !latest.platforms || typeof latest.platforms !== "object") {
  throw new Error("latest.json 与当前 Windows 发布版本不匹配");
}
latest.platforms[metadata.platform] = { signature, url: metadata.url };
await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
