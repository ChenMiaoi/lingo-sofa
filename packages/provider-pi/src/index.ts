import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Metrics } from "@lingo-sofa/protocol";
export function measure(
  message: AssistantMessage,
  elapsed: number,
  first: number | null,
  firstText: number | null,
  last: number | null,
  chunks: number,
  costKnown: boolean,
): Metrics {
  const generationMs =
    first !== null && last !== null && chunks > 1 && last > first
      ? last - first
      : null;
  return {
    usage: message.usage.totalTokens > 0 ? message.usage : null,
    costKnown,
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
  if (/\b429\b|rate.?limit|too many requests/i.test(message.errorMessage ?? ""))
    return "Provider rate limit (429); retry later. Reset time unavailable.";
  return message.stopReason === "aborted"
    ? "Request cancelled or timed out"
    : "Model request failed; check credentials, endpoint and provider availability";
}
