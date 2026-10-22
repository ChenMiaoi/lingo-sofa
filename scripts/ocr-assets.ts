import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { root, run } from "./process";

export interface OcrAsset {
  name: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  detSource: string;
  recSource: string;
  dictionarySource: string;
  runtimeSource: string;
  runtimeArchiveSha256: string;
  assets: OcrAsset[];
}
export const ocrNoticeFiles = [
  "provenance.json",
  "OCR-NOTICES.md",
  "PaddleOCR-LICENSE.txt",
  "ONNX-Runtime-LICENSE.txt",
  "ONNX-Runtime-ThirdPartyNotices.txt",
];
export const ocrManifest: Manifest = JSON.parse(
  await readFile(
    new URL("../crates/ocr-helper/assets.json", import.meta.url),
    "utf8",
  ),
);
export async function validAsset(
  path: string,
  asset: OcrAsset,
): Promise<boolean> {
  if ((await stat(path).catch(() => undefined))?.size !== asset.bytes)
    return false;
  return (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") === asset.sha256
  );
}
async function download(
  url: string,
  path: string,
  sha256?: string,
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw new Error(`OCR resource download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 128 * 1024 * 1024)
    throw new Error("OCR resource archive is too large");
  if (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("OCR resource checksum mismatch");
  await writeFile(path, bytes);
}
export async function prepareWindowsOcr(): Promise<void> {
  if (process.platform !== "win32") return;
  const destination = resolve(root, "apps/desktop/src-tauri/resources/ocr");
  const cache = resolve(root, ".cache/ocr-assets");
  await mkdir(destination, { recursive: true });
  await mkdir(cache, { recursive: true });
  for (const asset of ocrManifest.assets) {
    const target = join(destination, asset.name);
    if (await validAsset(target, asset)) continue;
    const cached = join(cache, asset.name);
    if (!(await validAsset(cached, asset))) {
      if (asset.name === "det.onnx" || asset.name === "rec.onnx") {
        await download(
          asset.name === "det.onnx"
            ? ocrManifest.detSource
            : ocrManifest.recSource,
          cached,
          asset.sha256,
        );
      } else if (asset.name === "characters.txt") {
        const config = join(cache, "recognition.yml");
        await download(ocrManifest.dictionarySource, config);
        const parsed = Bun.YAML.parse(await readFile(config, "utf8")) as {
          PostProcess?: { character_dict?: unknown };
        };
        const characters = parsed.PostProcess?.character_dict;
        if (
          !Array.isArray(characters) ||
          !characters.every((value) => typeof value === "string")
        )
          throw new Error("Invalid official OCR dictionary");
        await writeFile(cached, characters.join("\n") + "\n");
      } else {
        const archive = join(cache, "onnxruntime-win-x64-1.31.0.zip");
        const archiveValid = await readFile(archive)
          .then(
            (bytes) =>
              createHash("sha256").update(bytes).digest("hex") ===
              ocrManifest.runtimeArchiveSha256,
          )
          .catch(() => false);
        if (!archiveValid)
          await download(
            ocrManifest.runtimeSource,
            archive,
            ocrManifest.runtimeArchiveSha256,
          );
        const extracted = join(cache, "runtime");
        await mkdir(extracted, { recursive: true });
        const quote = (path: string) => "'" + path.replaceAll("'", "''") + "'";
        await run([
          "powershell.exe",
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)} -Force`,
        ]);
        const runtime = join(extracted, "onnxruntime-win-x64-1.31.0");
        for (const dll of ocrManifest.assets.filter((value) =>
          value.name.endsWith(".dll"),
        ))
          await copyFile(join(runtime, "lib", dll.name), join(cache, dll.name));
        await copyFile(
          join(runtime, "LICENSE"),
          join(destination, "ONNX-Runtime-LICENSE.txt"),
        );
        await copyFile(
          join(runtime, "ThirdPartyNotices.txt"),
          join(destination, "ONNX-Runtime-ThirdPartyNotices.txt"),
        );
      }
    }
    if (!(await validAsset(cached, asset)))
      throw new Error(`OCR resource checksum mismatch: ${asset.name}`);
    await copyFile(cached, target);
  }
  // Include the reviewed provenance and licenses in every prepared installation.
  await copyFile(
    resolve(root, "crates/ocr-helper/assets.json"),
    join(destination, "provenance.json"),
  );
  await copyFile(
    resolve(root, "third-party-notices/ocr.md"),
    join(destination, "OCR-NOTICES.md"),
  );
  for (const name of [
    "PaddleOCR-LICENSE.txt",
    "ONNX-Runtime-LICENSE.txt",
    "ONNX-Runtime-ThirdPartyNotices.txt",
  ])
    await copyFile(
      resolve(root, "third-party-notices", name),
      join(destination, name),
    );
}
if (import.meta.main) await prepareWindowsOcr();
