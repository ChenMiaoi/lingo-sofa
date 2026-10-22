import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bundleInputs, requireBundleInputs } from "../scripts/bundle-inputs";
import { ocrManifest, ocrNoticeFiles } from "../scripts/ocr-assets";

test("Windows bundles require models, dictionary, runtime and licenses; macOS keeps Apple Vision", () => {
  const windows = bundleInputs(
    "/fixture",
    true,
    ".exe",
    "pi_natives.win32-x64-baseline.node",
  );
  for (const name of [
    ...ocrManifest.assets.map((asset) => asset.name),
    ...ocrNoticeFiles,
  ])
    expect(windows.some((file) => file.endsWith(join("ocr", name)))).toBe(true);
  const mac = bundleInputs(
    "/fixture",
    true,
    "",
    "pi_natives.darwin-arm64.node",
  );
  expect(mac.some((file) => file.endsWith("det.onnx"))).toBe(false);
  expect(mac.some((file) => file.endsWith("region-selector"))).toBe(true);
});

test("Windows and macOS bundles include their native OCR helper", () => {
  expect(
    bundleInputs("/fixture", true, "", "pi_natives.darwin-arm64.node").some(
      (file) => basename(file) === "ocr-helper",
    ),
  ).toBe(true);
  expect(
    bundleInputs(
      "/fixture",
      true,
      ".exe",
      "pi_natives.win32-x64-baseline.node",
    ).some((file) => file.includes("ocr-helper")),
  ).toBe(true);
});

test("bundling requires the selected profile, frontend, both helpers and native addon", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingo-sofa-bundle-inputs-"));
  try {
    const files = bundleInputs(
      root,
      true,
      ".exe",
      "pi_natives.win32-x64-baseline.node",
    );
    for (const file of files) {
      await expect(requireBundleInputs(files)).rejects.toThrow(
        "Missing prepared bundle input",
      );
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "fixture");
    }
    await requireBundleInputs(files);
    await expect(
      requireBundleInputs(
        bundleInputs(root, false, ".exe", "pi_natives.win32-x64-baseline.node"),
      ),
    ).rejects.toThrow("release");
    await rm(files[4]!);
    await mkdir(files[4]!);
    await expect(requireBundleInputs(files)).rejects.toThrow(
      "Missing prepared bundle input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
