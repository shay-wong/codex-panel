import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function verifyRuntimeIntegrity(resources, runtimePath) {
  const manifest = JSON.parse(await readFile(path.join(resources, "runtime-integrity.json"), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Packaged runtime integrity manifest is invalid");
  }
  const runtimeName = path.basename(runtimePath);
  let hasRuntime = false;
  const seen = new Set();
  for (const entry of manifest.files) {
    const parts = typeof entry.path === "string" ? entry.path.split("/") : [];
    if (!parts.length || parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))
      || path.isAbsolute(entry.path) || seen.has(entry.path) || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
      throw new Error("Packaged runtime integrity entry is invalid");
    }
    seen.add(entry.path);
    const isRuntime = entry.path === runtimeName;
    hasRuntime ||= isRuntime;
    // sidecar 位于 MacOS/usr/bin，与普通资源分开解析，签名后必须保持原始字节。
    const file = isRuntime ? runtimePath : path.join(resources, ...parts);
    const hash = createHash("sha256").update(await readFile(file)).digest("hex");
    if (hash !== entry.sha256.toLowerCase()) throw new Error(`Packaged runtime integrity mismatch: ${entry.path}`);
  }
  if (!hasRuntime) throw new Error("Packaged runtime integrity manifest is missing the native sidecar");
}
