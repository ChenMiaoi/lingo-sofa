import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bundleInputs, requireBundleInputs } from "../scripts/bundle-inputs";

test("macOS bundles its native OCR helper and Windows keeps the existing runtime inputs", () => {
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
  ).toBe(false);
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
