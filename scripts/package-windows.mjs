import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { validateAsset } from "../packages/local-runtime/src/release.ts";
import { validateArchiveListing } from "../packages/local-runtime/src/installer.ts";
import { writeReleaseChecksums } from "./release-utils.ts";
import { verifyBundle } from "./windows/install.ts";
import { ensureInno } from "./ensure-inno.mjs";
import { createStageTimer } from "./stage-timer.mjs";

const timing = createStageTimer("package-windows");
timing.start("prepare payload staging");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Build the Windows installer on Windows x64");
const root = resolve(import.meta.dirname, "..");
const input = resolve(process.argv[2] ?? ".cache/release-assets");
const output = resolve(process.argv[3] ?? ".cache/windows-release");
const version = JSON.parse(
  await readFile(join(root, "apps/discord-vencord/package.json"), "utf8"),
).version;
const release = JSON.parse(
  await readFile(join(input, "assistant-release.json"), "utf8"),
);
if (release.version !== version)
  throw new Error("Windows/assistant version mismatch");
const asset = validateAsset(release, "win32", "x64");
const work = join(root, ".cache", `windows-package-${version}`);
await mkdir(work, { recursive: true });
const payload = join(work, "payload");
if (!payload.startsWith(join(root, ".cache") + "\\"))
  throw new Error(
    "Windows staging directory must remain inside the project cache",
  );
// Only this fixed staging directory is removed; installed copies are never touched.
await rm(payload, { recursive: true, force: true });
await mkdir(payload);
await mkdir(output, { recursive: true });
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
timing.start("validate assistant archive checksum and paths");
const assistantArchive = join(input, `${asset.directory}.tar.gz`);
if (
  createHash("sha256")
    .update(await readFile(assistantArchive))
    .digest("hex") !== asset.sha256
)
  throw new Error("Windows assistant checksum mismatch");
validateArchiveListing(
  execFileSync("tar", ["-tzf", assistantArchive], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
  asset.directory,
);
const archiveTypes = execFileSync("tar", ["-tvzf", assistantArchive], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (
  archiveTypes
    .trim()
    .split(/\r?\n/)
    .some((line) => !/^[d-]/.test(line))
)
  throw new Error(
    "Links and special files are forbidden in assistant archives",
  );
timing.start("extract assistant archive");
run("tar", ["-xzf", assistantArchive, "-C", payload]);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Use npm run package:windows");
timing.start("build and verify managed Vencord");
run(process.execPath, [npm, "run", "verify:vencord"], {
  env: {
    ...process.env,
    LINGO_SOFA_RELEASE_MANIFEST: join(input, "assistant-release.json"),
    LINGO_SOFA_MANAGED_WINDOWS: "1",
  },
});
timing.start("copy Vencord payload");
await mkdir(join(payload, "vencord"));
// Vencord emits CommonJS .js files. Isolate them from the ESM bootstrap at the bundle root.
await writeFile(
  join(payload, "vencord/package.json"),
  '{"type":"commonjs","private":true}\n',
);
await cp(join(root, ".cache/vencord/dist"), join(payload, "vencord/dist"), {
  recursive: true,
});

// Build the unmodified upstream CLI from an immutable source revision.
timing.start("checkout upstream installer");
const installerRevision = "595991ca27520868af4f9c48adf0c53ee971f1f2";
const checkout = join(root, ".cache/installer-upstream");
try {
  await readFile(join(checkout, "go.mod"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  run("git", ["clone", "https://github.com/Vencord/Installer.git", checkout]);
}
run("git", ["-C", checkout, "checkout", "--detach", installerRevision]);
if (
  execFileSync("git", ["-C", checkout, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim()
)
  throw new Error("Installer source must be clean");
timing.start("compile upstream Go installer");
run(
  "go",
  [
    "build",
    "-trimpath",
    "-tags",
    "cli",
    "-o",
    join(payload, "VencordInstallerCli.exe"),
    ".",
  ],
  {
    cwd: checkout,
    env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  },
);
timing.start("bundle setup helper and archive sources");
await build({
  entryPoints: [join(root, "scripts/windows/setup.mjs")],
  outfile: join(payload, "install.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
await writeFile(
  join(payload, "package.json"),
  '{"type":"module","private":true}\n',
);
await mkdir(join(payload, "sources"));
for (const [directory, name] of [
  [".cache/vencord", "vencord"],
  [".cache/installer-upstream", "vencord-installer"],
]) {
  run("git", [
    "-C",
    join(root, directory),
    "archive",
    "--format=tar.gz",
    "-o",
    join(payload, "sources", `${name}.tar.gz`),
    "HEAD",
  ]);
  await cp(join(root, directory, "LICENSE"), join(payload, `${name}-LICENSE`));
}
await cp(
  join(input, `lingo-sofa-source-${version}.tar.gz`),
  join(payload, "sources/lingo-sofa.tar.gz"),
);
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "INSTALLATION.md"])
  await cp(join(input, name), join(payload, name));
const files = {};
async function inventory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      await inventory(join(directory, entry.name), path + "/");
    else if (entry.isFile())
      files[path] = createHash("sha256")
        .update(await readFile(join(directory, entry.name)))
        .digest("hex");
    else throw new Error("Special file in Windows payload");
  }
}
timing.start("hash payload files");
await inventory(payload);
console.log(
  `[timing] package-windows: payload files=${Object.keys(files).length}`,
);
await writeFile(
  join(payload, "windows-bundle.json"),
  JSON.stringify(
    {
      version,
      platform: "win32-x64",
      assistantDirectory: asset.directory,
      files,
    },
    null,
    2,
  ) + "\n",
);
timing.start("verify payload integrity");
await verifyBundle(payload);
timing.start("verify direct installation and reinstallation");
run(process.execPath, [
  "--import",
  "tsx",
  join(root, "scripts/verify-windows.mjs"),
  payload,
]);
timing.start("prepare Inno Setup compiler");
const iscc = await ensureInno(root);
timing.start("compile and compress Inno Setup EXE");
run(iscc, [
  "/Q",
  `/DBundleDir=${payload}`,
  `/DReleaseVersion=${version}`,
  `/DAssistantDirectory=${asset.directory}`,
  `/O${output}`,
  join(root, "scripts/windows/setup.iss"),
]);
timing.start("verify EXE success and failure paths");
const name = `LingoSofa-Setup-${version}-win32-x64.exe`;
run(process.execPath, [
  "--import",
  "tsx",
  join(root, "scripts/verify-windows.mjs"),
  payload,
  join(output, name),
]);
timing.start("hash EXE and write release metadata");
const sha256 = createHash("sha256")
  .update(await readFile(join(output, name)))
  .digest("hex");
await writeFile(
  join(output, "windows-release.json"),
  JSON.stringify(
    {
      version,
      url: `https://github.com/ChenMiaoi/lingo-sofa/releases/download/v${version}/${name}`,
      sha256,
      vencordRevision: "16ec4ea838899706019e7f472e45f055070abeb1",
      installerRevision,
    },
    null,
    2,
  ) + "\n",
);
timing.start("run installation and update regression tests");
// Exercise the actual packaged installer helpers against a fixture, never the real Discord.
run(process.execPath, [
  npm,
  "test",
  "--",
  "tests/windows-install.test.ts",
  "tests/updates.test.ts",
]);
console.log(`Windows installer: ${join(output, name)}`);
timing.start("write final release checksums");
await writeReleaseChecksums(output);
timing.finish();
