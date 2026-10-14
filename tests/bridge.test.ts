import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { NativeDecoder, nativeFrame } from "../apps/pi-bridge/src/native.js";
import { modelServer } from "./fixtures/model-server.js";
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
    const session = await bridge.sessions.get(
      "https://discord.com|account:one|conversation",
    );
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
    expect(session.settingsManager.getProviderRetrySettings().maxRetries).toBe(
      0,
    );
    expect(session.getSessionStats().tokens.total).toBe(44);
    await post(ask("account:two", "Other channel"));
    const secondSession = await bridge.sessions.get(
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
        expect.objectContaining({ scope: "https://discord.com|account:one" }),
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
      usage: [
        expect.objectContaining({ scope: "https://discord.com|account:one" }),
      ],
    });
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
    const token = "native-token-0000000000000000000000000000";
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
    );
    await new Promise<void>((resolve) =>
      bridge.server.listen(0, "127.0.0.1", resolve),
    );
    config.port = (bridge.server.address() as AddressInfo).port;
    await writeFile(join(directory, "config.json"), JSON.stringify(config));
    await writeFile(
      join(directory, "pairing.json"),
      JSON.stringify({ token, expiresAt }),
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
