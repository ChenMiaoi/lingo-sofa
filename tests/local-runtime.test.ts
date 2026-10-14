import { it, expect } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClientLeases } from "@lingo-sofa/local-runtime/leases";
import {
  RuntimeClient,
  ensureRuntime,
  runtimePost,
} from "@lingo-sofa/local-runtime";
import { startDaemon } from "../apps/pi-bridge/src/daemon.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { modelServer } from "./fixtures/model-server.js";
const web = `chrome-extension://${"a".repeat(32)}`;
const discord = "https://discord.com";
async function config(directory: string, endpoint?: string) {
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  const value = bridgeConfigSchema.parse({
    port,
    allowedExtensions: ["a".repeat(32)],
    settings: {
      persistUsage: true,
      ...(endpoint
        ? {
            model: {
              provider: "openai-compatible",
              model: "fixture",
              endpoint,
            },
          }
        : {}),
    },
  });
  await writeFile(join(directory, "config.json"), JSON.stringify(value));
  return value;
}
it("keeps one remaining client alive and expires crashed clients before the idle grace", () => {
  const leases = new ClientLeases(45, 60, 0);
  leases.renew(web, "browser", 0);
  leases.renew(discord, "discord", 10);
  leases.release(web, "browser", 20);
  leases.renew(discord, "discord", 40);
  expect(leases.shouldStop(false, 84)).toBe(false);
  expect(leases.shouldStop(false, 144)).toBe(false);
  expect(leases.shouldStop(true, 146)).toBe(false);
  expect(leases.shouldStop(false, 146)).toBe(true);
  leases.renew(web, "fresh", 147);
  leases.release(discord, "fresh", 148);
  expect(leases.shouldStop(false, 160)).toBe(false);
  leases.release(web, "fresh", 161);
  expect(leases.shouldStop(false, 220)).toBe(false);
  expect(leases.shouldStop(false, 221)).toBe(true);
});
it("shares the service and provider, rejects outsiders, and drains paid work before preserving history and exiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-managed-"));
  const model = await modelServer({ delay: 1_500 });
  await config(directory, model.endpoint);
  await writeFile(
    join(directory, "provider.json"),
    JSON.stringify({
      model: bridgeConfigSchema.parse({
        settings: {
          model: {
            provider: "openai-compatible",
            model: "fixture",
            endpoint: model.endpoint,
          },
        },
      }).settings.model,
      apiKey: "fixture-key",
    }),
  );
  let daemon = await startDaemon(directory, {
    leases: new ClientLeases(2000, 80),
    pollMs: 10,
  });
  const browser = new RuntimeClient(directory, web);
  const desktop = new RuntimeClient(directory, discord);
  try {
    const [one, two] = await Promise.all([browser.start(), desktop.start()]);
    expect(one.instanceId).toBe(two.instanceId);
    expect(daemon.leases.count).toBe(2);
    expect(
      (
        await runtimePost(one, "https://attacker.test", "/v1/runtime/lease", {
          id: crypto.randomUUID(),
          action: "renew",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await runtimePost(
          { ...one, token: "0".repeat(64) },
          discord,
          "/v1/runtime/status",
          {},
        )
      ).status,
    ).toBe(401);
    const catalog = await runtimePost(one, web, "/v1/provider", {});
    expect(JSON.stringify(await catalog.json())).not.toContain("fixture-key");
    const pending = runtimePost(two, discord, "/v1/request", {
      version: 1,
      scope: "test:channel",
      sourceKind: "discord",
      request: {
        kind: "translate",
        requestId: crypto.randomUUID(),
        units: [
          {
            id: "hello",
            revision: "1",
            sourceKind: "discord",
            text: "Hello",
            targetLanguage: "中文",
            protectedParts: [],
          },
        ],
      },
    });
    await expect.poll(() => model.requests.length, { timeout: 2_000 }).toBe(1);
    await browser.stop();
    expect(daemon.leases.count).toBe(1);
    await desktop.stop();
    expect(daemon.leases.count).toBe(0);
    await delay(150);
    expect(daemon.busy).toBe(true);
    expect(daemon.server.listening).toBe(true);
    expect(await (await pending).json()).toMatchObject({
      ok: true,
      results: [{ text: "译文 Hello" }],
    });
    await delay(150);
    expect(daemon.server.listening).toBe(false);
    await daemon.stop();
    const history = JSON.parse(
      await readFile(join(directory, "usage.json"), "utf8"),
    );
    expect(history).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    daemon = await startDaemon(directory);
    expect(daemon.service.ledger.list()).toEqual(history);
    expect(model.requests).toHaveLength(1);
    if (process.platform !== "win32")
      expect(
        (await stat(join(directory, "runtime-connection.json"))).mode & 0o777,
      ).toBe(0o600);
  } finally {
    await Promise.all([browser.stop(), desktop.stop()]);
    await daemon.stop();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
it("launches a single daemon concurrently from two hosts, recovers a dead instance, and never clears recorded unknown usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-bootstrap-"));
  const configured = await config(directory);
  configured.settings.dailyTokens = 100;
  await writeFile(join(directory, "config.json"), JSON.stringify(configured));
  const unknown = [
    {
      requestId: crypto.randomUUID(),
      scope: `${discord}|test:channel`,
      model: "deepseek-flash",
      provider: "deepseek",
      sourceKind: "discord",
      mode: "bridge",
      status: "cancelled",
      timestamp: Date.now(),
      usage: null,
      costKnown: true,
      durationMs: 0,
      firstOutputMs: null,
      firstTextMs: null,
      generationMs: null,
      tps: null,
    },
  ];
  await writeFile(join(directory, "usage.json"), JSON.stringify(unknown));
  await writeFile(
    join(directory, "runtime-install.json"),
    JSON.stringify({
      executable: process.execPath,
      entrypoint: resolve("tests/fixtures/runtime-service.mjs"),
    }),
  );
  let pid: number | undefined;
  try {
    const [one, two] = await Promise.all([
      ensureRuntime(directory, web),
      ensureRuntime(directory, discord),
    ]);
    expect(one.instanceId).toBe(two.instanceId);
    pid = JSON.parse(
      await readFile(join(directory, "runtime-connection.json"), "utf8"),
    ).pid;
    process.kill(pid!, "SIGKILL");
    await delay(150);
    const fresh = await ensureRuntime(directory, discord);
    expect(fresh.instanceId).not.toBe(one.instanceId);
    expect(fresh.token).not.toBe(one.token);
    const blocked = await runtimePost(fresh, discord, "/v1/request", {
      version: 1,
      sourceKind: "discord",
      scope: "test:channel",
      request: {
        kind: "translate",
        requestId: crypto.randomUUID(),
        units: [
          {
            id: "protected",
            revision: "1",
            sourceKind: "discord",
            text: "Hello",
            targetLanguage: "中文",
          },
        ],
      },
    });
    expect(await blocked.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown"),
    });
    expect(
      JSON.parse(await readFile(join(directory, "usage.json"), "utf8")),
    ).toEqual(unknown);
    pid = JSON.parse(
      await readFile(join(directory, "runtime-connection.json"), "utf8"),
    ).pid;
    expect(
      (await runtimePost(fresh, discord, "/v1/runtime/status", {})).status,
    ).toBe(200);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
    await delay(200);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
it("does not start anything on stop or accept an uninstalled native runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-uninstalled-"));
  try {
    const client = new RuntimeClient(directory, discord);
    await client.stop();
    await expect(ensureRuntime(directory, discord)).rejects.toThrow("安装");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("does not release a newly enabled client when an earlier renewal finishes after stop", async () => {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "lingo-lease-race-"));
  const instanceId = crypto.randomUUID();
  const token = "a".repeat(64);
  const live = new Set<string>();
  let finishOld: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { id: string; action: string };
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/runtime/status") {
      response.end(JSON.stringify({ version: 1, instanceId }));
      return;
    }
    if (body.action === "renew") {
      live.add(body.id);
      if (!finishOld) {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
      }
    } else live.delete(body.id);
    response.end('{"ok":true}');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await writeFile(
    join(directory, "runtime-connection.json"),
    JSON.stringify({ version: 1, instanceId, port, token }),
  );
  const client = new RuntimeClient(directory, discord);
  try {
    const old = client.start().catch(() => undefined);
    await expect.poll(() => Boolean(finishOld)).toBe(true);
    const stopping = client.stop();
    const fresh = await client.start();
    expect(fresh.instanceId).toBe(instanceId);
    finishOld!();
    await old;
    await stopping;
    expect(live.size).toBe(1);
    await client.stop();
    expect(live.size).toBe(0);
  } finally {
    finishOld?.();
    await client.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
