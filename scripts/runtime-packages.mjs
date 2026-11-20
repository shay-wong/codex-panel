import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const oxcParserBindings = {
  "aarch64-apple-darwin": ["darwin-arm64"],
  "x86_64-apple-darwin": ["darwin-x64"],
  "universal-apple-darwin": ["darwin-arm64", "darwin-x64"],
  "x86_64-pc-windows-msvc": ["win32-x64-msvc"],
  "x86_64-unknown-linux-gnu": ["linux-x64-gnu"],
};

function requiredOxcParserBindings(target) {
  const bindings = target
    ? oxcParserBindings[target]
    : Object.values(oxcParserBindings).flat().filter(value => (
      value === `${process.platform}-${process.arch}`
      || value === `${process.platform}-${process.arch}-msvc`
      || value === `${process.platform}-${process.arch}-gnu`
    ));
  if (!bindings?.length) throw new Error(`Unsupported Oxc parser target: ${target ?? `${process.platform}-${process.arch}`}`);
  return [...new Set(bindings)].map(binding => `@oxc-parser/binding-${binding}`);
}

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

export async function copyRuntimePackages(appRoot, {
  sourceRoot,
  dependencies,
  target,
  resolveMissingPackage,
}) {
  sourceRoot = path.resolve(sourceRoot);
  const copiedPackages = new Set();

  async function locatePackage(name, fromDirectory) {
    let directory = fromDirectory;
    while (true) {
      const candidate = path.join(directory, "node_modules", ...name.split("/"));
      try {
        await stat(path.join(candidate, "package.json"));
        return candidate;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (directory === sourceRoot || directory === path.dirname(directory)) break;
      directory = path.dirname(directory);
    }
    if (fromDirectory !== sourceRoot) return locatePackage(name, sourceRoot);
    return null;
  }

  async function copyPackage(name, fromDirectory = sourceRoot, expectedVersion) {
    let sourcePath = await locatePackage(name, fromDirectory);
    let downloaded = false;
    if (!sourcePath && expectedVersion && resolveMissingPackage) {
      sourcePath = await resolveMissingPackage(name, expectedVersion);
      downloaded = true;
    }
    if (!sourcePath) throw new Error(`Runtime dependency '${name}' is not installed for ${target ?? `${process.platform}-${process.arch}`}`);
    const manifest = JSON.parse(await readFile(path.join(sourcePath, "package.json"), "utf8"));
    if (expectedVersion && (manifest.name !== name || manifest.version !== expectedVersion)) {
      throw new Error(`Runtime dependency '${name}' must be version ${expectedVersion}`);
    }
    const relativePath = path.relative(sourceRoot, sourcePath);
    const destinationPath = downloaded || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
      ? path.join(appRoot, "node_modules", ...name.split("/"))
      : path.join(appRoot, relativePath);
    if (copiedPackages.has(destinationPath)) return;
    copiedPackages.add(destinationPath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await copyPackage(dependency, sourcePath);
    }
    if (name === "oxc-parser") {
      for (const binding of requiredOxcParserBindings(target)) {
        const version = manifest.optionalDependencies?.[binding];
        if (!version) throw new Error(`Oxc parser does not declare the required binding '${binding}'`);
        await copyPackage(binding, sourcePath, version);
      }
    }
  }

  for (const name of await discoverRuntimePackages(appRoot, dependencies)) {
    await copyPackage(name);
  }
}

export async function verifyRuntimePackages(appRoot, dependencies) {
  for (const name of await discoverRuntimePackages(appRoot, dependencies)) {
    const manifest = path.join(appRoot, "node_modules", ...name.split("/"), "package.json");
    if (!(await stat(manifest)).isFile()) {
      throw new Error(`Packaged runtime is missing dependency '${name}'`);
    }
  }
}

export function verifyBundledParser(nodePath, appRoot) {
  const source = 'const value="😀";function example(){return value;}';
  const result = spawnSync(nodePath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const require = createRequire(${JSON.stringify(path.join(appRoot, "package.json"))});
    const { parseSync } = await import(pathToFileURL(require.resolve("oxc-parser")).href);
    const source = ${JSON.stringify(source)};
    const parsed = parseSync("fixture.js", source);
    const node = parsed.program.body[1];
    if (parsed.errors.length || node?.type !== "FunctionDeclaration"
      || source.slice(node.start, node.end) !== "function example(){return value;}") {
      throw new Error("Bundled parser returned an invalid AST or source range");
    }
  `], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`Bundled Oxc parser failed: ${result.error?.message || result.stderr.trim() || `exit status ${result.status}`}`);
  }
}
