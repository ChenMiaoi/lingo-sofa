import { URL } from "node:url";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
const { version } = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url), "utf8"),
);
await build({
  define: { LINGO_SOFA_VERSION: JSON.stringify(version) },
  entryPoints: ["src/index.ts", "src/config.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/*",
    "zod",
    "proper-lockfile",
  ],
  outdir: "dist",
});
