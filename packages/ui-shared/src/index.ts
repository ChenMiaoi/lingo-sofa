export function formatTokens(value: number | null): string {
  return value === null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
}
export function formatCost(value: number | null): string {
  return value === null ? "未知" : `≈ $${value.toFixed(5)}`;
}
export function formatSpeed(value: number | null): string {
  return value === null ? "不可用" : `${value.toFixed(1)} tokens/s`;
}
import type { PricingSnapshot } from "@lingo-sofa/protocol";

export function formatPricing(pricing?: PricingSnapshot): string {
  if (!pricing) return "历史记录未保存价格来源";
  const source = {
    official: "官方价格",
    catalog: "Pi 模型目录",
    custom: "用户单价",
    unknown: "价格未知",
  }[pricing.source];
  const period = {
    peak: "峰时",
    "off-peak": "谷时",
    conservative: "峰时上限（保守）",
    fixed: "固定单价",
    unknown: "未知",
  }[pricing.period];
  return `${source} · ${period}${pricing.updatedAt ? ` · 更新/核对 ${pricing.updatedAt}` : " · 更新时间未提供"}`;
}
