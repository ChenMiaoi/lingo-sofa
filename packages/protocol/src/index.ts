import { z } from "zod";

export const PROTOCOL_VERSION = 1;
const text = z.string().trim().min(1).max(32_000);
export const translationUnitSchema = z.strictObject({
  id: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
  sourceKind: z.enum(["web", "discord"]),
  text,
  targetLanguage: z.string().min(1).max(64),
  context: z.string().max(16_000).optional(),
  protectedParts: z.array(z.string().min(1).max(4_000)).max(100).default([]),
});
export type TranslationUnit = z.infer<typeof translationUnitSchema>;
export const translationOutputSchema = z
  .array(
    z.strictObject({
      id: z.string(),
      text,
      // Some models echo this input metadata; it is never part of the result.
      targetLanguage: z.string().min(1).max(64).optional(),
      context: z.string().max(16_000).optional(),
    }),
  )
  .min(1)
  .max(16);
export const pricesSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});
const priceSourceUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:");
export const pricingSnapshotSchema = z.strictObject({
  source: z.enum(["official", "catalog", "custom", "unknown"]),
  period: z.enum(["peak", "off-peak", "conservative", "fixed", "unknown"]),
  prices: pricesSchema.nullable(),
  sampledAt: z.number().int().nonnegative(),
  sourceUrl: priceSourceUrl.optional(),
  updatedAt: z.iso.date().optional(),
  calendarSourceUrl: priceSourceUrl.optional(),
  calendarYear: z.number().int().optional(),
});
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
export const modelConfigSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  }, "Use HTTPS, or HTTP on loopback, without credentials or query parameters"),
  maxOutputTokens: z.number().int().min(128).max(8_192).default(2_048),
  timeoutMs: z.number().int().min(1_000).max(45_000).default(30_000),
  prices: pricesSchema.nullable().default(null),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const settingsSchema = z.strictObject({
  targetLanguage: z.string().min(1).max(64).default("简体中文"),
  mode: z.enum(["direct", "bridge"]).default("direct"),
  model: modelConfigSchema.default({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
    maxOutputTokens: 2_048,
    timeoutMs: 30_000,
    prices: null,
  }),
  autoOrigins: z
    .array(
      z.url().refine((value) => {
        const url = new URL(value);
        return (
          ["https:", "http:"].includes(url.protocol) && value === url.origin
        );
      }, "Automatic sites must be exact HTTP(S) origins"),
    )
    .max(100)
    .default([]),
  glossary: z
    .array(
      z.strictObject({
        source: z.string().min(1).max(100),
        target: z.string().min(1).max(100),
      }),
    )
    .max(200)
    .default([]),
  dailyTokens: z.number().int().positive().nullable().default(null),
  monthlyTokens: z.number().int().positive().nullable().default(null),
  dailyCost: z.number().positive().nullable().default(null),
  monthlyCost: z.number().positive().nullable().default(null),
  warningRatio: z.number().min(0.1).max(1).default(0.8),
  strictBudget: z.boolean().default(true),
  persistUsage: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(90).default(30),
  timeZone: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    })
    .default("Asia/Shanghai"),
});
export type Settings = z.infer<typeof settingsSchema>;
export const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("usage") }),
  z.strictObject({ kind: z.literal("clear-data") }),
  z.strictObject({
    kind: z.literal("translate"),
    requestId: z.uuid(),
    units: z.array(translationUnitSchema).min(1).max(16),
    automatic: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("ask"),
    requestId: z.uuid(),
    sessionId: z.string().min(1).max(128),
    question: text,
    context: z.string().max(24_000),
  }),
  z.strictObject({ kind: z.literal("cancel"), requestId: z.uuid() }),
  z.strictObject({
    kind: z.literal("clear-session"),
    sessionId: z.string().min(1).max(128),
  }),
]);
export type Request = z.infer<typeof requestSchema>;
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number | undefined;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
export interface Metrics {
  usage: Usage | null;
  costKnown: boolean;
  durationMs: number;
  firstOutputMs: number | null;
  firstTextMs: number | null;
  generationMs: number | null;
  tps: number | null;
  pricing?: PricingSnapshot | undefined;
}
export interface BudgetSnapshot {
  window: "day" | "month";
  metric: "tokens" | "cost";
  used: number | null;
  limit: number | null;
  ratio: number | null;
  warning: boolean;
}
export interface UsageRecord extends Metrics {
  requestId: string;
  scope: string;
  model: string;
  provider: string;
  sourceKind: "web" | "discord";
  mode: "direct" | "bridge";
  status: "success" | "failed" | "cancelled" | "unknown";
  timestamp: number;
  sessionId?: string | undefined;
}
export interface TranslationResult {
  id: string;
  revision: string;
  text: string;
}
export interface ModelReply {
  text: string;
  metrics: Metrics;
}
export type Reply =
  | {
      ok: true;
      results?: TranslationResult[] | undefined;
      text?: string | undefined;
      metrics?: Metrics | undefined;
      usage?: UsageRecord[] | undefined;
      sharedUsage?: boolean | undefined;
      shareBudget?: boolean | undefined;
      budgets?: BudgetSnapshot[] | undefined;
      queue?: { running: number; pending: number } | undefined;
      cacheStats?:
        { hits: number; lookups: number; ratio: number | null } | undefined;
      settings?: Settings | undefined;
      sessionStats?:
        { tokens: number; cost: number | null; messages: number } | undefined;
    }
  | { ok: false; error: string };
