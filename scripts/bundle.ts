import { basename, resolve } from "node:path";
import { bundleInputs, requireBundleInputs } from "./bundle-inputs";
import { runtime } from "./platform";
import { root, run } from "./process";

const args = process.argv.slice(2);
const native = Bun.resolveSync(
  runtime.nativePackage,
  resolve(root, "apps/omp-worker/src/worker.ts"),
);
await requireBundleInputs(
  bundleInputs(
    root,
    args.includes("--debug"),
    runtime.executableSuffix,
    basename(native),
  ),
);
await run(
  [process.execPath, "x", "tauri", "bundle", ...args],
  resolve(root, "apps/desktop"),
);
