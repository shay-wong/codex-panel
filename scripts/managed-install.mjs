import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DIRECTORY_MARKER = ".codex-panel-managed.json";
const FILE_MARKER_PREFIX = "codex-panel-managed:";

class UnmanagedInstallPathError extends Error {}

export async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function resolvedSources(sourcePaths) {
  return new Set(sourcePaths.map((sourcePath) => path.resolve(sourcePath)));
}

async function managedDirectoryArtifact(targetPath) {
  try {
    const marker = JSON.parse(await readFile(path.join(targetPath, DIRECTORY_MARKER), "utf8"));
    return marker?.generator === "codex-panel" ? marker.artifact : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function managedFileArtifact(targetPath) {
  try {
    const prefix = (await readFile(targetPath, "utf8")).slice(0, 512);
    const match = prefix.match(/codex-panel-managed:([a-z0-9-]+):1/);
    return match?.[1] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertReplaceable(targetPath, artifact, replaceSources) {
  if (!(await pathExists(targetPath))) return false;

  const stats = await lstat(targetPath);
  if (stats.isSymbolicLink()) {
    const linkedPath = path.resolve(path.dirname(targetPath), await readlink(targetPath));
    if (resolvedSources(replaceSources).has(linkedPath)) return true;
    throw new UnmanagedInstallPathError(
      `${targetPath} points to an installation not managed by this repository`,
    );
  }

  if (stats.isDirectory() && await managedDirectoryArtifact(targetPath) === artifact) return true;
  if (stats.isFile() && await managedFileArtifact(targetPath) === artifact) return true;
  throw new UnmanagedInstallPathError(`${targetPath} is not managed by Codex Panel`);
}

async function replaceWithStagedPath(stagedPath, targetPath, artifact, replaceSources) {
  const hadPrevious = await assertReplaceable(targetPath, artifact, replaceSources);
  if (!hadPrevious) {
    await rename(stagedPath, targetPath);
    return;
  }

  const backupPath = path.join(
    path.dirname(stagedPath),
    `.previous-${path.basename(targetPath)}`,
  );
  await rename(targetPath, backupPath);
  try {
    await rename(stagedPath, targetPath);
  } catch (error) {
    await rename(backupPath, targetPath);
    throw error;
  }
  await rm(backupPath, { recursive: true, force: true });
}

export async function installManagedDirectory(
  sourcePath,
  targetPath,
  label,
  { artifact, replaceSources = [] },
) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertReplaceable(targetPath, artifact, replaceSources);
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(targetPath), ".codex-panel-install-"),
  );
  const stagedPath = path.join(temporaryDirectory, path.basename(targetPath));

  try {
    await cp(sourcePath, stagedPath, { recursive: true, preserveTimestamps: true });
    await writeFile(path.join(stagedPath, DIRECTORY_MARKER), `${JSON.stringify({
      artifact,
      generator: "codex-panel",
      schemaVersion: 1,
    }, null, 2)}\n`);
    await replaceWithStagedPath(stagedPath, targetPath, artifact, replaceSources);
    console.log(`${label} installed at ${targetPath}`);
    return true;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function installManagedFile(
  content,
  targetPath,
  label,
  { artifact, mode = 0o755, replaceSources = [] },
) {
  if (!content.includes(`${FILE_MARKER_PREFIX}${artifact}:1`)) {
    throw new Error(`${label} content is missing its ownership marker`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertReplaceable(targetPath, artifact, replaceSources);
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(targetPath), ".codex-panel-install-"),
  );
  const stagedPath = path.join(temporaryDirectory, path.basename(targetPath));

  try {
    await writeFile(stagedPath, content, { mode });
    await chmod(stagedPath, mode);
    await replaceWithStagedPath(stagedPath, targetPath, artifact, replaceSources);
    console.log(`${label} installed at ${targetPath}`);
    return true;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function removeManagedInstallation(
  targetPath,
  label,
  { artifact, replaceSources = [] },
) {
  try {
    if (!(await assertReplaceable(targetPath, artifact, replaceSources))) return false;
  } catch (error) {
    if (!(error instanceof UnmanagedInstallPathError)) throw error;
    console.warn(`${label} at ${targetPath} is user-managed; leaving it unchanged.`);
    return false;
  }

  await rm(targetPath, { recursive: true, force: true });
  console.log(`${label} removed from ${targetPath}`);
  return true;
}
