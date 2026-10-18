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
    /subscription_sharing_(?:usage_limit_exceeded|usage_unavailable)/i.test(
      message.errorMessage ?? "",
    )
  )
    return "ChatGPT 订阅额度暂不可用，请稍后重试或手动切换 API Key。";
  if (
    /subscription_sharing_invalid_user|invalid_grant/i.test(
      message.errorMessage ?? "",
    )
  )
    return "ChatGPT 登录已失效，请重新登录。";
  if (
    /\b401\b|invalid[_ -]?api[_ -]?key|incorrect api key|authentication fail(?:s|ed)/i.test(
      message.errorMessage ?? "",
    )
  )
    return "模型服务拒绝账户认证（401），请核对当前账户的 API Key、登录状态与服务地址。";
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
