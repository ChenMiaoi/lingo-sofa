export function formatTokens(value: number | null): string {
  return value === null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
}
export { formatCost, formatExchangeRate, usdCnySnapshot } from "./currency.js";
export function formatSpeed(value: number | null): string {
  return value === null ? "不可用" : `${value.toFixed(1)} tokens/s`;
}
export { formatPricing } from "./pricing.js";
export {
  renderTranslationMarkdown,
  inlineTranslationStyle,
} from "./markdown.js";
export {
  formatTranslationBilling,
  appendTranslationBilling,
} from "./translation-billing.js";
