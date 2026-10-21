export function runtimePlatform(
  platform = process.platform,
  arch = process.arch,
) {
  if (!(
    (platform === "win32" && arch === "x64") ||
    (platform === "darwin" && (arch === "arm64" || arch === "x64"))
  ))
    throw new Error(`Unsupported runtime platform: ${platform}-${arch}`);
  return {
    target:
      `bun-${platform === "win32" ? "windows" : "darwin"}-${arch}` as const,
    nativePackage: `@oh-my-pi/pi-natives-${platform}-${arch}`,
    executableSuffix: platform === "win32" ? ".exe" : "",
  };
}
export const runtime = runtimePlatform();
