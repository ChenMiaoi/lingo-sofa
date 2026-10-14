import type { ModelConfig, PricingSnapshot, Usage } from "@lingo-sofa/protocol";

export const DEEPSEEK_PRICE_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing/";
export const PRICE_UPDATED_AT = "2026-10-14";
const calendarSource =
  "https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html";
const holidays2026 = [
  ["01-01", "01-03"],
  ["02-15", "02-23"],
  ["04-04", "04-06"],
  ["05-01", "05-05"],
  ["06-19", "06-21"],
  ["09-25", "09-27"],
  ["10-01", "10-07"],
];
const officialPrices: Record<string, NonNullable<ModelConfig["prices"]>> = {
  "deepseek-flash": {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.006,
    cacheWrite: 0,
  },
  "deepseek-v4-pro": {
    input: 1.32,
    output: 3.96,
    cacheRead: 0.044,
    cacheWrite: 0,
  },
};

export function resolvePricing(
  config: ModelConfig,
  catalog:
    { baseUrl: string; cost: NonNullable<ModelConfig["prices"]> } | undefined,
  sampledAt = Date.now(),
  conservative = false,
): PricingSnapshot {
  if (
    !Number.isSafeInteger(sampledAt) ||
    sampledAt < 0 ||
    !Number.isFinite(new Date(sampledAt).getTime())
  )
    throw new Error("Invalid pricing timestamp");
  if (config.prices !== null)
    return {
      source: "custom",
      period: "fixed",
      prices: { ...config.prices },
      sampledAt,
    };
  const prices =
    config.provider === "deepseek" &&
    config.endpoint === "https://api.deepseek.com" &&
    Object.hasOwn(officialPrices, config.model)
      ? officialPrices[config.model]
      : undefined;
  if (prices) {
    const date = new Date(sampledAt);
    // The schedule uses UTC hours/weekdays; Chinese holidays use their local civil date.
    const civil = new Date(sampledAt + 8 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    const calendarKnown = civil.startsWith("2026-");
    const holiday =
      calendarKnown &&
      holidays2026.some(
        ([from, to]) => civil.slice(5) >= from! && civil.slice(5) <= to!,
      );
    const weekday = date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
    const hour = date.getUTCHours();
    const peakWindow =
      weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const period =
      conservative || (peakWindow && !calendarKnown)
        ? "conservative"
        : peakWindow && !holiday
          ? "peak"
          : "off-peak";
    const factor = period === "off-peak" ? 0.5 : 1;
    return {
      source: "official",
      period,
      sampledAt,
      sourceUrl: DEEPSEEK_PRICE_SOURCE,
      updatedAt: PRICE_UPDATED_AT,
      calendarSourceUrl: calendarSource,
      ...(calendarKnown ? { calendarYear: 2026 } : {}),
      prices: {
        input: prices.input * factor,
        output: prices.output * factor,
        cacheRead: prices.cacheRead * factor,
        cacheWrite: prices.cacheWrite * factor,
      },
    };
  }
  if (catalog && config.endpoint === catalog.baseUrl)
    return {
      source: "catalog",
      period: "fixed",
      sampledAt,
      prices: { ...catalog.cost },
    };
  return { source: "unknown", period: "unknown", sampledAt, prices: null };
}

export function priceUsage(usage: Usage, pricing: PricingSnapshot): Usage {
  if (!pricing.prices) return usage;
  const cost = {
    input: (usage.input * pricing.prices.input) / 1_000_000,
    output: (usage.output * pricing.prices.output) / 1_000_000,
    cacheRead: (usage.cacheRead * pricing.prices.cacheRead) / 1_000_000,
    cacheWrite: (usage.cacheWrite * pricing.prices.cacheWrite) / 1_000_000,
  };
  return {
    ...usage,
    cost: {
      ...cost,
      total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
    },
  };
}
