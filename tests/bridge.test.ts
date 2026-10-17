import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { ClientLeases } from "@lingo-sofa/local-runtime/leases";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { replySchema } from "@lingo-sofa/protocol";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { NativeDecoder, nativeFrame } from "../apps/pi-bridge/src/native.js";
import { modelServer } from "./fixtures/model-server.js";
it("normalizes echoed model input metadata before returning a strict Bridge reply", async () => {
  const model = await modelServer({
    reply: JSON.stringify([
      { id: "echo", text: "你好", targetLanguage: "简体中文", context: "" },
    ]),
  });
  const directory = await mkdtemp(join(tmpdir(), "lingo-echo-"));
  const config = bridgeConfigSchema.parse({
    settings: {
      mode: "bridge",
      model: {
        provider: "openai-compatible",
        model: "fixture",
        endpoint: model.endpoint,
      },
    },
  });
  const token = "fixture-echo-token-00000000000000000000";
  const bridge = createBridge(
    config,
    "fixture-key",
    token,
    Date.now() + 60_000,
    directory,
  );
  try {
    await new Promise<void>((resolve) =>
      bridge.server.listen(0, "127.0.0.1", resolve),
    );
    config.port = (bridge.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/request`, {
      method: "POST",
      headers: {
        Origin: "https://discord.com",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        sourceKind: "discord",
        scope: "fixture:echo",
        request: {
          kind: "translate",
          requestId: crypto.randomUUID(),
          units: [
            {
              id: "echo",
              revision: "1",
              sourceKind: "discord",
              text: "Hello",
              targetLanguage: "简体中文",
              protectedParts: [],
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    const reply = replySchema.parse(await response.json());
    if (!reply.ok) throw new Error(reply.error);
    expect(reply).toMatchObject({
      ok: true,
      results: [{ id: "echo", revision: "1", text: "你好" }],
    });
    expect(reply.results?.[0]).not.toHaveProperty("targetLanguage");
    expect(reply.results?.[0]).not.toHaveProperty("context");
  } finally {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    bridge.sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects invalid native framing and decodes split/multiple frames", () => {
  const decoder = new NativeDecoder();
  const frame = nativeFrame({ request: 1 });
  expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
  expect(
    decoder.push(
      Buffer.concat([frame.subarray(3), nativeFrame({ request: 2 })]),
    ),
  ).toEqual([{ request: 1 }, { request: 2 }]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(1_000_001);
  expect(() => new NativeDecoder().push(oversized)).toThrow();
});
it("authenticates loopback clients and uses isolated tool-free Pi SDK sessions", async () => {
  const model = await modelServer();
  const directory = await mkdtemp(join(tmpdir(), "lingo-sdk-"));
  const config = bridgeConfigSchema.parse({
    settings: {
      mode: "bridge",
      persistUsage: true,
      model: {
        provider: "openai-compatible",
        model: "fixture",
        endpoint: model.endpoint,
      },
    },
  });
  const token = "fixture-token-000000000000000000000000000";
  const bridge = createBridge(
    config,
    "fixture-key",
    token,
    Date.now() + 60_000,
    directory,
  );
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  config.port = (bridge.server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${config.port}`;
  const post = (
    body: unknown,
    auth = token,
    origin = "https://discord.com",
    route = "/v1/request",
  ) =>
    fetch(endpoint + route, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const ask = (scope: string, question: string) => ({
    version: 1,
    sourceKind: "discord",
    scope,
    request: {
      kind: "ask",
      requestId: crypto.randomUUID(),
      sessionId: "conversation",
      question,
      context: "Selected message",
    },
  });
  try {
    expect((await post(ask("account:one", "Hello"), "bad")).status).toBe(401);
    expect(
      (await post(ask("account:one", "Hello"), token, "https://attacker.test"))
        .status,
    ).toBe(403);
    const first = await post(ask("account:one", "Explain"));
    const firstReply = (await first.json()) as unknown;
    expect(firstReply, JSON.stringify(firstReply)).toMatchObject({
      ok: true,
      text: "这是模拟回答。",
      metrics: { usage: { totalTokens: 44 } },
    });
    const session = await bridge.askSessions.get(
      "https://discord.com|account:one|conversation",
    );
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
    expect(session.settingsManager.getProviderRetrySettings().maxRetries).toBe(
      0,
    );
    expect(session.getSessionStats().tokens.total).toBe(44);
    await post(ask("account:two", "Other channel"));
    const secondSession = await bridge.askSessions.get(
      "https://discord.com|account:two|conversation",
    );
    expect(secondSession).not.toBe(session);
    expect(session.getSessionStats().assistantMessages).toBe(1);
    const usage = await post(
      { scope: "account:one" },
      token,
      "https://discord.com",
      "/v1/usage",
    );
    expect(await usage.json()).toMatchObject({
      ok: true,
      usage: [
        expect.objectContaining({
          scope: "https://discord.com|account:one",
          sessionId: "conversation",
        }),
      ],
    });
    expect(model.requests[0]).not.toHaveProperty("tools");
    expect(firstReply).toMatchObject({
      sessionStats: {
        tokens: 44,
        cost: null,
        messages: session.getSessionStats().totalMessages,
      },
    });
    const statsReply = await post({
      version: 1,
      sourceKind: "discord",
      scope: "account:one",
      request: { kind: "usage" },
    });
    expect(await statsReply.json()).toMatchObject({
      ok: true,
      sharedUsage: false,
      shareBudget: false,
      budgets: [],
      usage: [
        expect.objectContaining({
          scope: "https://discord.com|account:one",
          sessionId: "conversation",
        }),
      ],
    });
    config.allowedExtensions.push("a".repeat(32));
    const allClients = await post(
      {
        version: 1,
        sourceKind: "web",
        scope: "browser:summary",
        request: { kind: "usage" },
      },
      token,
      `chrome-extension://${"a".repeat(32)}`,
    );
    const aggregate = replySchema.parse(await allClients.json());
    expect(aggregate).toMatchObject({
      ok: true,
      usageSummary: {
        totals: { requests: 2, tokens: 88, cost: null, unpriced: 2 },
        models: [
          expect.objectContaining({
            model: "fixture",
            requests: 2,
            tokens: 88,
          }),
        ],
      },
    });
    expect(aggregate).not.toHaveProperty("usage");
    expect(aggregate).toMatchObject({
      queue: { running: 0, pending: 0 },
      cacheStats: expect.any(Object),
    });
    expect(JSON.stringify(aggregate)).not.toContain("account:two");
    await post({
      version: 1,
      sourceKind: "discord",
      scope: "account:one",
      request: { kind: "clear-data" },
    });
    expect(
      bridge.sessions.stats("https://discord.com|account:one|conversation"),
    ).toBeUndefined();
    expect(bridge.service.ledger.list()).toHaveLength(1);
    const observed = model.requests.length;
    const restored = createBridge(
      config,
      "fixture-key",
      token,
      Date.now() + 60_000,
      directory,
    );
    expect(restored.service.ledger.list()).toEqual(
      bridge.service.ledger.list(),
    );
    expect(model.requests).toHaveLength(observed);
    restored.sessions.dispose();
  } finally {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

const packagedNative = resolve(
  `apps/pi-bridge/dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
it.skipIf(!existsSync(packagedNative))(
  "relays framed requests through the packaged native executable",
  async () => {
    const binary = resolve(
      `apps/pi-bridge/dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
    );
    const model = await modelServer();
    const directory = await mkdtemp(join(tmpdir(), "lingo-native-"));
    const extension = "a".repeat(32);
    const token = "a".repeat(64);
    const instanceId = crypto.randomUUID();
    const expiresAt = Date.now() + 60_000;
    const config = bridgeConfigSchema.parse({
      allowedExtensions: [extension],
      settings: {
        mode: "bridge",
        model: {
          provider: "openai-compatible",
          model: "fixture",
          endpoint: model.endpoint,
        },
      },
    });
    const bridge = createBridge(
      config,
      "fixture-key",
      token,
      expiresAt,
      directory,
      {
        instanceId,
        server: createServer(),
        leases: new ClientLeases(),
        appVersion: "9.8.7",
      },
    );
    await new Promise<void>((resolve) =>
      bridge.server.listen(0, "127.0.0.1", resolve),
    );
    config.port = (bridge.server.address() as AddressInfo).port;
    await writeFile(join(directory, "config.json"), JSON.stringify(config));
    await writeFile(
      join(directory, "runtime-connection.json"),
      JSON.stringify({ version: 1, instanceId, token, port: config.port }),
    );
    const child = spawn(binary, [`chrome-extension://${extension}/`], {
      env: { ...process.env, LINGO_SOFA_HOME: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const reply = new Promise<unknown>((resolve, reject) => {
        const decoder = new NativeDecoder();
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code) reject(new Error(`Native host exited: ${code}`));
        });
        child.stdout.on("data", (chunk: Buffer) => {
          for (const value of decoder.push(chunk)) resolve(value);
        });
      });
      child.stdin.write(
        nativeFrame({
          version: 1,
          scope: "web:fixture",
          sourceKind: "web",
          request: {
            kind: "translate",
            requestId: crypto.randomUUID(),
            units: [
              {
                id: "a",
                revision: "1",
                text: "Hello",
                sourceKind: "web",
                targetLanguage: "中文",
              },
            ],
          },
        }),
      );
      expect(await reply).toMatchObject({
        ok: true,
        results: [{ id: "a", revision: "1", text: "译文 Hello" }],
      });
      const exchange = (value: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const decoder = new NativeDecoder();
          const timeout = setTimeout(() => {
            child.stdout.off("data", receive);
            reject(new Error("Native provider request timed out"));
          }, 5000);
          function receive(chunk: Buffer) {
            for (const reply of decoder.push(chunk)) {
              clearTimeout(timeout);
              child.stdout.off("data", receive);
              resolve(reply);
            }
          }
          child.stdout.on("data", receive);
          child.stdin.write(nativeFrame(value));
        });
      const transportId = crypto.randomUUID();
      expect(
        await exchange({
          transportId,
          payload: {
            version: 1,
            sourceKind: "web",
            scope: "browser",
            request: { kind: "usage" },
          },
        }),
      ).toMatchObject({ transportId, payload: { ok: true } });
      const status = await exchange({
        version: 1,
        sourceKind: "web",
        scope: "browser",
        operation: "runtime-status",
      });
      expect(status).toMatchObject({
        version: 1,
        instanceId,
        appVersion: "9.8.7",
      });
      expect(status).not.toHaveProperty("token");
      expect(status).not.toHaveProperty("pid");
      const catalog = await exchange({
        version: 1,
        sourceKind: "web",
        scope: "browser",
        operation: "provider",
      });
      expect(catalog).toMatchObject({
        keyConfigured: true,
        model: { model: "fixture" },
      });
      expect(JSON.stringify(catalog)).not.toContain("fixture-key");
      expect(
        await exchange({
          version: 1,
          sourceKind: "web",
          scope: "browser",
          operation: "oauth",
          request: { action: "status" },
        }),
      ).toEqual({ connected: false, phase: "idle" });
      expect(
        await exchange({
          version: 1,
          sourceKind: "web",
          scope: "browser",
          operation: "oauth",
          request: { action: "status", accessToken: "must-not-pass" },
        }),
      ).toMatchObject({ ok: false });

      expect(
        await exchange({
          version: 1,
          sourceKind: "discord",
          scope: "browser",
          operation: "provider",
        }),
      ).toMatchObject({ ok: false });
      expect(
        await exchange({
          version: 1,
          sourceKind: "web",
          scope: "browser",
          operation: "provider-update",
          update: {
            model: { ...config.settings.model, model: "fixture-next" },
          },
        }),
      ).toEqual({ ok: true });
      expect(config.settings.model.model).toBe("fixture-next");
    } finally {
      child.kill();
      bridge.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        bridge.server.close(() => resolve()),
      );
      await model.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it("rejects expired pairing and incompatible versions, then recovers after Bridge restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-recovery-"));
  const extension = "a".repeat(32);
  const config = bridgeConfigSchema.parse({ allowedExtensions: [extension] });
  const token = "recovery-fixture-token-000000000000000000";
  let active = createBridge(
    config,
    "fixture-key",
    token,
    Date.now() - 1,
    directory,
  );
  const listen = async () => {
    await new Promise<void>((done) =>
      active.server.listen(0, "127.0.0.1", done),
    );
    config.port = (active.server.address() as AddressInfo).port;
  };
  const post = (version = 1, sourceKind = "web") =>
    fetch(`http://127.0.0.1:${config.port}/v1/request`, {
      method: "POST",
      headers: {
        Origin: `chrome-extension://${extension}`,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version,
        sourceKind,
        scope: "browser",
        request: { kind: "usage" },
      }),
    });
  const close = async () => {
    active.server.closeAllConnections();
    await new Promise<void>((done) => active.server.close(() => done()));
  };
  try {
    await listen();
    expect((await post()).status).toBe(401);
    await close();
    active = createBridge(
      config,
      "fixture-key",
      token,
      Date.now() + 60_000,
      directory,
    );
    await listen();
    expect((await post(2)).status).toBe(400);
    expect((await post(1, "discord")).status).toBe(400);
    const reply = await post();
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      ok: true,
      usage: [],
      sharedUsage: false,
      shareBudget: false,
    });
    expect(active.service.ledger.list()).toEqual([]);
    expect(active.service.queue.runningCount).toBe(0);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});
