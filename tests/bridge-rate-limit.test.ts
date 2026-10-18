import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  createBridge,
  BRIDGE_REQUESTS_PER_MINUTE,
} from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";

it("bounds per-origin traffic after a whole-page burst and restores capacity in the next minute", async () => {
  const home = await mkdtemp(join(tmpdir(), "lingo-request-rate-"));
  const config = bridgeConfigSchema.parse({});
  const token = "rate-fixture-token".padEnd(48, "a");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const bridge = createBridge(config, "", token, now + 600_000, home);
  await new Promise<void>((done) => bridge.server.listen(0, "127.0.0.1", done));
  config.port = (bridge.server.address() as AddressInfo).port;
  const post = (path = "/fixture-unknown") =>
    fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: "POST",
      headers: {
        Origin: "https://discord.com",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  try {
    for (let count = 0; count < BRIDGE_REQUESTS_PER_MINUTE; count += 32) {
      const statuses = await Promise.all(
        Array.from(
          { length: Math.min(32, BRIDGE_REQUESTS_PER_MINUTE - count) },
          async () => {
            const response = await post();
            await response.arrayBuffer();
            return response.status;
          },
        ),
      );
      expect(statuses.every((status) => status === 404)).toBe(true);
    }
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await limited.arrayBuffer();
    now += 60_001;
    const restored = await post("/v1/provider");
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
  } finally {
    clock.mockRestore();
    bridge.server.closeAllConnections();
    await new Promise<void>((done) => bridge.server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
