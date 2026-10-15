import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";

// NuGet supplies an unpackable compiler distribution; no system installer or PATH changes.
export async function ensureInno(root) {
  if (process.env.LINGO_SOFA_ISCC) return process.env.LINGO_SOFA_ISCC;
  const directory = join(root, ".cache/tools/inno-6.7.3");
  const executable = join(directory, "tools/ISCC.exe");
  try {
    await access(executable);
    return executable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await globalThis.fetch(
    "https://api.nuget.org/v3-flatcontainer/tools.innosetup/6.7.3/tools.innosetup.6.7.3.nupkg",
    {
      signal: globalThis.AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) throw new Error("Could not download Inno Setup compiler");
  const data = Buffer.from(await response.arrayBuffer());
  if (
    createHash("sha256").update(data).digest("hex") !==
    "f780898e402ff80612cc8d9fcb8c6e02932bd1cb4c900ffdaa31f9341cfb49f4"
  )
    throw new Error("Inno Setup compiler checksum mismatch");
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "compiler.zip");
  await writeFile(archive, data);
  // Pass paths as environment data rather than interpolating them into a command.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:LINGO_INNO_ARCHIVE -DestinationPath $env:LINGO_INNO_DIRECTORY -Force",
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        LINGO_INNO_ARCHIVE: archive,
        LINGO_INNO_DIRECTORY: directory,
      },
    },
  );
  await readFile(executable);
  return executable;
}
