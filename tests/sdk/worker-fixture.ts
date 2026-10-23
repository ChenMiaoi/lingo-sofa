import { basename, dirname, join, resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { compile, root } from "../../scripts/process";
import { runtime } from "../../scripts/platform";

export async function prepareWorkerFixture(
  source: string,
  output: string,
  packaged: boolean,
): Promise<{ program: string; args: string[] }> {
  if (packaged) {
    const program = output + runtime.executableSuffix;
    await compile(source, program);
    return { program, args: [] };
  }
  // Resolve/transpile the SDK once, rather than in every isolated worker process.
  // This remains JavaScript executed by Bun; packaged tests still use compile().
  const directory = join(dirname(output), "source");
  const name = basename(output) + ".js";
  const result = await Bun.build({
    entrypoints: [source],
    outdir: directory,
    naming: name,
    target: "bun",
    env: "disable",
    define: { "process.env.NODE_ENV": '"production"' },
    conditions: ["production"],
    external: ["omp-legacy-pi-modules"],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Runtime fixture bundling failed");
  // pi-natives uses ../native for non-compiled import.meta.dir on every platform.
  // Bun.build also writes all emitted SDK assets alongside the JavaScript.
  const nativeDirectory = join(directory, "..", "native");
  await mkdir(nativeDirectory, { recursive: true });
  const native = Bun.resolveSync(
    runtime.nativePackage,
    resolve(root, "apps/omp-worker/src/worker.ts"),
  );
  await copyFile(native, join(nativeDirectory, basename(native)));
  return {
    program: process.execPath,
    args: ["run", "--no-env-file", join(directory, name)],
  };
}
