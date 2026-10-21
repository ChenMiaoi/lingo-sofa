import { mkdir, copyFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
export const root = resolve(import.meta.dirname, "..");
export const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !/key|token|secret|password|credential/i.test(key),
    ),
  ) as Record<string, string>;
export async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, {
    cwd,
    env: cleanEnv(),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code) throw new Error(`Command failed (${code}): ${command[0]}`);
}
export async function compile(source: string, output: string) {
  await mkdir(resolve(output, ".."), { recursive: true });
  await run([
    process.execPath,
    "build",
    "--no-env-file",
    "--compile",
    "--target=bun-windows-x64",
    "--external",
    "omp-legacy-pi-modules",
    "--outfile",
    output,
    source,
  ]);
  const native = Bun.resolveSync(
    "@oh-my-pi/pi-natives-win32-x64",
    resolve(root, "apps/omp-worker/src/worker.ts"),
  );
  await copyFile(native, resolve(output, "..", basename(native)));
}
