import { runtime } from "./platform";
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
export function desktopToolCommand(tool: "vite" | "tauri") {
  return [
    "node",
    resolve(
      root,
      "node_modules",
      tool === "vite" ? "vite/bin/vite.js" : "@tauri-apps/cli/tauri.js",
    ),
  ];
}
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
  // The API handles native Windows paths without the CLI's ancestor lookups.
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    env: "disable",
    define: { "process.env.NODE_ENV": '"production"' },
    conditions: ["production"],
    external: ["omp-legacy-pi-modules"],
    compile: {
      target: runtime.target,
      outfile: output,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  if (!result.success)
    throw new AggregateError(
      result.logs,
      "Standalone runtime compilation failed",
    );
  const native = Bun.resolveSync(
    runtime.nativePackage,
    resolve(root, "apps/omp-worker/src/worker.ts"),
  );
  await copyFile(native, resolve(output, "..", basename(native)));
}
