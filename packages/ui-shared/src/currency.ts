import type { UsageSummary } from "@lingo-sofa/protocol";

/** Verified SAFE midpoint snapshot: quoted CNY per 100 USD, not a live bank rate. */
export const usdCnySnapshot = Object.freeze({
  rate: 6.7249,
  date: "2026-10-14",
  source: "国家外汇管理局人民币汇率中间价",
  sourceUrl: "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do",
});
export function formatCost(usd: number | null): string {
  if (usd === null) return "未知";
  const cny = usd * usdCnySnapshot.rate;
  return cny > 0 && cny < 0.000001 ? "< ¥0.000001" : `¥${cny.toFixed(6)}`;
}
export function formatUsageBilling(
  summary: Pick<
    UsageSummary["totals"],
    "cost" | "knownCost" | "requests" | "unknown" | "unpriced"
  >,
): { amount: string; pending: string } {
  const pending = summary.unknown + summary.unpriced;
  // Unmetered requests remain pending without hiding charges already recorded.
  const cost =
    summary.cost ?? (summary.requests > pending ? summary.knownCost : null);
  return {
    amount: cost === null ? "待计费" : formatCost(cost),
    pending: pending
      ? `待计费 ${pending} 次（${summary.unknown} 次缺少用量，${summary.unpriced} 次缺少单价），补齐后计入累计费用。`
      : "",
  };
}
export function formatExchangeRate(): string {
  return `人民币按汇率快照换算：1 USD = ${usdCnySnapshot.rate} CNY（${usdCnySnapshot.date}，${usdCnySnapshot.source}）。来源：${usdCnySnapshot.sourceUrl}`;
}
