export function formatTokens(value: number | null): string {
  return value === null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
}
export function formatCost(value: number | null): string {
  return value === null ? "未知" : `≈ $${value.toFixed(5)}`;
}
export function formatSpeed(value: number | null): string {
  return value === null ? "不可用" : `${value.toFixed(1)} tokens/s`;
}
