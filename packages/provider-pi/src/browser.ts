import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelClient, ModelConfig, Metrics } from "@lingo-sofa/protocol";
import { measure } from "./index.js";

export class ModelFailure extends Error {
  constructor(
    message: string,
    readonly metrics: Metrics,
  ) {
    super(message);
  }
}
export function resolveModel(config: ModelConfig): {
  model: Model<"openai-completions">;
  costKnown: boolean;
} {
  const catalog =
    config.provider === "deepseek"
      ? deepseekProvider()
          .getModels()
          .find((model) => model.id === config.model)
      : undefined;
  const model: Model<"openai-completions"> = {
    ...(catalog ?? {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "openai-compatible",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    baseUrl: config.endpoint,
    id: config.model,
    cost: config.prices ??
      catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    model,
    costKnown:
      config.prices !== null ||
      (catalog !== undefined && config.endpoint === catalog.baseUrl),
  };
}
export function createPiClient(
  config: ModelConfig,
  apiKey: string,
  fetcher?: typeof fetch,
  onMetrics?: (metrics: Metrics) => void,
): ModelClient {
  const { model, costKnown } = resolveModel(config);
  return {
    async complete(system, prompt, signal, onText) {
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
          maxTokens: config.maxOutputTokens,
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
      );
      onMetrics?.(metrics);
      if (final.stopReason === "error" || final.stopReason === "aborted")
        throw new ModelFailure(
          final.stopReason === "aborted"
            ? "Request cancelled or timed out"
            : "Model request failed; check credentials, endpoint and provider availability",
          metrics,
        );
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
