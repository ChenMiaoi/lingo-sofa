import { resolve } from "node:path";
import { root, run } from "./process";
if (process.platform === "darwin") {
  await run([
    resolve(root, "apps/desktop/src-tauri/resources/region-selector"),
    "--self-test",
  ]);
}
