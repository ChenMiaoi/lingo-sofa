import { expect, test } from "bun:test";
import { runtimePlatform } from "../scripts/platform";

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
