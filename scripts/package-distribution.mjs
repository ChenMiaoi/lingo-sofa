import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  await readFile(join(root, "apps/pi-bridge/package.json"), "utf8"),
).version;
const output = resolve(
  process.argv[2] ??
    join(
      root,
      ".cache/distribution",
      version,
      `${process.platform}-${process.arch}`,
    ),
);
await mkdir(output, { recursive: true });
// npm's installation location is not guaranteed to be in this repository.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run via npm run package:distribution");
const task = (script, workspace, env = {}) =>
  execFileSync(
    process.execPath,
    [npm, "run", script, "--workspace", workspace],
    { cwd: root, stdio: "inherit", env: { ...process.env, ...env } },
  );
task("build", "@lingo-sofa/pi-bridge");
task("package:native", "@lingo-sofa/pi-bridge");
execFileSync(
  process.execPath,
  [join(root, "apps/pi-bridge/package-assistant.mjs"), output],
  { cwd: root, stdio: "inherit" },
);
const name = `lingo-sofa-assistant-${version}-${process.platform}-${process.arch}`;
execFileSync(
  process.execPath,
  [join(root, "scripts/verify-assistant.mjs"), join(output, `${name}.tar.gz`)],
  { cwd: root, stdio: "inherit" },
);
const manifest = JSON.parse(
  await readFile(join(output, `${name}.json`), "utf8"),
);
for (const path of process.argv.slice(3)) {
  const other = JSON.parse(await readFile(resolve(path), "utf8"));
  if (other.version !== version)
    throw new Error("Release manifest versions must match");
  for (const [key, asset] of Object.entries(other.assets)) {
    if (
      manifest.assets[key] &&
      JSON.stringify(manifest.assets[key]) !== JSON.stringify(asset)
    )
      throw new Error(`Conflicting asset: ${key}`);
    manifest.assets[key] = asset;
  }
}
const release = join(output, "assistant-release.json");
await writeFile(release, JSON.stringify(manifest, null, 2) + "\n");
task("build", "@lingo-sofa/discord-vencord", {
  LINGO_SOFA_RELEASE_MANIFEST: release,
});
execFileSync("tar", [
  "-czf",
  join(output, `lingo-sofa-vencord-${version}.tar.gz`),
  "-C",
  join(root, "apps/discord-vencord/dist"),
  "lingoSofa",
]);
task("zip", "@lingo-sofa/browser-extension");
const browserOutput = join(root, "apps/browser-extension/.output");
const zips = (await readdir(browserOutput)).filter((name) =>
  name.endsWith(`-${version}-chrome.zip`),
);
if (zips.length !== 1)
  throw new Error("Expected exactly one versioned Chrome ZIP");
await cp(
  join(browserOutput, zips[0]),
  join(output, `lingo-sofa-browser-${version}.zip`),
);
await cp(join(root, "docs/installation.md"), join(output, "INSTALLATION.md"));
await writeFile(
  join(output, "distribution-review.json"),
  JSON.stringify(
    {
      version,
      publicReleaseReady: false,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: Boolean(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ),
      gates: [
        "Publish versioned assistant assets before enabling Discord automatic downloads",
        "Signing/notarization and per-platform installation acceptance",
        "Third-party license delivery; see docs/dependency-license-review.md",
        "Vencord userplugin requires a custom host build",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Local distribution candidate: ${output}`);
