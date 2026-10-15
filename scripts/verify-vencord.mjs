import { execFileSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dirname, "..");
const checkout = join(root, ".cache/vencord");
const revision = "16ec4ea838899706019e7f472e45f055070abeb1";
try {
  await access(join(checkout, ".git"));
} catch {
  execFileSync(
    "git",
    [
      "clone",
      "--no-checkout",
      "https://github.com/Vendicated/Vencord.git",
      checkout,
    ],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", checkout, "checkout", "--detach", revision], {
    stdio: "inherit",
  });
}
if (
  execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== revision
)
  throw new Error("Unexpected cached Vencord revision");
const pnpm = join(root, "node_modules/pnpm/bin/pnpm.cjs");
execFileSync(
  process.execPath,
  [
    pnpm,
    "--dir",
    checkout,
    "--config.manage-package-manager-versions=false",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ],
  { stdio: "inherit" },
);
const project = join(root, "apps/discord-vencord");
const upstream = ts.readConfigFile(
  join(checkout, "tsconfig.json"),
  ts.sys.readFile,
).config;
const paths = Object.fromEntries(
  Object.entries(upstream.compilerOptions.paths).map(([name, values]) => [
    name,
    values.map((value) =>
      relative(project, resolve(checkout, value)).replaceAll("\\", "/"),
    ),
  ]),
);
paths["@vencord/discord-types"] = [
  "../../.cache/vencord/packages/discord-types/src/index.d.ts",
];
const local = JSON.parse(
  await readFile(join(project, "tsconfig.json"), "utf8"),
);
local.extends = relative(project, join(checkout, "tsconfig.json")).replaceAll(
  "\\",
  "/",
);
local.compilerOptions.paths = paths;
const configPath = join(project, "tsconfig.host.generated.json");
try {
  await writeFile(configPath, JSON.stringify(local, null, 2));
  execFileSync(
    process.execPath,
    [
      join(checkout, "node_modules/typescript/bin/tsc"),
      "--project",
      configPath,
      "--noEmit",
    ],
    { stdio: "inherit" },
  );
} finally {
  const { unlink } = await import("node:fs/promises");
  await unlink(configPath).catch(() => undefined);
}
execFileSync(process.execPath, [join(project, "build.mjs")], {
  cwd: project,
  stdio: "inherit",
});
const destination = join(checkout, "src/userplugins/lingoSofa");
await mkdir(destination, { recursive: true });
await cp(join(project, "dist/lingoSofa"), destination, { recursive: true });
execFileSync(
  process.execPath,
  [
    pnpm,
    "--dir",
    checkout,
    "--config.manage-package-manager-versions=false",
    "build",
    "--standalone",
  ],
  { stdio: "inherit" },
);
console.log(`Verified LingoSofa against Vencord ${revision}`);
