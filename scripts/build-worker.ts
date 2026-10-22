import { prepareWindowsOcr } from "./ocr-assets";
import { runtime } from "./platform";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, compile, run } from "./process";
await compile(
  resolve(root, "apps/omp-worker/src/worker.ts"),
  resolve(
    root,
    `apps/desktop/src-tauri/resources/omp-worker${runtime.executableSuffix}`,
  ),
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
  resolve(
    root,
    `target/release/lingo-sofa-selection-helper${runtime.executableSuffix}`,
  ),
  resolve(
    root,
    `apps/desktop/src-tauri/resources/selection-helper${runtime.executableSuffix}`,
  ),
);

if (process.platform === "darwin") {
  const selector = resolve(
    root,
    "apps/desktop/src-tauri/resources/region-selector",
  );
  await run([
    "xcrun",
    "swiftc",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos11.0`,
    resolve(root, "apps/desktop/native/region-selector.swift"),
    "-o",
    selector,
  ]);
}
if (process.platform === "darwin" || process.platform === "win32") {
  await prepareWindowsOcr();
  await run([
    "cargo",
    "build",
    "--release",
    "--locked",
    "-p",
    "lingo-sofa-ocr-helper",
  ]);
  await copyFile(
    resolve(
      root,
      `target/release/lingo-sofa-ocr-helper${runtime.executableSuffix}`,
    ),
    resolve(
      root,
      `apps/desktop/src-tauri/resources/ocr-helper${runtime.executableSuffix}`,
    ),
  );
}
