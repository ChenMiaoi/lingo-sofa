import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelConfigSchema, providerCatalogSchema } from "@lingo-sofa/protocol";
import {
  createPiClient,
  listModels,
  resolveModel,
} from "@lingo-sofa/provider-pi/browser";
import {
  listModels as nodeModels,
  resolveModel as nodeModel,
} from "@lingo-sofa/provider-pi/node";
import { SafePiSessions } from "../apps/pi-bridge/src/sdk.js";
import { modelServer } from "./fixtures/model-server.js";

it("advertises Pi's per-model effort levels and accepts older catalogs", () => {
  const models = listModels()[0]!.models;
  expect(
    models.find((model) => model.id === "deepseek-flash")!.thinkingLevels,
  ).toEqual(["off", "low", "high", "max"]);
  expect(
    models.find((model) => model.id === "deepseek-v4-pro")!.thinkingLevels,
  ).not.toContain("low");
  expect(
    nodeModels().find((provider) => provider.id === "deepseek")!.models,
  ).toEqual(models);
  const config = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
  });
  const catalog = providerCatalogSchema.parse({
    model: config,
    keyConfigured: true,
    piAuth: false,
    providers: [
      {
        id: "legacy",
        name: "Legacy",
        models: [
          {
            id: "legacy-model",
            endpoint: "https://example.com",
            api: "openai-completions",
          },
        ],
      },
    ],
  });
  expect(catalog.providers[0]!.models[0]!.thinkingLevels).toEqual([]);
  expect(config.thinkingLevel).toBeUndefined();
});

it("rejects unavailable effort before sending a request", () => {
  const config = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    endpoint: "https://api.deepseek.com",
    thinkingLevel: "low",
  });
  expect(() => resolveModel(config)).toThrow("thinking level");
  expect(() => nodeModel(config)).toThrow("thinking level");
});

it("passes effort to direct Pi requests and native Ask sessions", async () => {
  const server = await modelServer();
  const directory = await mkdtemp(join(tmpdir(), "lingo-thinking-"));
  const config = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: server.endpoint,
    thinkingLevel: "high",
  });
  const sessions = new SafePiSessions(config, "fixture-key", directory);
  try {
    await createPiClient(config, "fixture-key").complete(
      "Answer",
      "Question",
      new AbortController().signal,
    );
    expect(server.requests[0]).toMatchObject({ reasoning_effort: "high" });
    const session = await sessions.get("ask-session");
    expect(session.thinkingLevel).toBe("high");
    await sessions.ask(
      "ask-session",
      "Question",
      "Selected context",
      new AbortController().signal,
      () => {},
    );
    expect(server.requests[1]).toMatchObject({ reasoning_effort: "high" });
    expect(session.getActiveToolNames()).toEqual([]);
  } finally {
    sessions.dispose();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
