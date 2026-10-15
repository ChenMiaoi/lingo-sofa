import { it, expect } from "vitest";
import { createPiClient, ModelFailure } from "@lingo-sofa/provider-pi/browser";
import { modelConfigSchema, translationUnitSchema } from "@lingo-sofa/protocol";
import { translate } from "@lingo-sofa/translation-core";
import { modelServer } from "./fixtures/model-server.js";
it("uses the installed Pi API to translate and expose normalized usage", async () => {
  const server = await modelServer();
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
    });
    const unit = translationUnitSchema.parse({
      id: "a",
      revision: "1",
      sourceKind: "web",
      text: "Use `fetch`",
      targetLanguage: "中文",
    });
    const result = await translate(
      createPiClient(config, "fixture-key"),
      [unit],
      [],
      new AbortController().signal,
    );
    expect(result.results[0]!.text).toContain("`fetch`");
    expect(result.metrics.usage).toMatchObject({
      input: 12,
      cacheRead: 20,
      output: 12,
      totalTokens: 44,
    });
    expect(result.metrics.costKnown).toBe(false);
    expect(result.metrics.tps).toBeGreaterThan(0);
    expect(server.requests[0]).not.toHaveProperty("tools");
  } finally {
    await server.close();
  }
});
it("does not retry failed requests and preserves error accounting", async () => {
  const server = await modelServer({ status: 429 });
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
    });
    await expect(
      createPiClient(config, "fixture").complete(
        "system",
        "hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow("429");
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});
it("propagates cancellation to the provider", async () => {
  const server = await modelServer({ delay: 5_000 });
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
    });
    const controller = new AbortController();
    const promise = createPiClient(config, "fixture").complete(
      "system",
      "hello",
      controller.signal,
    );
    setTimeout(() => controller.abort(), 40);
    await expect(promise).rejects.toThrow("cancelled");
  } finally {
    await server.close();
  }
});
it("times out slow output without retrying or inventing usage", async () => {
  const server = await modelServer({ delay: 2000 });
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
      timeoutMs: 1000,
    });
    const error = await createPiClient(config, "fixture")
      .complete("system", "hello", new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ModelFailure);
    expect((error as ModelFailure).metrics.usage).toBeNull();
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});

it("reports upstream insufficient balance without retrying", async () => {
  const server = await modelServer({ status: 402 });
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
    });
    await expect(
      createPiClient(config, "fixture").complete(
        "system",
        "hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow("balance or quota");
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});

it("reports upstream service overload without retrying", async () => {
  const server = await modelServer({ status: 503 });
  try {
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      endpoint: server.endpoint,
      model: "fixture",
    });
    await expect(
      createPiClient(config, "fixture").complete(
        "system",
        "hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow("service unavailable (503)");
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});
