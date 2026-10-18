import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { DiscordBridgeClient } from "../apps/discord-vencord/src/client.js";
import { providerCatalogSchema, replySchema } from "@lingo-sofa/protocol";

it("shares keyless engines between Discord and browser clients, preserves models, and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-free-"));
  const token = "free-translation-fixture".padEnd(48, "0");
  const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
  const realFetch = globalThis.fetch;
  const upstream: string[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      upstream.push(url);
      if (url.includes("edge.microsoft.com")) {
        const texts = JSON.parse(String(init?.body)) as string[];
        return Response.json(
          texts.map(() => ({ translations: [{ text: "必应译文" }] })),
        );
      }
      if (url.includes("translate.googleapis.com"))
        return Response.json([[["谷歌译文"]]]);
      throw new Error("Unexpected model request");
    });
  let config = bridgeConfigSchema.parse({
    allowedExtensions: ["a".repeat(32)],
  });
  let bridge = createBridge(config, "", token, Date.now() + 60_000, directory);
  const start = async () => {
    await new Promise<void>((done) =>
      bridge.server.listen(0, "127.0.0.1", done),
    );
    config.port = (bridge.server.address() as AddressInfo).port;
  };
  const stop = async () => {
    bridge.server.closeAllConnections();
    await new Promise<void>((done) => bridge.server.close(() => done()));
  };
  await start();
  const port = () => (bridge.server.address() as AddressInfo).port;
  const client = new DiscordBridgeClient({
    port,
    token: () => token,
    origin: "https://discord.com",
  });
  const post = (path: string, value: unknown) =>
    fetch(`http://127.0.0.1:${port()}${path}`, {
      method: "POST",
      headers: {
        Origin: extensionOrigin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    }).then((response) => response.json());
  const request = (sourceKind: "web" | "discord") => ({
    kind: "translate" as const,
    automatic: false,
    requestId: crypto.randomUUID(),
    units: [
      {
        id: "paragraph",
        revision: "1",
        sourceKind,
        targetLanguage: "简体中文",
        text: "Hello world",
        protectedParts: [],
      },
    ],
  });
  try {
    const initial = await client.providers();
    expect(initial.translationEngine).toBe("bing");
    expect(initial.keyConfigured).toBe(false);
    expect(await client.request("channel", request("discord"))).toMatchObject({
      ok: true,
      results: [
        { text: "必应译文", billing: { billingMode: "free", cost: 0 } },
      ],
    });
    expect(
      await post("/v1/provider/update", {
        target: "translation-engine",
        engine: "google",
      }),
    ).toEqual({ ok: true });
    expect(
      replySchema.parse(
        await post("/v1/request", {
          version: 1,
          scope: "page",
          sourceKind: "web",
          request: request("web"),
        }),
      ),
    ).toMatchObject({ ok: true, results: [{ text: "谷歌译文" }] });
    expect(
      await client.configureProvider({
        target: "account",
        model: initial.model,
        apiKey: "saved-fixture-key",
      }),
    ).toEqual({ ok: true });
    const withKey = providerCatalogSchema.parse(await client.providers());
    expect(withKey.translationEngine).toBe("google");
    expect(withKey.keyConfigured).toBe(true);
    expect(withKey.askModel).toEqual(initial.askModel);
    expect(JSON.stringify(withKey)).not.toContain("saved-fixture-key");
    expect(
      await client.configureProvider({
        target: "translation-engine",
        engine: "bing",
      }),
    ).toEqual({ ok: true });
    await stop();
    config = bridgeConfigSchema.parse({ allowedExtensions: ["a".repeat(32)] });
    bridge = createBridge(config, "", token, Date.now() + 60_000, directory);
    await start();
    expect((await client.providers()).translationEngine).toBe("bing");
    expect(await client.request("channel", request("discord"))).toMatchObject({
      ok: true,
      results: [{ text: "必应译文" }],
    });
    expect(upstream).toHaveLength(3);
  } finally {
    await stop();
    spy.mockRestore();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

it.each([
  { provider: "openai-compatible", model: "unavailable-model" },
  { provider: "deepseek", model: "removed-catalog-model" },
])(
  "reads saved $provider settings and switches to free translation when the model is unavailable",
  async (model) => {
    const directory = await mkdtemp(join(tmpdir(), "lingo-free-recovery-"));
    const token = "free-recovery-fixture".padEnd(48, "0");
    const realFetch = globalThis.fetch;
    const upstream: string[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        upstream.push(url);
        if (url.includes("edge.microsoft.com"))
          return Promise.resolve(
            Response.json(
              (JSON.parse(String(init?.body)) as string[]).map(() => ({
                translations: [{ text: "免费译文" }],
              })),
            ),
          );
        return Promise.resolve(
          Response.json({ error: "Invalid API key" }, { status: 401 }),
        );
      });
    const initialConfig = () =>
      bridgeConfigSchema.parse({
        allowedExtensions: ["a".repeat(32)],
        settings: {
          translationEngine: "llm",
          model: { ...model, endpoint: "https://unavailable-model.test/v1" },
        },
      });
    let config = initialConfig();
    let bridge = createBridge(
      config,
      "saved-fixture-key",
      token,
      Date.now() + 60_000,
      directory,
    );
    const start = async () => {
      await new Promise<void>((done) =>
        bridge.server.listen(0, "127.0.0.1", done),
      );
      config.port = (bridge.server.address() as AddressInfo).port;
    };
    const stop = async () => {
      bridge.server.closeAllConnections();
      await new Promise<void>((done) => bridge.server.close(() => done()));
    };
    const client = new DiscordBridgeClient({
      port: () => (bridge.server.address() as AddressInfo).port,
      token: () => token,
      origin: "https://discord.com",
    });
    const request = {
      kind: "translate" as const,
      automatic: false,
      requestId: crypto.randomUUID(),
      units: [
        {
          id: "recovery",
          revision: "1",
          sourceKind: "discord" as const,
          targetLanguage: "English",
          text: "你好",
          protectedParts: [],
        },
      ],
    };
    await start();
    try {
      const failed = await client.request("channel", request);
      expect(failed.ok).toBe(false);
      upstream.length = 0;
      const saved = await client.providers();
      expect(saved.model).toMatchObject(model);
      expect(saved.translationEngine).toBe("llm");
      expect(saved.accounts).toHaveLength(1);
      expect(saved.keyConfigured).toBe(true);
      expect(JSON.stringify(saved)).not.toContain("saved-fixture-key");
      expect(upstream).toEqual([]);
      expect(
        await client.configureProvider({
          target: "translation-engine",
          engine: "bing",
        }),
      ).toEqual({ ok: true });
      expect(
        await client.request("channel", {
          ...request,
          requestId: crypto.randomUUID(),
        }),
      ).toMatchObject({
        ok: true,
        results: [
          { text: "免费译文", billing: { billingMode: "free", cost: 0 } },
        ],
      });
      await stop();
      config = initialConfig();
      bridge = createBridge(config, "", token, Date.now() + 60_000, directory);
      await start();
      const restored = await client.providers();
      expect(restored.model).toEqual(saved.model);
      expect(restored.askModel).toEqual(saved.askModel);
      expect(restored.accounts).toEqual(saved.accounts);
      expect(restored.keyConfigured).toBe(true);
      expect(restored.translationEngine).toBe("bing");
      expect(upstream).toHaveLength(1);
    } finally {
      await stop();
      spy.mockRestore();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
