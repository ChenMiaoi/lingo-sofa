import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  collectAssistantRelease,
  releasePlatforms,
  validateReleaseVersion,
  validateReleaseSourceFiles,
  writeReleaseChecksums,
} from "./release-utils.ts";

const root = resolve(import.meta.dirname, "..");
const [command, tag, inputArgument, outputArgument] = process.argv.slice(2);
if (!["validate", "assemble"].includes(command) || !tag)
  throw new Error(
    "Usage: node scripts/release.mjs validate|assemble TAG [INPUT OUTPUT]",
  );
const version = await validateReleaseVersion(root, tag);
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=${tag}\n`,
  );
if (
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_REPOSITORY !== "ChenMiaoi/lingo-sofa"
)
  throw new Error(
    "Update the pinned assistant release URLs before publishing from a different repository",
  );
if (command === "validate") {
  console.log(
    `Validated ${tag}: all application and shared-package versions match`,
  );
} else {
  if (!inputArgument || !outputArgument)
    throw new Error("Pass native input and release output directories");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const taggedRevision = execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (revision !== taggedRevision)
    throw new Error("Release checkout does not match the tag");
  if (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  )
    throw new Error("Release source checkout must be clean");
  validateReleaseSourceFiles(
    execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
  );
  const input = resolve(inputArgument);
  const output = resolve(outputArgument);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error("Use an empty release output directory");
  await collectAssistantRelease(input, output, version);
  const manifest = join(output, "assistant-release.json");
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run assembly through npm run release:assemble");
  const task = (script, workspace) =>
    execFileSync(
      process.execPath,
      [npm, "run", script, "--workspace", workspace],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, LINGO_SOFA_RELEASE_MANIFEST: manifest },
      },
    );
  task("build", "@lingo-sofa/discord-vencord");
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
  if (zips.length !== 1) throw new Error("Expected one Chrome release ZIP");
  await cp(
    join(browserOutput, zips[0]),
    join(output, `lingo-sofa-browser-${version}.zip`),
  );
  await cp(join(root, "docs/installation.md"), join(output, "INSTALLATION.md"));
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await cp(join(root, file), join(output, file));
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar.gz",
      "--output",
      join(output, `lingo-sofa-source-${version}.tar.gz`),
      taggedRevision,
    ],
    { cwd: root },
  );
  await writeFile(
    join(output, "release.json"),
    JSON.stringify(
      { tag, version, revision, platforms: releasePlatforms, signed: false },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(output, "RELEASE-NOTES.md"),
    `# LingoSofa ${tag}

Tag: ${tag} · Commit: ${revision}

## Highlights

- Browser and Discord now share one model account store in the local assistant. Model credentials, translation and Ask defaults, and balance queries use that store; changing an account in either client takes effect in both.
- Existing browser accounts can be migrated from connection settings. The assistant preserves existing accounts, deduplicates matching credentials, and saves migration receipts atomically. Browser keys are removed only after acknowledgement; a failed or interrupted migration keeps the data for retry without overwriting later shared choices.
- Bing and Google remain usable without a model key or local assistant. Model configuration failures do not block free-engine selection. Saving local preferences in keyless mode preserves an in-flight shared Ask request.
- Updating or reinstalling the extension recovers already-open pages without requiring a refresh. Interrupted model requests wait for a new user action; they are never replayed automatically.
- The assistant recovers when its saved port is occupied or reserved by Windows. Browser and Discord still share one service, with startup, cancellation, reconnection and shutdown checks.
- Large-page reading releases idle translation sessions instead of stopping after many page changes. Model discovery preserves cache identity, and early paragraph/Ask actions wait for reading settings instead of being silently dropped. Authentication failures show a safe 401 explanation.

## Upgrading

**Model accounts now require the local assistant. Update the browser extension and assistant together.** Independent direct-browser model access has been removed; keyless translation remains standalone. Windows users can use the combined installer to update Vencord, LingoSofa and the assistant. Custom Vencord users should rebuild with the new userplugin.

Keep the existing extension entry and its data. After updating both components, open Settings → Connection and click “迁移浏览器账户并共用” to migrate old browser accounts. Existing assistant accounts are retained; configured browser translation/Ask defaults become the shared defaults. The browser clears its old keys only after the assistant confirms persistence. If migration fails, update/connect the assistant and retry. Leaving a saved key input empty preserves its value.

The extension ID remains ahbkbjlbljldmlgkdppdkeeemlajjhgh. For unpacked updates, replace files in the existing directory and reload the same extension entry. **Do not uninstall the old extension before migration:** uninstalling removes browser-local data.

**One-time browser identity migration:** extensions older than v0.1.11 may use a directory-based ID. Moving to the stable ID creates a different storage boundary; the new extension cannot read the old ID's accounts, permissions or reading preferences automatically. Keep the old extension and its data until migration is complete. Shared assistant accounts, keys and usage remain in place. See INSTALLATION.md for storage locations and identity-migration guidance.

Engine or account failures do not automatically switch providers or resend paid model requests. Existing usage and unknown records are retained. Automated checks use isolated browser profiles, private assistant directories and synthetic credentials; they do not prove that a particular real provider key is valid or replace acceptance in the installed Chrome, Edge or Discord client. Keyless engines remain subject to service availability and rate limits.

## Downloads

- Windows x64: LingoSofa-Setup-${version}-win32-x64.exe (prebuilt Vencord with LingoSofa and the local assistant; no compilation required).
- Browser: lingo-sofa-browser-${version}.zip (Chrome/Edge MV3; update the existing unpacked extension entry).
- Discord: lingo-sofa-vencord-${version}.tar.gz (userplugin source for a custom Vencord build, not an official Discord plugin or Vencord installer).
- Local assistant: choose lingo-sofa-assistant-${version}-<platform>-<arch>.tar.gz for your OS/CPU. Node 24 is included.
- INSTALLATION.md: first installation, account migration, browser authorization and shared-service instructions.
- SHA256SUMS: verify downloaded files; assistant-release.json pins all five native assistant archives.

## Current distribution status

These are unsigned development packages, not notarized graphical installers. Platform CI smoke tests do not replace full client acceptance. See docs/release-readiness.md and docs/dependency-license-review.md in the source archive for outstanding acceptance and license-delivery items. The Windows combined installer includes its pinned Vencord host, corresponding source and licenses; the separate userplugin archive does not.

## Source

lingo-sofa-source-${version}.tar.gz corresponds exactly to ${revision}.
`,
  );
  await writeReleaseChecksums(output);
  console.log(
    `Assembled ${tag} with ${releasePlatforms.length} verified native archives in ${output}`,
  );
}
