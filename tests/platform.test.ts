import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import ts from "typescript";
import { runtimePlatform } from "../scripts/platform";

test("worker declares its imported SDK packages as runtime dependencies", async () => {
  const directory = new URL("../apps/omp-worker/", import.meta.url);
  const manifest = await Bun.file(new URL("package.json", directory)).json();
  const sourceDirectory = new URL("src/", directory);
  for (const file of await readdir(sourceDirectory)) {
    if (!file.endsWith(".ts")) continue;
    const source = await Bun.file(new URL(file, sourceDirectory)).text();
    for (const { fileName } of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (!fileName.startsWith("@oh-my-pi/")) continue;
      const packageName = fileName.split("/").slice(0, 2).join("/");
      expect(manifest.dependencies).toHaveProperty(packageName);
    }
  }
});

test("builds use matching executable names, Bun targets and native addons", () => {
  expect(runtimePlatform("win32", "x64")).toEqual({
    target: "bun-windows-x64",
    nativePackage: "@oh-my-pi/pi-natives-win32-x64",
    executableSuffix: ".exe",
  });
  for (const arch of ["arm64", "x64"] as const)
    expect(runtimePlatform("darwin", arch)).toEqual({
      target: `bun-darwin-${arch}`,
      nativePackage: `@oh-my-pi/pi-natives-darwin-${arch}`,
      executableSuffix: "",
    });
});

test("unsupported hosts fail before building an unusable worker", () => {
  expect(() => runtimePlatform("linux", "x64")).toThrow(
    "Unsupported runtime platform",
  );
  expect(() => runtimePlatform("win32", "arm64")).toThrow(
    "Unsupported runtime platform",
  );
});

test("Tauri Cargo features match Windows and macOS application configs", async () => {
  const directory = new URL("../apps/desktop/src-tauri/", import.meta.url);
  const manifest = Bun.TOML.parse(
    await Bun.file(new URL("Cargo.toml", directory)).text(),
  ) as { dependencies: { tauri: { features: string[] } } };
  const base = await Bun.file(new URL("tauri.conf.json", directory)).json();
  const macos = await Bun.file(
    new URL("tauri.macos.conf.json", directory),
  ).json();
  for (const app of [base.app, { ...base.app, ...macos.app }]) {
    expect(
      manifest.dependencies.tauri.features.includes("macos-private-api"),
    ).toBe(Boolean(app.macOSPrivateApi));
  }
});
