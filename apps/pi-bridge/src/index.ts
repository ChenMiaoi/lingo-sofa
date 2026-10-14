import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { bridgeConfigSchema } from "./config.js";
import { createBridge } from "./server.js";
import { readProviderSettings } from "./provider-settings.js";
import { startNative } from "./native.js";

const directory = resolve(
  process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = `${directory}/config.json`;
const pairingPath = `${directory}/pairing.json`;
if (process.argv.includes("--init")) {
  await writeFile(
    configPath,
    JSON.stringify(bridgeConfigSchema.parse({}), null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Created ${configPath}. Configure the model and allowed extension IDs before starting.`,
  );
} else if (process.argv.includes("--pair")) {
  const pairing = {
    token: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + 60 * 60_000,
  };
  await writeFile(pairingPath, JSON.stringify(pairing), { mode: 0o600 });
  console.log(`Pairing token (expires in one hour): ${pairing.token}`);
} else {
  const config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
  );
  const pairing = JSON.parse(await readFile(pairingPath, "utf8")) as {
    token: string;
    expiresAt: number;
  };
  if (
    typeof pairing.token !== "string" ||
    !Number.isFinite(pairing.expiresAt) ||
    pairing.expiresAt <= Date.now()
  )
    throw new Error("Run --pair to create a new pairing token");
  if (process.argv.includes("--native")) {
    const origin =
      process.argv.find((argument) =>
        argument.startsWith("chrome-extension://"),
      ) ?? "";
    startNative(origin, config.allowedExtensions, config.port, pairing.token);
  } else {
    const saved = await readProviderSettings(directory);
    if (saved) config.settings.model = saved.model;
    const key = saved
      ? (saved.apiKey ?? "")
      : (process.env.LINGO_SOFA_API_KEY ?? "");
    await writeFile(
      `${directory}/discord-connection.json`,
      JSON.stringify({
        port: config.port,
        token: pairing.token,
        expiresAt: pairing.expiresAt,
      }),
      { mode: 0o600 },
    );
    const { server } = createBridge(
      config,
      key,
      pairing.token,
      pairing.expiresAt,
      dirname(configPath),
    );
    server.listen(config.port, "127.0.0.1", () =>
      console.log(`LingoSofa Bridge listening on 127.0.0.1:${config.port}`),
    );
    const stop = () => {
      server.closeAllConnections();
      server.close();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
