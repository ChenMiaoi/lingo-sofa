import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, compile, run } from "./process";
await compile(
  resolve(root, "apps/omp-worker/src/worker.ts"),
  resolve(root, "apps/desktop/src-tauri/resources/omp-worker.exe"),
);

await run([
  "cargo",
  "build",
  "--release",
  "--locked",
  "-p",
  "lingo-sofa-selection-helper",
]);
await copyFile(
  resolve(root, "target/release/lingo-sofa-selection-helper.exe"),
  resolve(root, "apps/desktop/src-tauri/resources/selection-helper.exe"),
);
