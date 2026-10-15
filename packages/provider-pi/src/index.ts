import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Metrics, PricingSnapshot } from "@lingo-sofa/protocol";
import { priceUsage } from "./pricing.js";
export { resolvePricing, priceUsage } from "./pricing.js";
export function measure(
  message: AssistantMessage,
  elapsed: number,
  first: number | null,
  firstText: number | null,
  last: number | null,
  chunks: number,
  costKnown: boolean,
  pricing?: PricingSnapshot,
): Metrics {
  const generationMs =
    first !== null && last !== null && chunks > 1 && last > first
      ? last - first
      : null;
  return {
    usage:
      message.usage.totalTokens > 0
        ? pricing
          ? priceUsage(message.usage, pricing)
          : message.usage
        : null,
    costKnown,
    ...(pricing ? { pricing } : {}),
    durationMs: message.durationMs ?? elapsed,
    firstOutputMs: first,
    firstTextMs: firstText,
    generationMs,
    tps:
      generationMs === null || message.usage.totalTokens === 0
        ? null
        : message.usage.output / (generationMs / 1_000),
  };
}

export function failureMessage(message: AssistantMessage): string {
  if (
    /\b503\b|service_unavailable|service.is.too.busy/i.test(
      message.errorMessage ?? "",
    )
  )
    return "Provider service unavailable (503); retry later. No automatic retry was sent.";
  if (
    /\b402\b|insufficient.(?:balance|quota|credit)|quota.exceeded|余额不足/i.test(
      message.errorMessage ?? "",
    )
  )
    return "Provider balance or quota is insufficient; check your provider account.";
  if (/\b429\b|rate.?limit|too many requests/i.test(message.errorMessage ?? ""))
    return "Provider rate limit (429); retry later. Reset time unavailable.";
  return message.stopReason === "aborted"
    ? "Request cancelled or timed out"
    : "Model request failed; check credentials, endpoint and provider availability";
}

export {
  capabilities,
  discoverCapabilities,
  outputAllocation,
  type ModelCapabilities,
} from "./capabilities.js";
