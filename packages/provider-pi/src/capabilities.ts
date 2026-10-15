import type { ModelConfig } from "@lingo-sofa/protocol";
export interface ModelCapabilities {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxInputTokens?: number | undefined;
  source: "official" | "provider" | "catalog";
  sourceUrl?: string | undefined;
  updatedAt?: string | undefined;
}
/** Official capacity, not the output allocation of an individual request. */
export function capabilities(
  config: ModelConfig,
  catalog?: { contextWindow: number; maxTokens: number },
): ModelCapabilities | undefined {
  const declared = config.capabilities;
  const sameModel = declared?.modelId === config.model;
  const sameEndpoint =
    declared?.source !== "provider" ||
    declared.sourceUrl === `${config.endpoint.replace(/\/$/, "")}/models`;
  if (sameModel && sameEndpoint && declared?.source === "provider")
    return declared;
  if (
    config.provider === "deepseek" &&
    /^deepseek-(?:flash|v4-pro|v4-flash)$/.test(config.model)
  )
    return {
      modelId: config.model,
      contextWindow: 1048576,
      maxOutputTokens: 393216,
      source: "official",
      sourceUrl: "https://api-docs.deepseek.com/api/list-models/",
      updatedAt: "2026-10-14",
    };
  if (catalog && catalog.contextWindow > 0 && catalog.maxTokens > 0)
    return {
      modelId: config.model,
      contextWindow: catalog.contextWindow,
      maxOutputTokens: catalog.maxTokens,
      source: "catalog",
    };
  if (
    declared?.modelId !== config.model ||
    (declared.source === "provider" &&
      declared.sourceUrl !== `${config.endpoint.replace(/\/$/, "")}/models`)
  )
    return;
  return declared;
}
export async function discoverCapabilities(
  config: ModelConfig,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  refresh = false,
): Promise<ModelCapabilities> {
  const known = capabilities(config);
  if (known && !refresh) return known;
  const response = await fetcher(
    `${config.endpoint.replace(/\/$/, "")}/models`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  if (!response.ok)
    throw new Error("Provider model capabilities could not be loaded");
  const body = (await response.json()) as {
    data?: {
      id: string;
      context_window?: number;
      max_output_tokens?: number;
      max_input_tokens?: number;
    }[];
  };
  const model = Array.isArray(body.data)
    ? body.data.find((item) => item?.id === config.model)
    : undefined;
  if (
    !model ||
    !Number.isSafeInteger(model.context_window) ||
    !Number.isSafeInteger(model.max_output_tokens) ||
    model.context_window! <= 0 ||
    model.max_output_tokens! <= 0 ||
    (model.max_input_tokens !== undefined &&
      (!Number.isSafeInteger(model.max_input_tokens) ||
        model.max_input_tokens <= 0))
  )
    throw new Error(
      "Provider did not publish context/output limits; configure verified model capabilities instead of guessing",
    );
  return {
    modelId: config.model,
    contextWindow: model.context_window!,
    maxOutputTokens: model.max_output_tokens!,
    source: "provider",
    sourceUrl: `${config.endpoint.replace(/\/$/, "")}/models`,
    ...(model.max_input_tokens
      ? { maxInputTokens: model.max_input_tokens }
      : {}),
  };
}
/** Reserve output for this task from its size, bounded by provider capacity and available context. */
export function outputAllocation(
  config: ModelConfig,
  limits: ModelCapabilities,
  taskBytes: number,
  inputTokens: number,
): number {
  const requested = config.maxOutputTokens || Math.ceil(taskBytes * 2);
  const available = limits.contextWindow - inputTokens;
  if (
    (limits.maxInputTokens !== undefined &&
      inputTokens > limits.maxInputTokens) ||
    available <= 0
  )
    throw new Error("Model input/context capacity exceeded");
  const output = Math.min(requested, limits.maxOutputTokens, available);
  if (output <= 0) throw new Error("No model output capacity remains");
  return output;
}
