import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { copyRuntimePackages, verifyBundledParser } from "../scripts/runtime-packages.mjs";

const bindings = ["darwin-arm64", "darwin-x64", "win32-x64-msvc", "linux-x64-gnu"];

async function writePackage(directory, name, manifest = {}, source = "export default true;") {
  const packagePath = path.join(directory, "node_modules", ...name.split("/"));
  await mkdir(packagePath, { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name, version: "0.153.0", type: "module", main: "index.js", ...manifest,
  }));
  await writeFile(path.join(packagePath, "index.js"), source);
  return packagePath;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-runtime-packages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, "source");
  const appRoot = path.join(directory, "app");
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(appRoot, "entry.mjs"), 'import "oxc-parser";');
  const parser = await writePackage(sourceRoot, "oxc-parser", {
    dependencies: { "@oxc-project/types": "^0.153.0" },
    optionalDependencies: Object.fromEntries(bindings.map(binding => [
      `@oxc-parser/binding-${binding}`, "0.153.0",
    ])),
  }, 'export { default } from "@oxc-project/types";');
  await writePackage(parser, "@oxc-project/types", {}, 'export default "nested-0.153.0";');
  await writePackage(sourceRoot, "@oxc-project/types", { version: "0.139.0" }, 'export default "wrong-top-level";');
  return { sourceRoot, appRoot, dependencies: { "oxc-parser": "0.153.0" } };
}

test("runtime package copying preserves nested dependencies and both universal Mac bindings", async t => {
  const f = await fixture(t);
  for (const binding of bindings) await writePackage(f.sourceRoot, `@oxc-parser/binding-${binding}`);
  await copyRuntimePackages(f.appRoot, { ...f, target: "universal-apple-darwin" });
  assert.equal((await import(pathToFileURL(path.join(f.appRoot, "node_modules/oxc-parser/index.js")))).default, "nested-0.153.0");
  for (const binding of ["darwin-arm64", "darwin-x64"]) {
    const manifest = JSON.parse(await readFile(path.join(f.appRoot, "node_modules", "@oxc-parser", `binding-${binding}`, "package.json"), "utf8"));
    assert.equal(manifest.version, "0.153.0");
  }
  await assert.rejects(readFile(path.join(f.appRoot, "node_modules/@oxc-parser/binding-win32-x64-msvc/package.json")), { code: "ENOENT" });
});

test("runtime package copying selects the Windows and Linux native bindings", async t => {
  for (const [target, binding] of [
    ["x86_64-pc-windows-msvc", "win32-x64-msvc"],
    ["x86_64-unknown-linux-gnu", "linux-x64-gnu"],
  ]) {
    const f = await fixture(t);
    await writePackage(f.sourceRoot, `@oxc-parser/binding-${binding}`);
    await copyRuntimePackages(f.appRoot, { ...f, target });
    const manifest = JSON.parse(await readFile(path.join(f.appRoot, "node_modules", "@oxc-parser", `binding-${binding}`, "package.json"), "utf8"));
    assert.equal(manifest.name, `@oxc-parser/binding-${binding}`);
  }
});

test("runtime package copying reports a missing target binding and places a retrieved binding where Node resolves it", async t => {
  const f = await fixture(t);
  await writePackage(f.sourceRoot, "@oxc-parser/binding-darwin-arm64");
  await assert.rejects(copyRuntimePackages(f.appRoot, { ...f, target: "universal-apple-darwin" }), /binding-darwin-x64.*not installed/);
  const cached = await writePackage(path.join(f.sourceRoot, "dist/cache"), "@oxc-parser/binding-darwin-x64");
  const retrieved = [];
  await copyRuntimePackages(f.appRoot, {
    ...f, target: "universal-apple-darwin",
    resolveMissingPackage: async (name, version) => {
      retrieved.push([name, version]);
      return cached;
    },
  });
  assert.deepEqual(retrieved, [["@oxc-parser/binding-darwin-x64", "0.153.0"]]);
  assert.equal((await import(pathToFileURL(path.join(f.appRoot, "node_modules/@oxc-parser/binding-darwin-x64/index.js")))).default, true);
});

test("bundled parser preflight loads the packaged native binding and detects a missing binding", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-parser-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appRoot = path.join(directory, "app");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "entry.mjs"), 'import "oxc-parser";');
  await copyRuntimePackages(appRoot, {
    sourceRoot: fileURLToPath(new URL("../", import.meta.url)),
    dependencies: { "oxc-parser": "0.153.0" },
  });
  verifyBundledParser(process.execPath, appRoot);
  await rm(path.join(appRoot, "node_modules", "@oxc-parser"), { recursive: true, force: true });
  assert.throws(() => verifyBundledParser(process.execPath, appRoot), /Bundled Oxc parser failed: .*Cannot find native binding/s);
});
