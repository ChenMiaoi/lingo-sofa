import { it, expect } from "vitest";
import { modelConfigSchema } from "@lingo-sofa/protocol";
import {
  capabilities,
  discoverCapabilities,
  outputAllocation,
} from "@lingo-sofa/provider-pi";
import { resolveModel } from "@lingo-sofa/provider-pi/node";
const config = modelConfigSchema.parse({
  provider: "openai-compatible",
  model: "custom",
  endpoint: "https://models.example/v1",
});
it("uses published DeepSeek capacities instead of rounded or application hard limits", () => {
  const model = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
  });
  const official = capabilities(model)!;
  expect(official).toMatchObject({
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    source: "official",
    updatedAt: "2026-10-14",
  });
  expect(resolveModel(model).model).toMatchObject({
    contextWindow: 1048576,
    maxTokens: 393216,
  });
  expect(model.maxOutputTokens).toBe(0);
  expect(outputAllocation(model, official, 100000, 100000)).toBe(200000);
  expect(outputAllocation(model, official, 400000, 900000)).toBe(
    1048576 - 900000,
  );
});
it("loads custom provider specifications and never invents unknown model limits", async () => {
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "custom",
            context_window: 123456,
            max_output_tokens: 20000,
            max_input_tokens: 100000,
          },
        ],
      }),
    );
  const limits = await discoverCapabilities(config, "fixture", fetcher);
  expect(limits).toMatchObject({
    modelId: "custom",
    contextWindow: 123456,
    maxOutputTokens: 20000,
    maxInputTokens: 100000,
    source: "provider",
  });
  expect(outputAllocation(config, limits, 12000, 1000)).toBe(20000);
  expect(() => outputAllocation(config, limits, 100, 100001)).toThrow(
    "input/context",
  );
  await expect(
    discoverCapabilities(
      config,
      "fixture",
      async () => new Response(JSON.stringify({ data: [{ id: "custom" }] })),
    ),
  ).rejects.toThrow("did not publish");
  await expect(
    discoverCapabilities(
      config,
      "fixture",
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "custom",
                context_window: 100000,
                max_output_tokens: 20000,
                max_input_tokens: -1,
              },
            ],
          }),
        ),
    ),
  ).rejects.toThrow("did not publish");
  expect(resolveModel(config).model.contextWindow).toBe(0);
  expect(
    capabilities({ ...config, model: "other", capabilities: limits }),
  ).toBeUndefined();
  expect(
    capabilities({
      ...config,
      endpoint: "https://different.example/v1",
      capabilities: limits,
    }),
  ).toBeUndefined();
});
it("clamps an explicitly requested output allocation to the supplier ceiling", () => {
  const limits = {
    modelId: "custom",
    contextWindow: 100000,
    maxOutputTokens: 12000,
    source: "provider" as const,
  };
  const chosen = modelConfigSchema.parse({ ...config, maxOutputTokens: 50000 });
  expect(chosen.maxOutputTokens).toBe(50000);
  expect(outputAllocation(chosen, limits, 1, 100)).toBe(12000);
});
