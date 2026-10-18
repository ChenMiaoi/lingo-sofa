import { it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { providerCatalogSchema, settingsSchema } from "@lingo-sofa/protocol";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { readProviderSettings } from "../apps/pi-bridge/src/provider-settings.js";
import { DiscordBridgeClient } from "../apps/discord-vencord/src/client.js";

it("discovers multiple providers and saves credentials locally without returning them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-provider-"));
  const config = bridgeConfigSchema.parse({
    allowedExtensions: ["a".repeat(32)],
  });
  const token = "provider-pairing-".padEnd(48, "0");
  const bridge = createBridge(
    config,
    "old-fixture-key",
    token,
    Date.now() + 60_000,
    directory,
  );
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  config.port = (bridge.server.address() as AddressInfo).port;
  const client = new DiscordBridgeClient({
    port: () => 0,
    token: () => "",
    origin: "https://discord.com",
    connect: async () => ({ port: config.port, token }),
  });
  const post = (
    route: string,
    body: unknown,
    origin = "https://discord.com",
    authorization = token,
  ) =>
    fetch(`http://127.0.0.1:${config.port}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const catalog = providerCatalogSchema.parse(await client.providers());
    expect(
      catalog.providers.some((provider) => provider.id === "anthropic"),
    ).toBe(true);
    expect(catalog.providers.some((provider) => provider.id === "openai")).toBe(
      true,
    );
    expect(JSON.stringify(catalog)).not.toContain("old-fixture-key");
    expect(
      catalog.providers.some((provider) => provider.id === "openai-codex"),
    ).toBe(false);
    const model = settingsSchema.parse({}).model;
    const next = {
      ...model,
      provider: "openai",
      model: "gpt-4o",
      endpoint: "https://api.openai.com/v1",
    };
    expect((await post("/v1/provider/update", { model: next })).status).toBe(
      400,
    );
    expect(config.settings.model.provider).toBe("deepseek");
    expect(
      (
        await post("/v1/provider/update", {
          model: { ...model, endpoint: "https://example.com/v1" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/v1/provider", {}, "https://discord.com", "wrong")).status,
    ).toBe(401);
    expect(
      (await post("/v1/provider", {}, `chrome-extension://${"a".repeat(32)}`))
        .status,
    ).toBe(200);
    expect(
      (
        await post(
          "/v1/provider/update",
          { model: next },
          `chrome-extension://${"a".repeat(32)}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/v1/provider/update", {
          model: { ...next, model: "nonexistent" },
          apiKey: "new-fixture-key",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/v1/provider/update", {
          model: next,
          apiKey: "new-fixture-key",
          unexpected: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/v1/provider", {}, `chrome-extension://${"b".repeat(32)}`))
        .status,
    ).toBe(403);
    let release!: () => void;
    const active = bridge.service.queue.submit(
      "configuration-busy",
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true };
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      (
        await post("/v1/provider/update", {
          model: next,
          apiKey: "new-fixture-key",
        })
      ).status,
    ).toBe(409);
    expect(await readProviderSettings(directory)).toBeUndefined();
    release();
    await active;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await client.configureProvider({
        model: next,
        apiKey: "new-fixture-key",
      }),
    ).toEqual({ ok: true });
    expect(await readProviderSettings(directory)).toEqual({
      model: { ...next, accountId: expect.any(String) },
      apiKey: "new-fixture-key",
    });
    // NTFS exposes synthetic POSIX mode bits; this assertion applies to POSIX hosts.
    if (process.platform !== "win32")
      expect((await stat(join(directory, "provider.json"))).mode & 0o777).toBe(
        0o600,
      );
    expect((await client.providers()).model.provider).toBe("openai");
    expect(JSON.stringify(await client.providers())).not.toContain(
      "new-fixture-key",
    );
    expect(
      await client.configureProvider({
        model: { ...next, maxOutputTokens: 512 },
      }),
    ).toEqual({ ok: true });
    expect((await readProviderSettings(directory))?.apiKey).toBe(
      "new-fixture-key",
    );
  } finally {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("connects Discord only to a valid, authenticated runtime descriptor", async () => {
  const { createServer } = await import("node:http");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "lingo-connect-"));
  const previous = process.env.LINGO_SOFA_HOME;
  process.env.LINGO_SOFA_HOME = directory;
  const { connection, start, stop } =
    await import("../apps/discord-vencord/src/native.js");
  const instanceId = crypto.randomUUID();
  const token = "a".repeat(64);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`)
      response.writeHead(401);
    response.end(JSON.stringify({ version: 1, instanceId, ok: true }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const descriptor = {
    version: 1,
    instanceId,
    port: (server.address() as AddressInfo).port,
    token,
  };
  const write = (value: unknown) =>
    writeFile(
      join(directory, "runtime-connection.json"),
      JSON.stringify(value),
    );
  try {
    await start(undefined);
    await expect(connection(undefined)).rejects.toThrow(
      "请先安装 LingoSofa 本地助手",
    );
    await stop(undefined);
    await writeFile(join(directory, "runtime-install.json"), "{}");
    await write(descriptor);
    expect(await start(undefined)).toEqual({ ok: true });
    expect(await connection(undefined)).toEqual({
      port: descriptor.port,
      token,
    });
    await stop(undefined);
    expect(await connection(undefined)).toBeNull();
    for (const invalid of [
      { ...descriptor, version: 2 },
      { ...descriptor, instanceId: crypto.randomUUID() },
      { ...descriptor, token: "short" },
      { ...descriptor, token: "b".repeat(64) },
      { ...descriptor, port: 80 },
      { ...descriptor, port: 43187.5 },
    ]) {
      await write(invalid);
      await start(undefined);
      await expect(connection(undefined)).rejects.toThrow(
        "请先安装 LingoSofa 本地助手",
      );
      await stop(undefined);
    }
    await writeFile(join(directory, "runtime-connection.json"), "malformed");
    await start(undefined);
    await expect(connection(undefined)).rejects.toThrow(
      "请先安装 LingoSofa 本地助手",
    );
  } finally {
    await stop(undefined);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (previous === undefined) delete process.env.LINGO_SOFA_HOME;
    else process.env.LINGO_SOFA_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses the newly configured provider for subsequent translation requests", async () => {
  const { modelServer } = await import("./fixtures/model-server.js");
  const model = await modelServer({
    reply: JSON.stringify([{ id: "provider", text: "你好" }]),
  });
  const directory = await mkdtemp(join(tmpdir(), "lingo-provider-runtime-"));
  const config = bridgeConfigSchema.parse({});
  const token = "fixture-provider-runtime-token".padEnd(48, "0");
  const bridge = createBridge(
    config,
    "old-key",
    token,
    Date.now() + 60_000,
    directory,
  );
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  config.port = (bridge.server.address() as AddressInfo).port;
  const client = new DiscordBridgeClient({
    port: () => config.port,
    token: () => token,
    origin: "https://discord.com",
  });
  try {
    const selected = (await client.providers()).providers
      .find((provider) => provider.id === "groq")
      ?.models.find((model) => model.api === "openai-completions");
    expect(selected).toBeDefined();
    expect(
      await client.configureProvider({
        model: {
          ...config.settings.model,
          provider: "groq",
          model: selected!.id,
          endpoint: model.endpoint,
        },
        apiKey: "new-fixture-key",
      }),
    ).toEqual({ ok: true });
    const reply = await client.request("fixture:provider", {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [
        {
          id: "provider",
          revision: "1",
          text: "Hello",
          sourceKind: "discord",
          targetLanguage: "简体中文",
          protectedParts: [],
        },
      ],
    });
    if (!reply.ok) throw new Error(reply.error);
    if (reply.ok)
      expect(reply.results).toEqual([
        {
          id: "provider",
          revision: "1",
          text: "你好",
          billing: expect.objectContaining({
            source: "request",
            batchSize: 1,
            tokens: 44,
            cost: null,
          }),
        },
      ]);
    expect((await client.usage("fixture:provider"))[0]?.provider).toBe("groq");
  } finally {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
