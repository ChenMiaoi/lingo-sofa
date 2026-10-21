import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  releaseTag,
  updaterManifest,
  updaterAssets,
  verifyReleaseAssets,
  verifyReleaseDraft,
  type ReleaseAsset,
} from "./release-policy";

async function gh(args: string[]) {
  const result = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(result.stdout).text();
  if (await result.exited) throw new Error("GitHub release operation failed");
  return output;
}
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
  throw new Error("Missing GitHub repository");
const { tag, version, prerelease } = releaseTag(
  process.env.GITHUB_REF_NAME ?? "",
);
const releaseId = process.env.RELEASE_ID ?? "";
if (!/^[1-9]\d*$/.test(releaseId))
  throw new Error("Missing numeric draft release ID");
const release = JSON.parse(
  await gh(["api", `repos/${repo}/releases/${releaseId}`]),
) as {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
  assets: ReleaseAsset[];
};
verifyReleaseDraft(release, Number(releaseId), tag);
verifyReleaseAssets(repo, tag, release.assets);
const signatures: Record<string, string> = {};
for (const asset of updaterAssets(version)) {
  const signature = release.assets.find(
    (candidate) => candidate.name === `${asset.name}.sig`,
  )!;
  signatures[asset.name] = await gh([
    "api",
    `repos/${repo}/releases/assets/${signature.id}`,
    "-H",
    "Accept: application/octet-stream",
  ]);
}
const manifest = updaterManifest(
  repo,
  tag,
  release.assets,
  signatures,
  release.body ?? "",
  new Date().toISOString(),
);
const directory = resolve(import.meta.dirname, "../.cache/release");
await mkdir(directory, { recursive: true });
const file = resolve(directory, "latest.json");
await Bun.write(file, JSON.stringify(manifest, null, 2) + "\n");
await gh(["release", "upload", tag, file, "--repo", repo, "--clobber"]);
await gh([
  "api",
  "--method",
  "PATCH",
  `repos/${repo}/releases/${release.id}`,
  "-F",
  "draft=false",
  "-F",
  `prerelease=${prerelease}`,
  "-f",
  `make_latest=${prerelease ? "false" : "legacy"}`,
]);
console.log(`Published ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
