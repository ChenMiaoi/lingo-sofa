import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyReleaseVersions } from "./release-policy";

const root = resolve(import.meta.dirname, "..");
const pkg = await Bun.file(resolve(root, "package.json")).json();
const config = await Bun.file(
  resolve(root, "apps/desktop/src-tauri/tauri.conf.json"),
).json();
const cargo = await readFile(resolve(root, "Cargo.toml"), "utf8");
const workspaceVersion =
  /\[workspace.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(cargo)?.[1] ?? "";
const release = verifyReleaseVersions(process.env.GITHUB_REF_NAME ?? "", [
  pkg.version,
  workspaceVersion,
  config.version,
]);
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tag=${release.tag}\nversion=${release.version}\nprerelease=${release.prerelease}\n`,
  );
console.log(
  `Release version verified: ${release.version} (${release.prerelease ? "RC" : "stable"})`,
);
