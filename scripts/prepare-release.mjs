import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  cp,
  copyFile,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";

// This is an allowlisted local review bundle, not a publishing command.
const root = resolve(import.meta.dirname, "..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw new Error("Commit reviewed changes before preparing a release bundle");
const tracked = git("ls-files").split("\n");
if (
  tracked.some(
    (path) =>
      /(?:^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith(".env.example"),
  )
)
  throw new Error(
    "Tracked environment credential file cannot enter source archive",
  );
const revision = git("rev-parse", "HEAD");
const browserPackage = JSON.parse(
  await readFile(join(root, "apps/browser-extension/package.json"), "utf8"),
);
const version = browserPackage.version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Expected a numeric release version");
for (const app of ["pi-bridge", "discord-vencord"])
  if (
    JSON.parse(await readFile(join(root, `apps/${app}/package.json`), "utf8"))
      .version !== version
  )
    throw new Error("Application versions must agree");
const parent = join(root, ".cache/releases");
await mkdir(parent, { recursive: true });
const name = `lingo-sofa-${version}-${process.platform}-${process.arch}-${revision.slice(0, 8)}`;
const temporary = await mkdtemp(join(parent, ".preparing-"));
try {
  const runtimeName = `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`;
  await cp(
    join(root, "apps/browser-extension/.output/chrome-mv3"),
    join(temporary, "browser"),
    { recursive: true },
  );
  await cp(
    join(root, "apps/discord-vencord/dist/lingoSofa"),
    join(temporary, "discord-plugin-local-review"),
    { recursive: true },
  );
  await mkdir(join(temporary, "native"));
  await copyFile(
    join(root, "apps/pi-bridge/dist", runtimeName),
    join(temporary, "native", runtimeName),
  );
  await cp(join(root, "docs"), join(temporary, "docs"), { recursive: true });
  for (const file of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "package-lock.json",
  ])
    await copyFile(join(root, file), join(temporary, file));
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      "--output",
      join(temporary, "source.tar"),
      revision,
    ],
    { cwd: root },
  );
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  const inventory = [];
  const issues = [];
  const overrides = JSON.parse(
    await readFile(join(root, "third-party/sources.json"), "utf8"),
  );
  const piLicense = await readFile(
    join(root, "third-party", overrides[0].file),
  );
  if (
    createHash("sha256").update(piLicense).digest("hex") !== overrides[0].sha256
  )
    throw new Error("Vendored Pi license checksum mismatch");
  for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!path.includes("node_modules/") || entry.dev || entry.link) continue;
    const directory = join(root, path);
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (reason) {
      if (entry.optional && reason.code === "ENOENT") continue;
      throw reason;
    }
    const destination = join(
      "licenses",
      `${pkg.name.replaceAll("/", "__")}@${pkg.version}`,
    );
    const documents = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (file) =>
          file.isFile() &&
          /^(licen[sc]e|notice|copying|copyright)([.-]|$)/i.test(file.name),
      )
      .map((file) => file.name)
      .sort();
    await mkdir(join(temporary, destination), { recursive: true });
    for (const document of documents)
      await copyFile(
        join(directory, document),
        join(temporary, destination, document),
      );
    let licenseSource = "installed package";
    if (
      !documents.length &&
      pkg.name.startsWith("@earendil-works/pi-") &&
      pkg.version === overrides[0].version
    ) {
      await writeFile(join(temporary, destination, "LICENSE"), piLicense);
      documents.push("LICENSE");
      licenseSource = overrides[0].sourceUrl;
    }
    if (!documents.length)
      issues.push(
        `${pkg.name}@${pkg.version}: package has no top-level license/NOTICE text; inspect upstream and embedded vendor files`,
      );
    inventory.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNSPECIFIED",
      lockPath: path,
      documents: documents.map((file) => `${destination}/${file}`),
      licenseSource,
    });
  }
  const nodeLicense = join(dirname(dirname(process.execPath)), "LICENSE");
  await mkdir(join(temporary, "licenses/Node.js"), { recursive: true });
  await copyFile(nodeLicense, join(temporary, "licenses/Node.js/LICENSE"));
  await copyFile(
    join(root, "third-party/sources.json"),
    join(temporary, "licenses/sources.json"),
  );
  await copyFile(
    join(root, ".cache/vencord/LICENSE"),
    join(temporary, "licenses/Vencord-GPL-3.0-or-later.txt"),
  );
  const manifest = JSON.parse(
    await readFile(join(temporary, "browser/manifest.json"), "utf8"),
  );
  if (manifest.version !== version || manifest.host_permissions?.length)
    throw new Error("Browser artifact version or permission mismatch");
  const report = {
    version,
    revision,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    preparedAt: new Date().toISOString(),
    publicReleaseReady: false,
    inventoryScope:
      "Conservative superset: all installed non-development lockfile packages, not a claim that every package is bundled",
    licenseIssues: issues,
    remainingGates: [
      "Windows/Edge and additional real-client coverage",
      "Screen-reader verification",
      "Resolve license inventory issues and inspect embedded vendor notices",
      "Legal decision for proprietary plugin plus GPL host before any combined distribution",
      "Store review and platform signing/notarization",
    ],
    packages: inventory,
  };
  await writeFile(
    join(temporary, "release-review.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    join(temporary, "REVIEW-README.md"),
    `# LingoSofa ${version} local release review\n\nThis bundle is not cleared for public distribution. See release-review.json and docs/release-readiness.md.\n\n- browser/: unpacked MV3 with optional site permissions.\n- native/: ${process.platform}/${process.arch} Native Host; a separate Node 24 Bridge must be configured and started from source. This is not a self-contained Bridge installer.\n- discord-plugin-local-review/: plugin build for an authorized local Vencord checkout; no Discord or Vencord binary is included.\n- source.tar: exactly Git revision ${revision}. Run npm ci and npm run check in the extracted source. No credentials or private test profiles are included.\n- licenses/: full installed license/NOTICE documents, pinned upstream Pi text, host GPL text, and the current Node runtime license. Missing text and vendor audits remain explicit gates.\n- SHA256SUMS: integrity values for every included file except this checksum file itself.\n\nNo signing, store submission, upload, or installation is performed.\n`,
  );
  const checksums = [];
  async function hashFiles(directory) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await hashFiles(path);
      else if (entry.isFile())
        checksums.push(
          `${createHash("sha256")
            .update(await readFile(path))
            .digest(
              "hex",
            )}  ${relative(temporary, path).replaceAll("\\", "/")}`,
        );
      else
        throw new Error(
          "Symlinks or special files are not permitted in review bundles",
        );
    }
  }
  await hashFiles(temporary);
  await writeFile(join(temporary, "SHA256SUMS"), checksums.join("\n") + "\n");
  const destination = join(parent, name);
  await rename(temporary, destination);
  console.log(
    `Local review bundle: ${destination}\nLicense inventory: ${inventory.length} packages; ${issues.length} unresolved text entries. Public release gates remain open.`,
  );
} catch (reason) {
  await rm(temporary, { recursive: true, force: true });
  throw reason;
}
