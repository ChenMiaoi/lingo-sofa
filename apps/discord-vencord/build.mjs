import { build } from "esbuild";
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
  outfile: "dist/lingoSofa/native.ts",
  bundle: true,
  platform: "node",
  format: "esm",
});
