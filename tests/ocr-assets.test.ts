import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ocrDictionaryBytes,
  ocrManifest,
  validAsset,
} from "../scripts/ocr-assets";

test("OCR dictionary YAML preserves character values and emits pinned CRLF bytes", () => {
  const source = [
    "PostProcess:",
    "  character_dict:",
    "    - 中",
    "    - ' '",
    "    - '\"'",
    '    - "\'"',
    "    - '\\'",
  ].join("\n");
  // UTF-8 中, space, both quote characters and backslash, each followed by CRLF.
  const expected = Buffer.from("e4b8ad0d0a200d0a220d0a270d0a5c0d0a", "hex");
  expect(ocrDictionaryBytes(source)).toEqual(expected);
  expect(ocrDictionaryBytes(source.replaceAll("\n", "\r\n"))).toEqual(expected);
});

test("OCR dictionary conversion rejects missing or non-string character lists", () => {
  for (const source of [
    "null",
    "{}",
    "PostProcess: {}",
    "PostProcess: { character_dict: [] }",
    "PostProcess: { character_dict: text }",
    "PostProcess: { character_dict: [字, 123] }",
  ])
    expect(() => ocrDictionaryBytes(source)).toThrow(
      "Invalid official OCR dictionary",
    );
});

test("OCR assets reject missing, truncated and same-size corrupt resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingo-ocr-hash-"));
  const file = join(root, "fixture.onnx");
  const bytes = Buffer.from("trusted fixture");
  const asset = {
    name: "fixture.onnx",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    expect(await validAsset(file, asset)).toBe(false);
    await writeFile(file, bytes);
    expect(await validAsset(file, asset)).toBe(true);
    await writeFile(file, Buffer.alloc(bytes.length));
    expect(await validAsset(file, asset)).toBe(false);
    await writeFile(file, bytes.subarray(1));
    expect(await validAsset(file, asset)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR model sources and runtime archive are pinned and every resource has a digest", () => {
  for (const source of [
    ocrManifest.detSource,
    ocrManifest.recSource,
    ocrManifest.dictionarySource,
  ])
    expect(source).toMatch(/\/resolve\/[a-f0-9]{40}\//);
  expect(ocrManifest.runtimeSource).toContain(
    "microsoft/onnxruntime/releases/download/v1.31.0/",
  );
  expect(ocrManifest.runtimeArchiveSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(ocrManifest.assets.map((asset) => asset.name)).toEqual([
    "det.onnx",
    "rec.onnx",
    "characters.txt",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
  ]);
  for (const asset of ocrManifest.assets) {
    expect(asset.bytes).toBeGreaterThan(0);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});
