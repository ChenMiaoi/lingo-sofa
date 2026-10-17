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
    `# LingoSofa ${tag}\n\nTag: ${tag} · Commit: ${revision}\n\n## Highlights\n\n- Browser reading and the floating launcher return on authorized websites after browser restart. Persistent site access can be granted from the toolbar; automatic translation remains a separate per-site choice.\n- Whole-page bilingual reading has cleaner paragraph spacing, heading hierarchy, lists and tables, with natural wrapping in narrow columns. Batch usage and charges stay available in hover details and usage views without repeating below every paragraph.\n- Settings open on translation preferences and support searching, locating and highlighting individual options. Connection selection, save feedback, permission guidance and narrow layouts are clearer.\n- The glossary supports search, validated JSON/TSV import and draft export. Open settings pages stay synchronized; conflicting changes preserve the local draft and prevent overwriting newer terms.\n- Usage refreshes pause in hidden settings pages, request history is filtered and paginated in the background, and data cleanup reports each source separately with targeted retries.\n- Concurrent settings, website rules, floating preferences and cache edits no longer overwrite unrelated changes. Late startup snapshots are ignored and failed preference edits return to their saved values.\n- With persistent usage enabled, unfinished requests survive browser closure as unknown usage. Preference migrations retain the request journal and ledger; recovery never automatically resends a model request.\n\n## Upgrading\n\nUpdate the browser extension and local assistant together. Windows users can use the combined installer to update Vencord, LingoSofa and the assistant; custom Vencord users should rebuild with the new userplugin. Accounts, selected engines and retained usage are preserved. Fresh browser installations can translate directly without installing the assistant. Sharing engine/account settings with Discord requires the local assistant.\n\nPreviously authorized websites and automatic translation choices remain in place. For a website started with temporary access, allow persistent site access from the toolbar or reading settings so its launcher can return after browser restart. Turning automatic translation on still requires an explicit choice.\n\nState recovery and concurrent settings changes are covered by automated MV3 browser regressions using isolated profiles and local fixtures. These checks do not replace manual acceptance in an installed Chrome, Edge or Discord client. Keyless engines remain subject to service availability and rate limits; failures do not automatically switch providers or send a paid model request.\n\n## Downloads\n\n- Windows x64: LingoSofa-Setup-${version}-win32-x64.exe (prebuilt Vencord with LingoSofa and the local assistant; no compilation required).\n- Browser: lingo-sofa-browser-${version}.zip (Chrome/Edge MV3; enable developer mode and drag the ZIP onto the extensions page).\n- Discord: lingo-sofa-vencord-${version}.tar.gz (userplugin source for a custom Vencord build, not an official Discord plugin or Vencord installer).\n- Local assistant: choose lingo-sofa-assistant-${version}-<platform>-<arch>.tar.gz for your OS/CPU. Node 24 is included.\n- INSTALLATION.md: first installation, browser authorization and shared-service instructions.\n- SHA256SUMS: verify all downloaded files; assistant-release.json pins every native archive for Discord automatic installation.\n\n## Current distribution status\n\nThese are unsigned development packages, not notarized graphical installers. Platform CI smoke tests do not replace full client acceptance. See docs/release-readiness.md and docs/dependency-license-review.md in the source archive for outstanding acceptance and license-delivery items. The Windows combined installer includes its pinned Vencord host, corresponding source and licenses; the separate userplugin archive does not.\n\n## Source\n\nlingo-sofa-source-${version}.tar.gz corresponds exactly to ${revision}.\n`,
  );
  await writeReleaseChecksums(output);
  console.log(
    `Assembled ${tag} with ${releasePlatforms.length} verified native archives in ${output}`,
  );
}
