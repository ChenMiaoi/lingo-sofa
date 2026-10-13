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
      generationMs === null
        ? null
        : message.usage.output / (generationMs / 1_000),
  };
}
