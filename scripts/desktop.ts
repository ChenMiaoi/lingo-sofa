import { resolve } from "node:path";
import { root, run, cleanEnv } from "./process";
import {
  localIdentity,
  signedCargoArguments,
  signRuntime,
} from "./macos-signing";
const mode = process.argv[2];
if (mode !== "dev" && mode !== "build")
  throw new Error("Expected dev or build");
await run([
  process.execPath,
  "run",
  "--no-env-file",
  "scripts/build-worker.ts",
]);
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
let server: ReturnType<typeof Bun.spawn> | undefined;
if (mode === "dev")
  server = Bun.spawn(
    [process.execPath, "x", "vite", "--config", "apps/desktop/vite.config.ts"],
    { cwd: root, env: cleanEnv(), stdout: "inherit", stderr: "inherit" },
  );
else await run([process.execPath, "run", "--no-env-file", "build:web"]);
try {
  await run(
    [
      process.execPath,
      "x",
      "tauri",
      mode,
      ...process.argv.slice(3),
      ...(mode === "dev"
        ? ["--", "--no-default-features", ...cargoSigningArgs]
        : []),
    ],
    resolve(root, "apps/desktop"),
  );
} finally {
  server?.kill();
}
