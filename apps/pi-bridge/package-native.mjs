import { build } from "esbuild";
import { inject } from "postject";
import { copyFile, readFile, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
await build({
  entryPoints: ["src/native-main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/native.cjs",
});
const binary = resolve(
  `dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
const blob = resolve("dist/native.blob");
await writeFile(
  "dist/sea-config.json",
  JSON.stringify({
    main: resolve("dist/native.cjs"),
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(
  process.execPath,
  ["--experimental-sea-config", "dist/sea-config.json"],
  { stdio: "inherit" },
);
await copyFile(process.execPath, binary);
await chmod(binary, 0o755);
if (process.platform === "darwin")
  execFileSync("codesign", ["--remove-signature", binary]);
await inject(binary, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin")
  execFileSync("codesign", ["--sign", "-", binary]);
console.log(`Native host packaged: ${binary}`);
