export function releaseTag(tag: string) {
  if (
    tag !== tag.trim() ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc(0|[1-9]\d*))?$/.test(tag)
  )
    throw new Error("Expected a vX.Y.Z or vX.Y.Z-rcN release tag");
  return { tag, version: tag.slice(1), prerelease: tag.includes("-rc") };
}
export function verifyReleaseVersions(tag: string, versions: string[]) {
  const release = releaseTag(tag);
  if (
    versions.length !== 3 ||
    versions.some((version) => version !== release.version)
  )
    throw new Error(
      "Release tag and package.json, Cargo.toml, tauri.conf.json versions must match",
    );
  return release;
}
export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  browser_download_url: string;
}
export function updaterAssets(version: string) {
  return [
    { target: "windows-x86_64", name: `LingoSofa_${version}_windows_x64.exe` },
    {
      target: "darwin-aarch64",
      name: `LingoSofa_${version}_darwin_aarch64.app.tar.gz`,
    },
    {
      target: "darwin-x86_64",
      name: `LingoSofa_${version}_darwin_x64.app.tar.gz`,
    },
  ];
}
export function requiredAssets(version: string) {
  return [
    ...updaterAssets(version).flatMap((asset) => [
      asset.name,
      `${asset.name}.sig`,
    ]),
    `LingoSofa_${version}_darwin_aarch64.dmg`,
    `LingoSofa_${version}_darwin_x64.dmg`,
  ];
}
export function verifyReleaseAssets(
  repo: string,
  tag: string,
  assets: ReleaseAsset[],
) {
  const { version } = releaseTag(tag);
  for (const name of requiredAssets(version)) {
    const matches = assets.filter((asset) => asset.name === name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !asset ||
      asset.size <= 0 ||
      asset.state !== "uploaded" ||
      asset.browser_download_url !==
        `https://github.com/${repo}/releases/download/${tag}/${name}`
    )
      throw new Error(`Missing or invalid release asset: ${name}`);
  }
}
export function updaterManifest(
  repo: string,
  tag: string,
  assets: ReleaseAsset[],
  signatures: Record<string, string>,
  notes: string,
  date: string,
) {
  verifyReleaseAssets(repo, tag, assets);
  const { version } = releaseTag(tag);
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const { target, name } of updaterAssets(version)) {
    const signature = signatures[name]?.trim();
    if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
      throw new Error(`Invalid updater signature: ${name}`);
    const decoded = Buffer.from(signature, "base64").toString("utf8");
    const trusted = decoded
      .split("\n")
      .find((line) => line.startsWith("trusted comment:"));
    if (
      !decoded.startsWith("untrusted comment:") ||
      !trusted?.split(/\s+/).includes(`version:${version}`)
    )
      throw new Error(
        `Updater signature is not bound to version ${version}: ${name}`,
      );
    platforms[target] = {
      signature,
      url: assets.find((asset) => asset.name === name)!.browser_download_url,
    };
  }
  if (!Number.isFinite(Date.parse(date)))
    throw new Error("Invalid release date");
  return { version, notes, pub_date: date, platforms };
}

export function verifyReleaseDraft(
  release: {
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
  },
  id: number,
  tag: string,
) {
  const { prerelease } = releaseTag(tag);
  if (
    !Number.isSafeInteger(id) ||
    release.id !== id ||
    !release.draft ||
    release.tag_name !== tag ||
    release.prerelease !== prerelease
  )
    throw new Error("Only the matching draft release may be published");
}
