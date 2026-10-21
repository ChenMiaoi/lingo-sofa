import { resolve } from "node:path";
import { root, run, cleanEnv } from "./process";
const mode = process.argv[2];
if (mode !== "dev" && mode !== "build")
  throw new Error("Expected dev or build");
await run([
  process.execPath,
  "run",
  "--no-env-file",
  "scripts/build-worker.ts",
]);
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
      ...(mode === "dev" ? ["--", "--no-default-features"] : []),
    ],
    resolve(root, "apps/desktop"),
  );
} finally {
  server?.kill();
}
