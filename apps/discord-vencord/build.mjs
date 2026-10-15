import { build } from "esbuild";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
const { version } = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url), "utf8"),
);
const release = process.env.LINGO_SOFA_RELEASE_MANIFEST
  ? JSON.parse(await readFile(process.env.LINGO_SOFA_RELEASE_MANIFEST, "utf8"))
  : { version, assets: {} };
if (release.version !== version)
  throw new Error("Assistant and plugin release versions must match");
const { validateAsset } =
  await import("../../packages/local-runtime/src/release.ts");
for (const key of Object.keys(release.assets)) {
  const [platform, arch] = key.split("-");
  validateAsset(release, platform, arch);
}
await build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/lingoSofa/index.tsx",
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  external: ["@api/*", "@utils/*", "@webpack/*", "@vencord/*"],
});

await build({
  entryPoints: ["src/native.ts"],
  define: { LINGO_SOFA_ASSISTANT_RELEASE: JSON.stringify(release) },
  outfile: "dist/lingoSofa/native.ts",
  bundle: true,
  platform: "node",
  format: "esm",
});