export interface ModelClient {
  complete(
    system: string,
    prompt: string,
    signal: AbortSignal,
    onText?: (text: string) => void,
  ): Promise<ModelReply>;
}

const count = z.number().int().nonnegative();
const money = z.number().nonnegative();
export const usageSchema = z.strictObject({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  totalTokens: count,
  reasoning: count.optional(),
  cost: z.strictObject({
    input: money,
    output: money,
    cacheRead: money,
    cacheWrite: money,
    total: money,
  }),
});
export const metricsSchema = z.strictObject({
  usage: usageSchema.nullable(),
  costKnown: z.boolean(),
  durationMs: z.number().nonnegative(),
  firstOutputMs: z.number().nonnegative().nullable(),
  firstTextMs: z.number().nonnegative().nullable(),
  generationMs: z.number().nonnegative().nullable(),
  tps: z.number().nonnegative().nullable(),
  pricing: pricingSnapshotSchema.optional(),
});
export const usageRecordSchema = metricsSchema.extend({
  requestId: z.uuid(),
  scope: z.string().max(1024),
  model: z.string().max(200),
  provider: z.string().max(100),
  sourceKind: z.enum(["web", "discord"]),
  mode: z.enum(["direct", "bridge"]),
  status: z.enum(["success", "failed", "cancelled", "unknown"]),
  timestamp: count,
  sessionId: z.string().min(1).max(128).optional(),
});
export const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    results: z
      .array(
        z.strictObject({
          id: z.string().max(128),
          revision: z.string().max(128),
          text: z.string().max(32_000),
        }),
      )
      .max(16)
      .optional(),
    text: z.string().max(64_000).optional(),
    metrics: metricsSchema.optional(),
    usage: z.array(usageRecordSchema).max(10_000).optional(),
    sharedUsage: z.boolean().optional(),
    shareBudget: z.boolean().optional(),
    budgets: z
      .array(
        z.strictObject({
          window: z.enum(["day", "month"]),
          metric: z.enum(["tokens", "cost"]),
          used: money.nullable(),
          limit: money.nullable(),
          ratio: money.nullable(),
          warning: z.boolean(),
        }),
      )
      .max(4)
      .optional(),
    cacheStats: z
      .strictObject({
        hits: count,
        lookups: count,
        ratio: z.number().min(0).max(1).nullable(),
      })
      .optional(),
    queue: z.strictObject({ running: count, pending: count }).optional(),
    settings: settingsSchema.optional(),
    sessionStats: z
      .strictObject({ tokens: count, cost: money.nullable(), messages: count })
      .optional(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(2_000) }),
]);
