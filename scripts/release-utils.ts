import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateAsset,
  type AssistantRelease,
} from "@lingo-sofa/local-runtime/release";

export const releasePlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;
export function versionFromTag(tag: string): string {
  if (
    tag.match(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)?.[0] !== tag
  )
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH, for example v0.1.0",
    );
  return tag.slice(1);
}
export function validateReleaseSourceFiles(files: readonly string[]): void {
  for (const path of files) {
    const name = path.split(/[\\/]/).at(-1)!;
    if (
      (/^\.env(?:\..*)?$/.test(name) && name !== ".env.example") ||
      /^(?:(?:provider|accounts|pairing|discord-connection|runtime-connection|runtime-install)\.json|\.provider-.*\.json)$/i.test(
        name,
      )
    )
      throw new Error(
        `Local credential or runtime file cannot enter a source release: ${path}`,
      );
  }
}
export async function validateReleaseVersion(
  root: string,
  tag: string,
): Promise<string> {
  const version = versionFromTag(tag);
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, group), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const path = join(group, entry.name, "package.json");
      const pkg = JSON.parse(await readFile(join(root, path), "utf8")) as {
        version: string;
      };
      if (pkg.version !== version)
        throw new Error(`${path} version ${pkg.version} does not match ${tag}`);
    }
  }
  return version;
}
/** A plugin must pin the exact archives uploaded by all successful native jobs. */
export async function collectAssistantRelease(
  input: string,
  output: string,
  version: string,
): Promise<AssistantRelease> {
  const release: AssistantRelease = { version, assets: {} };
  // Validate the entire set before copying anything into the final release directory.
  const expected = new Set<string>();
  for (const target of releasePlatforms) {
    const name = `lingo-sofa-assistant-${version}-${target}`;
    expected.add(`${name}.json`);
    expected.add(`${name}.tar.gz`);
    const manifest = JSON.parse(
      await readFile(join(input, `${name}.json`), "utf8"),
    ) as AssistantRelease;
    if (
      manifest.version !== version ||
      Object.keys(manifest.assets).length !== 1 ||
      !manifest.assets[target]
    )
      throw new Error(`Invalid platform release manifest: ${target}`);
    const [platform, arch] = target.split("-");
    const asset = validateAsset(manifest, platform!, arch!);
    const digest = createHash("sha256")
      .update(await readFile(join(input, `${name}.tar.gz`)))
      .digest("hex");
    if (digest !== asset.sha256)
      throw new Error(`Assistant checksum mismatch: ${target}`);
    release.assets[target] = asset;
  }
  for (const entry of await readdir(input, { withFileTypes: true }))
    if (!entry.isFile() || !expected.has(entry.name))
      throw new Error(`Unexpected native release artifact: ${entry.name}`);
  await mkdir(output, { recursive: true });
  for (const target of releasePlatforms) {
    const archive = `lingo-sofa-assistant-${version}-${target}.tar.gz`;
    await cp(join(input, archive), join(output, archive));
  }
  await writeFile(
    join(output, "assistant-release.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  return release;
}
export async function writeReleaseChecksums(output: string): Promise<void> {
  const checksums: string[] = [];
  for (const entry of (await readdir(output, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (entry.name === "SHA256SUMS") continue;
    if (!entry.isFile() || !/^[\w.-]+$/.test(entry.name))
      throw new Error(`Unexpected release file: ${entry.name}`);
    const digest = createHash("sha256")
      .update(await readFile(join(output, entry.name)))
      .digest("hex");
    checksums.push(`${digest}  ${entry.name}`);
  }
  if (!checksums.length) throw new Error("Empty release directory");
  await writeFile(join(output, "SHA256SUMS"), checksums.join("\n") + "\n");
}
