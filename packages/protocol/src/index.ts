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
  .array(z.strictObject({ id: z.string(), text }))
  .min(1)
  .max(16);
export const modelConfigSchema = z.strictObject({
  provider: z.enum(["deepseek", "openai-compatible"]),
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
  prices: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .nullable()
    .default(null),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const settingsSchema = z.strictObject({
  targetLanguage: z.string().min(1).max(64).default("简体中文"),
  mode: z.enum(["direct", "bridge"]).default("direct"),
  model: modelConfigSchema.default({
    provider: "deepseek",
    model: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
    maxOutputTokens: 2_048,
    timeoutMs: 30_000,
    prices: null,
  }),
  autoOrigins: z.array(z.url()).max(100).default([]),
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
  reasoning?: number;
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
      results?: TranslationResult[];
      text?: string;
      metrics?: Metrics;
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
