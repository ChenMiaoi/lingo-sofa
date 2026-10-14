import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { RuntimeClient } from "@lingo-sofa/local-runtime";
import { bridgeConfigSchema } from "./config.js";
import { startNative } from "./native.js";
async function main() {
  const directory = resolve(
    process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
  );
  const config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(`${directory}/config.json`, "utf8")) as unknown,
  );
  const origin =
    process.argv.find((argument) =>
      argument.startsWith("chrome-extension://"),
    ) ?? "";
  if (
    !config.allowedExtensions.some(
      (id) =>
        origin === `chrome-extension://${id}/` ||
        origin === `chrome-extension://${id}`,
    )
  )
    throw new Error("Native caller is not allowed");
  const client = new RuntimeClient(directory, origin.replace(/\/$/, ""));
  // Bind stdin synchronously so an early browser request is not lost during startup.
  startNative(origin, config.allowedExtensions, config.port, "", {
    connection: () => client.connection(),
    stop: () => client.stop(),
  });
  await client.start();
}
void main().catch(() => {
  process.stderr.write(
    "LingoSofa local runtime could not start; check installation and configuration.\n",
  );
  process.exit(1);
});
