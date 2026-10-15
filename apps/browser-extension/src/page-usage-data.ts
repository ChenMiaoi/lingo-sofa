import type { UsageRecord, UsageSummary } from "@lingo-sofa/protocol";
import {
  mergeUsageSummaries,
  summarizeModels,
} from "@lingo-sofa/translation-core";

export interface PageUsageSnapshot extends UsageSummary {
  mode: "direct" | "bridge";
  coverage: "browser" | "all-clients";
}

/** Only aggregate numbers cross into content scripts, never request metadata. */
export function summarizeAvailableUsage(
  records: readonly UsageRecord[],
  mode: "direct" | "bridge",
  bridgeSummary?: UsageSummary,
): PageUsageSnapshot {
  if (mode === "bridge" && !bridgeSummary)
    throw new Error("请更新本地助手，以读取全部客户端的用量汇总。");
  const local = summarizeModels(
    records.filter((record) => record.mode === "direct"),
  );
  return {
    mode,
    coverage: bridgeSummary ? "all-clients" : "browser",
    ...mergeUsageSummaries(local, ...(bridgeSummary ? [bridgeSummary] : [])),
  };
}
