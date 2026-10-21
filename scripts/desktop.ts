import { resolve } from "node:path";
import { root, run, desktopToolCommand } from "./process";
import { requireDesktopDependencies } from "./dev-session";
import {
  localIdentity,
  signedCargoArguments,
  signRuntime,
} from "./macos-signing";
const mode = process.argv[2];
if (mode !== "dev" && mode !== "build")
  throw new Error("Expected dev or build");
await requireDesktopDependencies();
await run([process.execPath, "--no-env-file", "./scripts/build-worker.ts"]);
let cargoSigningArgs: string[] = [];
if (mode === "dev" && process.platform === "darwin") {
  const identity = await localIdentity();
  if (identity) {
    await signRuntime(identity);
    cargoSigningArgs = signedCargoArguments();
  } else
    console.warn(
      "Run npm run signing:setup once to keep macOS development signatures stable.",
    );
}
const appCommand = [
  ...desktopToolCommand("tauri"),
  mode,
  ...process.argv.slice(3),
  ...(mode === "dev"
    ? ["--", "--no-default-features", ...cargoSigningArgs]
    : []),
];
if (mode === "dev") {
  const session = [
    "node",
    resolve(root, "scripts/dev-session.ts"),
    JSON.stringify({
      server: ["node", resolve(root, "scripts/dev-server.ts")],
      app: appCommand,
      cwd: resolve(root, "apps/desktop"),
    }),
  ];
  await run(
    process.platform === "win32"
      ? [
          "cargo",
          "run",
          "--locked",
          "--quiet",
          "-p",
          "lingo-sofa-omp-client",
          "--example",
          "dev-session",
          "--",
          ...session,
        ]
      : session,
  );
} else {
  await run([
    ...desktopToolCommand("vite"),
    "build",
    "--config",
    "apps/desktop/vite.config.ts",
  ]);
  await run(appCommand, resolve(root, "apps/desktop"));
}
