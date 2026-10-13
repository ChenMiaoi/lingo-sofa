import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { bridgeConfigSchema } from "./config.js";
import { startNative } from "./native.js";
async function main() {
  const directory = resolve(
    process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
  );
  const config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(`${directory}/config.json`, "utf8")) as unknown,
  );
  const pairing = JSON.parse(
    await readFile(`${directory}/pairing.json`, "utf8"),
  ) as { token: string; expiresAt: number };
  if (
    typeof pairing.token !== "string" ||
    pairing.token.length < 32 ||
    pairing.expiresAt <= Date.now()
  )
    throw new Error("Pairing has expired");
  startNative(
    process.argv.find((argument) =>
      argument.startsWith("chrome-extension://"),
    ) ?? "",
    config.allowedExtensions,
    config.port,
    pairing.token,
  );
}
void main().catch(() => {
  process.stderr.write(
    "LingoSofa native host could not start; check configuration and pairing.\n",
  );
  process.exitCode = 1;
});
