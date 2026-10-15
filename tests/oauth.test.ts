import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  CredentialSynchronizationError,
} from "@earendil-works/pi-coding-agent";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { BridgeOAuth } from "../apps/pi-bridge/src/oauth.js";
import { oauthStatusSchema, modelConfigSchema } from "@lingo-sofa/protocol";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { DiscordBridgeClient } from "../apps/discord-vencord/src/client.js";
import type { AddressInfo } from "node:net";

it("reuses native Pi login, protected storage, serialized refresh and logout without exposing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lingo-oauth-"));
  const authPath = join(dir, "oauth-auth.json");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let complete!: () => void;
  let starts = 0,
    refreshes = 0;
  const deviceIds: string[] = [];
  const provider: ReturnType<typeof openaiProvider> = {
    ...openaiProvider(),
    auth: {
      oauth: {
        name: "Fixture subscription",
        isSubscription: true,
        login: async (interaction, options) => {
          starts++;
          deviceIds.push(options!.getDeviceId!());
          expect(options!.agentName).toBe("LingoSofa");
          interaction.notify({
            type: "auth_url",
            url: "https://auth.openai.com/api/accounts/authorize?state=fixture",
          });
          await new Promise<void>((resolve, reject) => {
            complete = resolve;
            interaction.signal.addEventListener(
              "abort",
              () => reject(new Error("secret-refresh-token")),
              { once: true },
            );
          });
          return {
            type: "oauth",
            access: "secret-access",
            refresh: "secret-refresh",
            expires: Date.now() - 1000,
          };
        },
        refresh: async () => {
          refreshes++;
          return {
            type: "oauth",
            access: "refreshed-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 3600000,
          };
        },
        toAuth: async (c) => ({ apiKey: c.access }),
      },
    },
  };
  runtime.registerNativeProvider(provider);
  let accountChanges = 0;
  const oauth = new BridgeOAuth(
    dir,
    async () => runtime,
    () => {
      accountChanges++;
    },
  );
  try {
    expect(oauth.status()).toEqual({ connected: false, phase: "idle" });
    expect(await oauth.start()).toMatchObject({
      connected: false,
      phase: "pending",
    });
    await oauth.start();
    expect(starts).toBe(1);
    complete();
    while (oauth.busy) await new Promise((resolve) => setTimeout(resolve, 0));
    const status = oauthStatusSchema.parse(oauth.status());
    expect(status).toEqual({ connected: true, phase: "idle" });
    expect(JSON.stringify(status)).not.toContain("secret");
    if (process.platform !== "win32")
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    const secondRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    secondRuntime.registerNativeProvider(provider);
    await Promise.all([
      runtime.getAuth("openai"),
      secondRuntime.getAuth("openai"),
    ]);
    expect(refreshes).toBe(1);
    expect(await readFile(authPath, "utf8")).toContain("rotated-refresh");
    expect(await oauth.logout()).toEqual({ connected: false, phase: "idle" });
    await oauth.start();
    await oauth.cancel();
    expect(deviceIds[0]).toBe(deviceIds[1]);
    expect(accountChanges).toBe(1);
    expect(oauth.status().phase).toBe("idle");
    expect(JSON.stringify(oauth.status())).not.toContain("secret");
  } finally {
    await oauth.cancel();
    await rm(dir, { recursive: true, force: true });
  }
});

it("sanitizes login failures and rejects authorization URLs outside OpenAI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lingo-oauth-fail-"));
  const failed = new BridgeOAuth(dir, async () => ({
    login: async () => {
      throw new Error("private-token");
    },
    logout: async () => {},
  }));
  const malicious = new BridgeOAuth(dir, async () => ({
    login: async (_p, _t, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://evil.example/authorize",
      });
      throw new Error("private-token");
    },
    logout: async () => {},
  }));
  try {
    expect(await failed.start()).toMatchObject({ phase: "failed" });
    expect(JSON.stringify(failed.status())).not.toContain("private-token");
    expect((await malicious.start()).authorizationUrl).toBeUndefined();
  } finally {
    await failed.cancel();
    await malicious.cancel();
    await rm(dir, { recursive: true, force: true });
  }
});

