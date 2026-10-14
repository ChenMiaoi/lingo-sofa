import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Model,
  Api,
  Models,
  AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ModelConfig,
  ModelClient,
  Metrics,
  PricingSnapshot,
} from "@lingo-sofa/protocol";
import { resolveModel as compatibleModel, ModelFailure } from "./browser.js";
import { resolvePricing } from "./pricing.js";
import { measure, failureMessage } from "./index.js";
export { ModelFailure };
const catalog = builtinModels();
export function resolveModel(
  config: ModelConfig,
  sampledAt = Date.now(),
  conservative = false,
): {
  model: Model<Api>;
  costKnown: boolean;
  pricing: PricingSnapshot;
} {
  if (config.provider === "openai-compatible")
    return compatibleModel(config, sampledAt, conservative);
  const known = catalog.getModel(config.provider, config.model);
  if (!known)
    throw new Error(
      "Model is absent from the installed Pi catalog; select a catalog model or configure an OpenAI-compatible endpoint",
    );
  const pricing = resolvePricing(config, known, sampledAt, conservative);
  return {
    model: {
      ...known,
      baseUrl: config.endpoint,
      cost: pricing.prices ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    costKnown: pricing.prices !== null,
    pricing,
  };
}
export function listModels() {
  return catalog.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: provider.getModels().map((model) => ({
      id: model.id,
      endpoint: model.baseUrl,
      api: model.api,
    })),
  }));
}
export function createPiClient(
  config: ModelConfig,
  runtime: Models,
  onMetrics?: (metrics: Metrics) => void,
): ModelClient {
  resolveModel(config);
  return {
    async complete(system, prompt, signal, onText) {
      const { model, costKnown, pricing } = resolveModel(config);
      const started = performance.now();
      let first: number | null = null,
        firstText: number | null = null,
        last: number | null = null,
        chunks = 0;
      let final: AssistantMessage | undefined;
      const stream = runtime.streamSimple(
        model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          tools: [],
        },
        {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(config.timeoutMs),
          ]),
          maxTokens: config.maxOutputTokens,
          maxRetries: 0,
          timeoutMs: config.timeoutMs,
          toolChoice: "none",
        },
      );
      for await (const event of stream) {
        if (
          (event.type === "text_delta" || event.type === "thinking_delta") &&
          event.delta
        ) {
          const elapsed = performance.now() - started;
          first ??= elapsed;
          last = elapsed;
          chunks++;
          if (event.type === "text_delta") {
            firstText ??= elapsed;
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
      if (["error", "aborted", "length"].includes(final.stopReason))
        throw new ModelFailure(
          final.stopReason === "length"
            ? "Model output limit reached"
            : failureMessage(final),
          metrics,
        );
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
