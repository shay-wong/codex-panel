export function releaseMetadata(packageVersion, releaseTag, architectures) {
  if (!/^\d+\.\d+\.\d+-fork\.[1-9]\d*$/.test(packageVersion)
    || releaseTag !== `v${packageVersion}`) {
    throw new Error("Release tag must match the X.Y.Z-fork.N package version");
  }
  const supported = [...new Set(architectures)].sort();
  if (!supported.length || supported.some((arch) => !["arm64", "x86_64"].includes(arch))) {
    throw new Error("Unsupported macOS updater architecture");
  }
  const arch = supported.length === 2 ? "universal" : supported[0] === "arm64" ? "aarch64" : "x86_64";
  const prefix = `Codex.Panel_${packageVersion}_${arch}`;
  const archive = `${prefix}.app.tar.gz`;
  return {
    version: packageVersion,
    archive,
    assetNames: [`${prefix}.dmg`, archive, `${archive}.sig`, "latest.json"],
    url: `https://github.com/shay-wong/codex-panel/releases/download/${releaseTag}/${archive}`,
    platforms: supported.flatMap((value) => {
      const target = `darwin-${value === "arm64" ? "aarch64" : "x86_64"}`;
      return [target, `${target}-app`];
    }),
  };
}
