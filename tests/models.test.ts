import { expect, test } from "bun:test";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import * as ai from "@oh-my-pi/pi-ai";
import { WorkerModels } from "../apps/omp-worker/src/models";

async function catalog() {
  const store = await ai.SqliteAuthCredentialStore.open(":memory:");
  const registry = new sdk.ModelRegistry(
    new sdk.AuthStorage(store, { usageProviderResolver: () => undefined }),
    undefined,
    {
      ignoreLocalModelConfig: true,
      settings: sdk.Settings.isolated({ "providers.cacheWarming": "off" }),
    },
  );
  const origins: string[] = [];
  const models = new WorkerModels(
    registry,
    ai,
    () => {
      throw new Error("test_transport_not_dispatched");
    },
    (origin) => origins.push(origin),
    2048,
  );
  return { models, registry, origins };
}

test("SDK catalog supplies provider metadata and bounded model pages without exposing credentials", async () => {
  const { models } = await catalog();
  const list = models.list();
  for (const provider of ["deepseek", "openai", "anthropic", "google"]) {
    expect(
      list.providers.find((entry) => entry.id === provider)?.supported,
    ).toBe(true);
  }
  expect(
    list.providers.find((entry) => entry.id === "openai-codex")?.supported,
  ).toBe(true);
  expect(
    list.providers.find((entry) => entry.id === "openai-codex")?.apiKey,
  ).toBe(false);
  expect(
    list.providers.find((entry) => entry.id === "openai-codex")?.login,
  ).toBe("openai-codex");
  expect(
    models
      .list("deepseek")
      .models.some((entry) => entry.id === "deepseek-flash"),
  ).toBe(true);
  const first = models.list("openrouter");
  expect(first.models.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(first).length).toBeLessThan(60 * 1024);
  if (first.total > 100) {
    const second = models.list("openrouter", 100);
    expect(second.models.length).toBeGreaterThan(0);
    expect(
      second.models.every(
        (entry) => !first.models.some((old) => old.id === entry.id),
      ),
    ).toBe(true);
  }
  expect(() => models.resolve("deepseek", "not-a-model")).toThrow(
    "model_not_verified",
  );
  expect(() => models.list("openai", -1)).toThrow("invalid_catalog_page");
  expect(models.list("unknown-provider").supported).toBe(false);
});

test("governed models preserve SDK native protocols, endpoints and output limits", async () => {
  const { models, registry, origins } = await catalog();
  for (const [provider, api] of [
    ["deepseek", "openai-completions"],
    ["openai", "openai-responses"],
    ["anthropic", "anthropic-messages"],
    ["google", "google-generative-ai"],
    ["openai-codex", "openai-codex-responses"],
    ["google-gemini-cli", "google-gemini-cli"],
    ["openrouter", "openrouter"],
  ]) {
    const entry = models.list(provider!).models[0]!;
    const original = models.resolve(provider!, entry.id);
    const activated = models.activate(provider!, entry.id);
    const wrapped = registry.find(provider!, entry.id)!;
    expect(wrapped.api).toBe("lingo-worker");
    const native = models.native(wrapped);
    expect(native.api).toBe(api!);
    expect(native.baseUrl).toBe(original.baseUrl);
    expect(native.contextWindow).toBe(original.contextWindow);
    expect(activated.requestOutputCap).toBeLessThanOrEqual(2048);
    expect(origins).toContain(new URL(original.baseUrl).origin);
  }
});

