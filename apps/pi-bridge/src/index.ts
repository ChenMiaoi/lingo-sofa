import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { bridgeConfigSchema } from "./config.js";
import { startDaemon } from "./daemon.js";

async function main() {
  const directory = resolve(
    process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.argv.includes("--init")) {
    await writeFile(
      `${directory}/config.json`,
      JSON.stringify(
        bridgeConfigSchema.parse({
          settings: { mode: "bridge", persistUsage: true },
        }),
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Created local runtime configuration. Install the assistant before connecting clients.",
    );
    return;
  }
  const daemon = await startDaemon(directory);
  const stop = () => {
    void daemon.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch(() => {
  // Configuration/provider parser errors may contain private values.
  process.stderr.write(
    "LingoSofa local service could not start; check installation, configuration or port occupancy.\n",
  );
  process.exitCode = 1;
});
