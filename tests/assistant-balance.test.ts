import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";

it("queries and caches balance with the shared key, reports safe failures and never reuses another account's cached balance", async () => {
  const home = await mkdtemp(join(tmpdir(), "lingo-shared-balance-"));
  const config = bridgeConfigSchema.parse({
    allowedExtensions: ["a".repeat(32)],
  });
  const token = "balance-fixture".padEnd(48, "a");
  const bridge = createBridge(
    config,
    "first-private-key",
    token,
    Date.now() + 600_000,
    home,
  );
  await new Promise<void>((done) => bridge.server.listen(0, "127.0.0.1", done));
  config.port = (bridge.server.address() as AddressInfo).port;
  const original = globalThis.fetch;
  const authorizations: string[] = [];
  let fail = false,
    now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://api.deepseek.com/user/balance")
        return original(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return new Response(
        JSON.stringify(
          fail
            ? {
                error: {
                  message: "first-private-key sensitive-provider-detail",
                },
              }
            : {
                is_available: true,
                balance_infos: [{ currency: "CNY", total_balance: "10.00" }],
              },
        ),
        { status: fail ? 401 : 200 },
      );
    });
  const post = async (route: string, body = {}) =>
    (
      await fetch(`http://127.0.0.1:${config.port}${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: `chrome-extension://${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    ).json();
  try {
    const first = await post("/v1/balance");
    expect(first.data.balance_infos[0].total_balance).toBe("10.00");
    expect(await post("/v1/balance")).toEqual(first);
    expect(authorizations).toEqual(["Bearer first-private-key"]);
    fail = true;
    now += 31_000;
    const rejected = await post("/v1/balance");
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("401"),
    });
    expect(JSON.stringify(rejected)).not.toContain("private-key");
    expect(JSON.stringify(rejected)).not.toContain("sensitive-provider-detail");
    expect(authorizations).toHaveLength(2);
    const catalog = await post("/v1/provider");
    expect(
      await post("/v1/provider/update", {
        target: "account",
        model: catalog.model,
        apiKey: "second-private-key",
      }),
    ).toEqual({ ok: true });
    fail = false;
    expect((await post("/v1/balance")).data).toEqual(first.data);
    expect(authorizations.at(-1)).toBe("Bearer second-private-key");
    expect(authorizations).toHaveLength(3);
  } finally {
    transport.mockRestore();
    clock.mockRestore();
    bridge.server.closeAllConnections();
    await new Promise<void>((done) => bridge.server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
