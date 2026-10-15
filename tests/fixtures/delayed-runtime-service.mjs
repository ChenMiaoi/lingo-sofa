import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
const directory = process.env.LINGO_SOFA_HOME;
await writeFile(
  join(directory, "starting.json"),
  JSON.stringify({ pid: process.pid }),
);
while (true) {
  try {
    await access(join(directory, "ready"));
    break;
  } catch {
    await delay(25);
  }
}
await import("./runtime-service.mjs");
