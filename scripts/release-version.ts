import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./process";

const pkg = await Bun.file(resolve(root, "package.json")).json();
const config = await Bun.file(
  resolve(root, "apps/desktop/src-tauri/tauri.conf.json"),
).json();
const cargo = await readFile(resolve(root, "Cargo.toml"), "utf8");
const workspaceVersion =
  /\[workspace.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
if (pkg.version !== config.version || pkg.version !== workspaceVersion)
  throw new Error(
    "Release versions must match in package.json, Cargo.toml and tauri.conf.json",
  );
if (process.env.GITHUB_REF_NAME !== `v${pkg.version}`)
  throw new Error("Release tag must match the application version");
console.log(`Release version verified: ${pkg.version}`);
