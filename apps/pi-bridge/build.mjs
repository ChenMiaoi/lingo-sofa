import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts", "src/config.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/*",
    "zod",
  ],
  outdir: "dist",
});