it("shares Bridge OAuth state across authenticated web and Discord clients and never sends tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lingo-oauth-http-"));
  const token = "o".repeat(48),
    extension = "a".repeat(32);
  const model = modelConfigSchema.parse({
    provider: "openai",
    model: "gpt-4o",
    endpoint: "https://api.openai.com/v1",
  });
  await writeFile(
    join(dir, "oauth-auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "private-access",
        refresh: "private-refresh",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  );
  const config = bridgeConfigSchema.parse({
    allowedExtensions: [extension],
    usePiAuth: true,
    settings: { model },
  });
  const bridge = createBridge(config, "", token, Date.now() + 60000, dir);
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (bridge.server.address() as AddressInfo).port;
  config.port = port;
  const desktop = new DiscordBridgeClient({
    port: () => port,
    token: () => token,
    origin: "https://discord.com",
  });
  const post = (
    route: string,
    body: unknown,
    origin = `chrome-extension://${extension}`,
    auth = token,
  ) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    expect(await desktop.oauth("status")).toMatchObject({ connected: true });
    const web = await (await post("/v1/oauth", { action: "status" })).json();
    expect(web).toEqual(await desktop.oauth("status"));
    expect(JSON.stringify(web)).not.toContain("private");
    expect(
      (await post("/v1/oauth", { action: "status" }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          "/v1/oauth",
          { action: "status" },
          `chrome-extension://${extension}`,
          "wrong",
        )
      ).status,
    ).toBe(401);
    expect(
      await desktop.configureProvider({
        model: { ...model, authMode: "subscription" },
      }),
    ).toEqual({ ok: true });
    expect((await desktop.providers()).model.authMode).toBe("subscription");
    expect(
      (
        await post("/v1/provider/update", {
          model: {
            ...model,
            authMode: "subscription",
            endpoint: "https://evil.example/v1",
          },
        })
      ).status,
    ).toBe(400);
    expect(await desktop.oauth("logout")).toMatchObject({ connected: false });
    expect((await desktop.providers()).oauth?.connected).toBe(false);
    expect(
      (
        await post("/v1/provider/update", {
          model: { ...model, authMode: "subscription" },
        })
      ).status,
    ).toBe(400);
    expect((await post("/v1/provider/update", { model })).status).toBe(400);
    expect(
      await desktop.configureProvider({ model, apiKey: "new-api-fixture" }),
    ).toEqual({ ok: true });
    expect(JSON.stringify(await desktop.providers())).not.toContain(
      "new-api-fixture",
    );
  } finally {
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("prices actual subscription tokens at API rates even when Pi reports zero monetary cost", async () => {
  const { SafePiSessions } = await import("../apps/pi-bridge/src/sdk.js");
  const { createAssistantMessageEventStream } =
    await import("@earendil-works/pi-ai");
  const dir = await mkdtemp(join(tmpdir(), "lingo-oauth-usage-"));
  const authPath = join(dir, "oauth-auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  );
  const model = modelConfigSchema.parse({
    provider: "openai",
    model: "gpt-4o",
    endpoint: "https://api.openai.com/v1",
    authMode: "subscription",
    prices: null,
  });
  const sessions = new SafePiSessions(
    model,
    "must-not-use-api-key",
    dir,
    authPath,
  );
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected network request");
  });
  try {
    const runtime = await sessions.runtime();
    runtime.registerNativeProvider({
      ...openaiProvider(),
      streamSimple: (sentModel, _context, options) => {
        expect(options?.apiKey).toBe("subscription-access");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              api: sentModel.api,
              provider: "openai",
              model: sentModel.id,
              content: [{ type: "text", text: "你好" }],
              stopReason: "stop",
              timestamp: Date.now(),
              usage: {
                input: 80,
                cacheRead: 10,
                cacheWrite: 0,
                output: 20,
                reasoning: 5,
                totalTokens: 110,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          }),
        );
        return stream;
      },
    });
    const result = await sessions
      .translationClient("page", "中文", [], () => {})
      .complete("Translate", "Hello", new AbortController().signal);
    expect(result.metrics.billingMode).toBe("subscription");
    expect(result.metrics.pricing?.source).toBe("catalog");
    expect(result.metrics.usage?.totalTokens).toBe(110);
    expect(result.metrics.usage?.cost.total).toBeCloseTo(0.0004125);
    expect(network).not.toHaveBeenCalled();
    await runtime.logout("openai");
    await expect(
      sessions
        .translationClient("page", "中文", [], () => {})
        .complete("Translate", "Hello again", new AbortController().signal),
    ).rejects.toThrow("重新登录");
    await writeFile(
      authPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "old-access",
          refresh: "private-refresh-secret",
          expires: 0,
        },
      }),
    );
    runtime.registerNativeProvider({
      ...openaiProvider(),
      auth: {
        oauth: {
          name: "Fixture",
          isSubscription: true,
          login: async () => {
            throw new Error("unused");
          },
          refresh: async () => {
            throw new Error("private-refresh-secret");
          },
          toAuth: async (c) => ({ apiKey: c.access }),
        },
      },
    });
    await expect(
      sessions
        .translationClient("page", "中文", [], () => {})
        .complete("Translate", "Hello", new AbortController().signal),
    ).rejects.not.toThrow("private-refresh-secret");
  } finally {
    network.mockRestore();
    sessions.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("discards previous-account context even if Pi persisted login before snapshot synchronization failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lingo-oauth-snapshot-"));
  let cleared = 0;
  const credential = {
    type: "oauth" as const,
    access: "new-account-access",
    refresh: "new-account-refresh",
    expires: Date.now() + 3600000,
  };
  const oauth = new BridgeOAuth(
    dir,
    async () => ({
      login: async () => {
        await writeFile(
          join(dir, "oauth-auth.json"),
          JSON.stringify({ openai: credential }),
          { mode: 0o600 },
        );
        throw new CredentialSynchronizationError(
          "openai",
          "login",
          credential,
          { cause: new Error("private-account-detail") },
        );
      },
      logout: async () => {},
    }),
    () => {
      cleared++;
    },
  );
  try {
    const status = await oauth.start();
    expect(status.connected).toBe(true);
    expect(cleared).toBe(1);
    expect(JSON.stringify(status)).not.toContain("private-account-detail");
    expect(JSON.stringify(status)).not.toContain("new-account-access");
  } finally {
    await oauth.cancel();
    await rm(dir, { recursive: true, force: true });
  }
});
