import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

function packageName(specifier) {
  if (
    specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.startsWith("node:")
    || specifier.startsWith("#")
  ) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

export async function discoverRuntimePackages(appRoot, dependencies) {
  const packages = new Set();
  for (const filePath of await sourceFiles(appRoot)) {
    const source = await readFile(filePath, "utf8");
    const imports = source.matchAll(
      /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    );
    for (const match of imports) {
      const name = packageName(match[1] ?? match[2]);
      if (name) packages.add(name);
    }
  }
  for (const name of packages) {
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`Packaged runtime imports undeclared dependency '${name}'`);
    }
  }
  return [...packages].sort((left, right) => left.localeCompare(right, "en"));
}

export async function verifyRuntimePackages(appRoot, dependencies) {
  for (const name of await discoverRuntimePackages(appRoot, dependencies)) {
    const manifest = path.join(appRoot, "node_modules", ...name.split("/"), "package.json");
    if (!(await stat(manifest)).isFile()) {
      throw new Error(`Packaged runtime is missing dependency '${name}'`);
    }
  }
}
