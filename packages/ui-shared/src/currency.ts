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
  return cny > 0 && cny < 0.000001 ? "≈ < ¥0.000001" : `≈ ¥${cny.toFixed(6)}`;
}
export function formatExchangeRate(): string {
  return `人民币展示按汇率快照折算：1 USD = ${usdCnySnapshot.rate} CNY（${usdCnySnapshot.date}，${usdCnySnapshot.source}）。非实时牌价；美元记账与预算不变。来源：${usdCnySnapshot.sourceUrl}`;
}
