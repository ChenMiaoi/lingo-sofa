import {
  capabilities,
  discoverCapabilities,
  outputAllocation,
} from "./capabilities.js";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ModelClient,
  ModelConfig,
  Metrics,
  PricingSnapshot,
} from "@lingo-sofa/protocol";
import { resolvePricing } from "./pricing.js";
import { measure, failureMessage } from "./index.js";

export function listModels() {
  const provider = deepseekProvider();
  return [
    {
      id: provider.id,
      name: provider.name,
      models: provider.getModels().map((model) => ({
        id: model.id,
        endpoint: model.baseUrl,
        api: model.api,
      })),
    },
  ];
}
export class ModelFailure extends Error {
  constructor(
    message: string,
    readonly metrics: Metrics,
  ) {
    super(message);
  }
}
export function resolveModel(
  config: ModelConfig,
  sampledAt = Date.now(),
  conservative = false,
): {
  model: Model<"openai-completions">;
  costKnown: boolean;
  pricing: PricingSnapshot;
} {
  if (!["deepseek", "openai-compatible"].includes(config.provider))
    throw new Error("This provider requires local Pi Bridge mode");
  const catalog =
    config.provider === "deepseek"
      ? deepseekProvider()
          .getModels()
          .find((model) => model.id === config.model)
      : undefined;
  const pricing = resolvePricing(config, catalog, sampledAt, conservative);
  const model: Model<"openai-completions"> = {
    ...(catalog ?? {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "openai-compatible",
      reasoning: false,
      input: ["text"],
      contextWindow: capabilities(config)?.contextWindow ?? 0,
      maxTokens: capabilities(config)?.maxOutputTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    ...(capabilities(config, catalog)
      ? {
          contextWindow: capabilities(config, catalog)!.contextWindow,
          maxTokens: capabilities(config, catalog)!.maxOutputTokens,
        }
      : {}),
    baseUrl: config.endpoint,
    id: config.model,
    cost: pricing.prices ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
  return {
    model,
    costKnown: pricing.prices !== null,
    pricing,
  };
}
export function createPiClient(
  config: ModelConfig,
  apiKey: string,
  fetcher?: typeof fetch,
  onMetrics?: (metrics: Metrics) => void,
): ModelClient {
  resolveModel(config);
  return {
    async complete(system, prompt, signal, onText) {
      const limits =
        capabilities(config, resolveModel(config).model) ??
        (await discoverCapabilities(config, apiKey, fetcher ?? fetch));
      const { model, costKnown, pricing } = resolveModel({
        ...config,
        capabilities: limits,
      });
      const inputTokens = new TextEncoder().encode(system + prompt).length;
      const maxTokens = outputAllocation(
        config,
        limits,
        new TextEncoder().encode(prompt).length,
        inputTokens,
      );
      const started = performance.now();
      let first: number | null = null,
        firstText: number | null = null,
        last: number | null = null,
        chunks = 0;
      const stream = streamSimple(
        model,
        normalizeContext({
          systemPrompt: system,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          tools: [],
        }),
        {
          apiKey,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(config.timeoutMs),
          ]),
          maxTokens,
          maxRetries: 0,
          timeoutMs: config.timeoutMs,
          ...(fetcher ? { fetch: fetcher } : {}),
        },
      );
      let final: AssistantMessage | undefined;
      for await (const event of stream) {
        if (
          (event.type === "text_delta" || event.type === "thinking_delta") &&
          event.delta.length
        ) {
          const now = performance.now() - started;
          first ??= now;
          last = now;
          chunks++;
          if (event.type === "text_delta") {
            firstText ??= now;
            onText?.(event.delta);
          }
        }
        if (event.type === "done") final = event.message;
        if (event.type === "error") final = event.error;
      }
      final ??= await stream.result();
      const metrics = measure(
        final,
        performance.now() - started,
        first,
        firstText,
        last,
        chunks,
        costKnown,
        pricing,
      );
      onMetrics?.(metrics);
      if (final.stopReason === "error" || final.stopReason === "aborted")
        throw new ModelFailure(failureMessage(final), metrics);
      if (final.stopReason === "length")
        throw new ModelFailure("Model output limit reached", metrics);
      return {
        text: final.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        metrics,
      };
    },
  };
}
