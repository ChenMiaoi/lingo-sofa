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
    `# LingoSofa ${tag}\n\nTag: ${tag} · Commit: ${revision}\n\n## Browser setup\n\n- Existing local assistant installations can authorize a browser using a platform-specific terminal command copied from extension settings, with the current extension ID included. Accounts and usage are preserved. Older assistants without the authorization entry need a one-time upgrade.\n- Only users without an assistant need to download it. Enable browser developer mode and drag the browser ZIP onto the extensions page.\n\n## Downloads\n\n- Windows x64: LingoSofa-Setup-${version}-win32-x64.exe (prebuilt Vencord with LingoSofa and the local assistant; no compilation required).\n- Browser: lingo-sofa-browser-${version}.zip (Chrome/Edge MV3; enable developer mode and drag the ZIP onto the extensions page).\n- Discord: lingo-sofa-vencord-${version}.tar.gz (userplugin source for a custom Vencord build, not an official Discord plugin or Vencord installer).\n- Local assistant: choose lingo-sofa-assistant-${version}-<platform>-<arch>.tar.gz for your OS/CPU. Node 24 is included.\n- INSTALLATION.md: first installation, browser authorization and shared-service instructions.\n- SHA256SUMS: verify all downloaded files; assistant-release.json pins every native archive for Discord automatic installation.\n\n## Current distribution status\n\nThese are unsigned development packages, not notarized graphical installers. Platform CI smoke tests do not replace full client acceptance. See docs/release-readiness.md and docs/dependency-license-review.md in the source archive for outstanding acceptance and license-delivery items. The Windows combined installer includes its pinned Vencord host, corresponding source and licenses; the separate userplugin archive does not.\n\n## Source\n\nlingo-sofa-source-${version}.tar.gz corresponds exactly to ${revision}.\n`,
  );
  await writeReleaseChecksums(output);
  console.log(
    `Assembled ${tag} with ${releasePlatforms.length} verified native archives in ${output}`,
  );
}
