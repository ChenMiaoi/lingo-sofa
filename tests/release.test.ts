import { expect, test } from "bun:test";
import {
  releaseTag,
  verifyReleaseDraft,
  verifyReleaseVersions,
  requiredAssets,
  updaterAssets,
  updaterManifest,
  verifyReleaseAssets,
  type ReleaseAsset,
} from "../scripts/release-policy";

const repo = "example/lingo-sofa";
function assets(tag: string): ReleaseAsset[] {
  return requiredAssets(releaseTag(tag).version).map((name, index) => ({
    id: index + 1,
    name,
    size: 100,
    state: "uploaded",
    browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
  }));
}
function signatures(version: string) {
  return Object.fromEntries(
    updaterAssets(version).map((asset) => [
      asset.name,
      Buffer.from(
        `untrusted comment: fixture\nsignature\ntrusted comment: timestamp:0\tversion:${version}\nfixture\n`,
      ).toString("base64"),
    ]),
  );
}
test("release policy accepts stable and RC tags, rejects malformed and mismatched versions", () => {
  expect(
    verifyReleaseVersions("v0.1.1", ["0.1.1", "0.1.1", "0.1.1"]).prerelease,
  ).toBe(false);
  expect(
    verifyReleaseVersions("v1.2.3-rc2", ["1.2.3-rc2", "1.2.3-rc2", "1.2.3-rc2"])
      .prerelease,
  ).toBe(true);
  for (const tag of [
    "main",
    "1.2.3",
    "v1.2",
    "v01.2.3",
    "v1.2.3-rc",
    "v1.2.3-rc01",
    "v1.2.3-beta1",
    "v1.2.3+build",
    "v1.2.3\n",
  ])
    expect(() => releaseTag(tag)).toThrow();
  expect(() =>
    verifyReleaseVersions("v1.2.3-rc1", ["1.2.3", "1.2.3", "1.2.3"]),
  ).toThrow();
  expect(() =>
    verifyReleaseVersions("v1.2.3", ["1.2.3", "1.2.3", "1.2.2"]),
  ).toThrow();
});
test("publication requires all uploaded installers and version-bound updater signatures", () => {
  const tag = "v1.2.3-rc1";
  const version = "1.2.3-rc1";
  const files = assets(tag);
  const sigs = signatures(version);
  const manifest = updaterManifest(
    repo,
    tag,
    files,
    sigs,
    "Release notes",
    "2026-10-21T00:00:00Z",
  );
  expect(manifest.version).toBe(version);
  expect(Object.keys(manifest.platforms)).toEqual([
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
  ]);
  expect(manifest.platforms["darwin-aarch64"]?.url).toContain(
    `/releases/download/${tag}/`,
  );
  for (let i = 0; i < files.length; i++) {
    expect(() =>
      verifyReleaseAssets(
        repo,
        tag,
        files.filter((_, index) => index !== i),
      ),
    ).toThrow();
    expect(() =>
      verifyReleaseAssets(
        repo,
        tag,
        files.map((file, index) => (index === i ? { ...file, size: 0 } : file)),
      ),
    ).toThrow();
  }
  expect(() => verifyReleaseAssets(repo, tag, [...files, files[0]!])).toThrow();
  expect(() =>
    verifyReleaseAssets(
      repo,
      tag,
      files.map((file) => ({
        ...file,
        browser_download_url: file.browser_download_url.replace(
          repo,
          "other/repo",
        ),
      })),
    ),
  ).toThrow();
  const first = updaterAssets(version)[0]!.name;
  expect(() =>
    updaterManifest(
      repo,
      tag,
      files,
      { ...sigs, [first]: "" },
      "",
      manifest.pub_date,
    ),
  ).toThrow();
  expect(() =>
    updaterManifest(
      repo,
      tag,
      files,
      {
        ...sigs,
        [first]: signatures("1.2.2")[updaterAssets("1.2.2")[0]!.name]!,
      },
      "",
      manifest.pub_date,
    ),
  ).toThrow();
});

test("publication identifies drafts by ID and refuses published or mismatched releases", () => {
  const draft = {
    id: 123,
    tag_name: "v1.2.3-rc1",
    draft: true,
    prerelease: true,
  };
  expect(() => verifyReleaseDraft(draft, 123, draft.tag_name)).not.toThrow();
  expect(() => verifyReleaseDraft(draft, 124, draft.tag_name)).toThrow();
  expect(() =>
    verifyReleaseDraft({ ...draft, draft: false }, 123, draft.tag_name),
  ).toThrow();
  expect(() =>
    verifyReleaseDraft({ ...draft, prerelease: false }, 123, draft.tag_name),
  ).toThrow();
  expect(() => verifyReleaseDraft(draft, 123, "v1.2.3-rc2")).toThrow();
});
