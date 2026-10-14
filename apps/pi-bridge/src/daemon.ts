import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClientLeases } from "@lingo-sofa/local-runtime/leases";
import { bridgeConfigSchema } from "./config.js";
import { readProviderSettings } from "./provider-settings.js";
import { createBridge } from "./server.js";

export async function startDaemon(
  directory: string,
  lifecycle = { leases: new ClientLeases(), pollMs: 1_000 },
) {
  const config = bridgeConfigSchema.parse(
    JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    ) as unknown,
  );
  const saved = await readProviderSettings(directory);
  if (saved) config.settings.model = saved.model;
  // Bind first: simultaneous launchers cannot initialize competing history writers.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const instanceId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const { leases } = lifecycle;
  const runtime = { instanceId, server, leases, accepting: true };
  try {
    const bridge = createBridge(
      config,
      saved?.apiKey ?? process.env.LINGO_SOFA_API_KEY ?? "",
      token,
      Number.MAX_SAFE_INTEGER,
      directory,
      runtime,
    );
    const descriptor = {
      version: 1,
      instanceId,
      pid: process.pid,
      port: config.port,
      token,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "runtime-connection.json.tmp"),
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );
    await rename(
      join(directory, "runtime-connection.json.tmp"),
      join(directory, "runtime-connection.json"),
    );
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= (async () => {
        clearInterval(timer);
        runtime.accepting = false;
        // Keep the port reserved until paid work and checkpoints have drained.
        while (bridge.busy) await delay(25);
        try {
          await bridge.flush();
          await rm(join(directory, "runtime-connection.json"), { force: true });
        } finally {
          // A failed checkpoint must not leave an authenticated, unusable listener.
          server.closeIdleConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      })());
    const timer = setInterval(() => {
      if (leases.shouldStop(bridge.busy))
        void stop().catch(() => {
          process.exitCode = 1;
        });
    }, lifecycle.pollMs);
    return {
      server,
      service: bridge.service,
      get busy() {
        return bridge.busy;
      },
      get sessions() {
        return bridge.sessions;
      },
      instanceId,
      leases,
      stop,
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