test("SDK native transports build different provider requests instead of coercing all models to chat completions", async () => {
  const { models, registry } = await catalog();
  for (const provider of ["deepseek", "anthropic", "google"]) {
    const entry = models.list(provider).models[0]!;
    models.activate(provider, entry.id);
    const native = models.native(registry.find(provider, entry.id)!);
    let observed: { url: string; body: Record<string, unknown> } | undefined;
    const fetch: typeof globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) => {
        observed = {
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        // The request shape is the subject of this test, so the response may be an auth failure.
        return new Response(
          JSON.stringify({
            error: {
              message: "synthetic-auth-failure",
              type: "authentication_error",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: () => undefined },
    );
    await ai
      .streamSimple(
        native,
        {
          messages: [
            { role: "user", content: "Translate hello", timestamp: 0 },
          ],
        },
        { apiKey: "synthetic-key", maxTokens: 32, maxHttpAttempts: 1, fetch },
      )
      .result();
    expect(observed).toBeDefined();
    if (provider === "google") {
      expect(observed!.body.contents).toBeArray();
      expect(observed!.body.messages).toBeUndefined();
    } else {
      expect(observed!.body.messages).toBeArray();
      expect(observed!.url).toContain(
        provider === "anthropic" ? "/messages" : "/chat/completions",
      );
    }
  }
});

test("production worker exposes the SDK catalog and requires verified governed sessions", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "lingosofa-models-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--no-env-file",
      resolve("apps/omp-worker/src/worker.ts"),
    ],
    {
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        USERPROFILE: directory,
        PI_CODING_AGENT_DIR: join(directory, "agent"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const reader = child.stdout.getReader();
  const instance = "model-catalog-test";
  let buffer = new Uint8Array(0);
  let id = 0;
  const send = (frame: Record<string, unknown>) => {
    const body = new TextEncoder().encode(JSON.stringify(frame));
    const bytes = new Uint8Array(4 + body.length);
    new DataView(bytes.buffer).setUint32(0, body.length, true);
    bytes.set(body, 4);
    child.stdin.write(bytes);
    child.stdin.flush();
  };
  const read = async (): Promise<
    import("../apps/omp-worker/src/ipc").Frame
  > => {
    while (true) {
      if (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(
          0,
          true,
        );
        expect(length).toBeLessThanOrEqual(64 * 1024);
        if (buffer.length >= length + 4) {
          const frame = JSON.parse(
            new TextDecoder().decode(buffer.slice(4, length + 4)),
          );
          buffer = buffer.slice(length + 4);
          return frame;
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("worker_closed");
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer);
      next.set(value, buffer.length);
      buffer = next;
    }
  };
  const request = async (
    method: string,
    payload: Record<string, unknown> = {},
  ) => {
    send({ v: 1, instance, kind: "request", id: ++id, method, payload });
    while (true) {
      const frame = await read();
      if (frame.kind === "credential_request") {
        send({
          v: 1,
          instance,
          kind: "credential_response",
          id: frame.id,
          ok: true,
          payload: {
            revision: 1,
            credential: {
              type: "api_key",
              key: "synthetic-" + String(frame.payload.account),
            },
          },
        });
      } else {
        expect(frame.kind).toBe("response");
        expect(frame.id).toBe(id);
        return frame;
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        expect(
          (
            await request("hello", {
              sdk: "18.12.3",
              accounts: ["deepseek", "openai"],
            })
          ).ok,
        ).toBe(true);
        const logins = await request("auth.providers");
        expect(logins.ok).toBe(true);
        for (const provider of [
          "openai-codex",
          "anthropic",
          "kimi-code",
          "github-copilot",
          "google-gemini-cli",
        ]) {
          expect(
            (logins.payload.providers as { provider: string }[]).some(
              (entry) => entry.provider === provider,
            ),
          ).toBe(true);
        }
        expect(
          (await request("auth.start", { provider: "not-a-provider" })).ok,
        ).toBe(false);
        const catalog = await request("model.catalog", {
          provider: "deepseek",
        });
        expect(catalog.ok).toBe(true);
        expect(catalog.payload.supported).toBe(true);
        expect((await request("session.create")).ok).toBe(false);
        const verified = await request("model.verify", {
          provider: "deepseek",
          modelId: "deepseek-flash",
        });
        expect(verified.ok).toBe(true);
        const session = await request("session.create");
        expect(session.ok).toBe(true);
        expect(session.payload.tools).toEqual([]);
        expect(
          (
            await request("model.verify", {
              provider: "openai",
              modelId: "gpt-4.1",
            })
          ).ok,
        ).toBe(false);
        expect((await request("stats")).payload.providerCalls).toBe(0);
        await request("session.close", {
          sessionId: session.payload.sessionId,
        });
        expect((await request("shutdown")).ok).toBe(true);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("worker_test_timeout")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
