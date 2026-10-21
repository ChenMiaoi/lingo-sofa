import { stat } from "node:fs/promises";
import { join } from "node:path";

export function bundleInputs(
  root: string,
  debug: boolean,
  suffix: string,
  nativeName: string,
): string[] {
  return [
    join(
      root,
      `target/${debug ? "debug" : "release"}/lingo-sofa-desktop${suffix}`,
    ),
    join(root, "apps/desktop/dist/index.html"),
    ...[`omp-worker${suffix}`, `selection-helper${suffix}`, nativeName].map(
      (name) => join(root, "apps/desktop/src-tauri/resources", name),
    ),
  ];
}

export async function requireBundleInputs(files: string[]): Promise<void> {
  for (const file of files) {
    if (!(await stat(file).catch(() => undefined))?.isFile())
      throw new Error(
        `Missing prepared bundle input: ${file}. Run npm run check for --debug, or npm run build for release.`,
      );
  }
}
