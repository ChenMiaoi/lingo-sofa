import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Provide the local release review directory");
const entries = (await readFile(join(root, "SHA256SUMS"), "utf8"))
  .trim()
  .split("\n");
const expected = new Set();
for (const entry of entries) {
  const match = entry.match(/^([0-9a-f]{64}) {2}(.+)$/);
  if (
    !match ||
    match[2].startsWith("/") ||
    match[2].split(/[\\/]/).includes("..") ||
    expected.has(match[2])
  )
    throw new Error("Invalid or duplicate checksum path");
  expected.add(match[2]);
  const digest = createHash("sha256")
    .update(await readFile(join(root, match[2])))
    .digest("hex");
  if (digest !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
}
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (!entry.isFile())
      throw new Error("Unexpected symlink or special file");
    else {
      const name = relative(root, path).replaceAll("\\", "/");
      if (name !== "SHA256SUMS" && !expected.has(name))
        throw new Error(`Unlisted file: ${name}`);
      if (
        /^(\.env(?:\..*)?|(?:provider|pairing|discord-connection)\.json|\.provider-.*\.json)$/i.test(
          entry.name,
        )
      )
        throw new Error("Credential file in review bundle");
    }
  }
}
await inspect(root);
const report = JSON.parse(
  await readFile(join(root, "release-review.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(join(root, "browser/manifest.json"), "utf8"),
);
if (
  report.publicReleaseReady !== false ||
  report.version !== manifest.version ||
  manifest.host_permissions?.length ||
  manifest.manifest_version !== 3
)
  throw new Error("Invalid review status, version, or browser permissions");
for (const pkg of report.packages)
  for (const document of pkg.documents)
    if (!expected.has(document))
      throw new Error("Missing inventoried license text");
for (const file of [
  "source.tar",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/Node.js/LICENSE",
  "licenses/Vencord-GPL-3.0-or-later.txt",
])
  if (!expected.has(file)) throw new Error(`Missing review artifact: ${file}`);
console.log(
  `Verified ${expected.size} checksums; version ${report.version}; ${report.licenseIssues.length} license text issues remain. Not cleared for public release.`,
);
