import { z } from "zod";
export {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_KEY,
} from "./browser-identity.js";

export const PROTOCOL_VERSION = 1;
export const runtimeStatusSchema = z.object({
  version: z.literal(1),
  instanceId: z.uuid(),
  clients: z.number().int().nonnegative(),
  appVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
});
export const assistantConnectionSchema = z.strictObject({
  connected: z.boolean(),
  installed: z.boolean().nullable(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
});
const text = z.string().trim().min(1);
export const translationUnitSchema = z.strictObject({
  id: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
  sourceKind: z.enum(["web", "discord"]),
  text,
  targetLanguage: z.string().min(1).max(64),
  context: z.string().optional(),
  protectedParts: z.array(z.string().min(1)).max(100).default([]),
});
export type TranslationUnit = z.infer<typeof translationUnitSchema>;
export const translationOutputSchema = z
  .array(
    z.strictObject({
      id: z.string(),
      text,
      // Some models echo this input metadata; it is never part of the result.
      targetLanguage: z.string().min(1).max(64).optional(),
      context: z.string().optional(),
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
export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const modelConfigSchema = z.strictObject({
  accountId: z.uuid().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  authMode: z.enum(["api_key", "subscription"]).default("api_key"),
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
  // Zero selects automatic allocation within the provider's published limits.
  maxOutputTokens: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  capabilities: z
    .strictObject({
      modelId: z.string().min(1),
      contextWindow: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      maxInputTokens: z.number().int().positive().optional(),
      source: z.enum(["official", "provider", "catalog"]),
      sourceUrl: z.url().optional(),
      updatedAt: z.iso.date().optional(),
    })
    .optional(),
  timeoutMs: z.number().int().min(1_000).max(45_000).default(30_000),
  prices: pricesSchema.nullable().default(null),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const providerAccountSchema = z.strictObject({
  keyConfigured: z.boolean().optional(),
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  model: modelConfigSchema,
});
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export const storedAccountSchema = providerAccountSchema.extend({
  apiKey: z.string().min(1).max(4096).optional(),
});
export type StoredAccount = z.infer<typeof storedAccountSchema>;
export const translationEngineSchema = z.enum(["bing", "google", "llm"]);
export type TranslationEngine = z.infer<typeof translationEngineSchema>;
export function resolveTranslationEngine(
  selected: TranslationEngine | undefined,
  authenticated: boolean,
): TranslationEngine {
  return selected ?? (authenticated ? "llm" : "bing");
}
export const accountStateSchema = z.strictObject({
  translationEngine: translationEngineSchema.optional(),
  accounts: z.array(storedAccountSchema).max(100),
  translation: modelConfigSchema,
  ask: modelConfigSchema,
});
export type AccountState = z.infer<typeof accountStateSchema>;
export function accountMatches(
  account: ProviderAccount,
  model: ModelConfig,
): boolean {
  return (
    account.model.provider === model.provider &&
    account.model.endpoint === model.endpoint &&
    account.model.authMode === model.authMode
  );
}
export const settingsSchema = z.strictObject({
  translationEngine: translationEngineSchema.optional(),
  askModel: modelConfigSchema.optional(),
  targetLanguage: z.string().min(1).max(64).default("简体中文"),
  mode: z.enum(["direct", "bridge"]).default("bridge"),
  model: modelConfigSchema.default({
    authMode: "api_key",
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
    maxOutputTokens: 0,
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
  // Legacy budget fields are accepted for saved-config compatibility only; never enforced.
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
    model: modelConfigSchema.optional(),
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
  billingMode?: "api" | "subscription" | "free" | undefined;
  characters?: number | undefined;
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
  purpose?: "translation" | "ask" | "compaction" | undefined;
}
export interface TranslationBilling {
  billingMode?: "api" | "subscription" | "free" | undefined;
  characters?: number | undefined;
  source: "request" | "cache";
  batchSize: number;
  tokens: number | null;
  cost: number | null;
  pricing?: PricingSnapshot | undefined;
}
export interface TranslationResult {
  id: string;
  revision: string;
  text: string;
  billing?: TranslationBilling | undefined;
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
      usageSummary?: UsageSummary | undefined;
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
export interface TranslationEngineClient {
  translate(
    units: readonly TranslationUnit[],
    terms: readonly { source: string; target: string }[],
    signal: AbortSignal,
  ): Promise<{ results: TranslationResult[]; metrics: Metrics }>;
}

const count = z.number().int().nonnegative();
const money = z.number().nonnegative();
export const usageTotalsSchema = z.strictObject({
  requests: count,
  input: count,
  output: count,
  tokens: count,
  cost: money.nullable(),
  knownCost: money,
  unknown: count,
  unpriced: count,
});
export const usageSummarySchema = z.strictObject({
  totals: usageTotalsSchema,
  models: z.array(
    usageTotalsSchema.extend({ provider: z.string(), model: z.string() }),
  ),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
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
  billingMode: z.enum(["api", "subscription", "free"]).optional(),
  characters: count.optional(),
  usage: usageSchema.nullable(),
  costKnown: z.boolean(),
  durationMs: z.number().nonnegative(),
  firstOutputMs: z.number().nonnegative().nullable(),
  firstTextMs: z.number().nonnegative().nullable(),
  generationMs: z.number().nonnegative().nullable(),
  tps: z.number().nonnegative().nullable(),
  pricing: pricingSnapshotSchema.optional(),
});
export const translationBillingSchema = z
  .strictObject({
    billingMode: z.enum(["api", "subscription", "free"]).optional(),
    characters: count.optional(),
    source: z.enum(["request", "cache"]),
    batchSize: z.number().int().min(1).max(16),
    tokens: count.nullable(),
    cost: money.nullable(),
    pricing: pricingSnapshotSchema.optional(),
  })
  .refine(
    (value) =>
      value.source !== "cache" ||
      (value.tokens === 0 && value.cost === 0 && value.batchSize === 1),
    "Cache hits cannot carry new charges",
  );
export const usageRecordSchema = metricsSchema.extend({
  purpose: z.enum(["translation", "ask", "compaction"]).optional(),
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
          billing: translationBillingSchema.optional(),
        }),
      )
      .max(16)
      .optional(),
    text: z.string().max(64_000).optional(),
    metrics: metricsSchema.optional(),
    usage: z.array(usageRecordSchema).max(10_000).optional(),
    usageSummary: usageSummarySchema.optional(),
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

export const modelUpdateSchema = z.strictObject({
  target: z
    .enum(["translation", "ask-default", "account", "remove-account"])
    .optional(),
  accountName: z.string().trim().min(1).max(100).optional(),
  newAccount: z.boolean().optional(),
  model: modelConfigSchema,
  apiKey: z.string().trim().min(1).max(4096).optional(),
});
export const providerUpdateSchema = z.union([
  z.strictObject({
    target: z.literal("translation-engine"),
    engine: translationEngineSchema,
  }),
  modelUpdateSchema,
]);
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export const oauthRequestSchema = z.strictObject({
  action: z.enum(["start", "status", "cancel", "logout"]),
});
export const oauthStatusSchema = z.strictObject({
  connected: z.boolean(),
  phase: z.enum(["idle", "pending", "failed"]),
  authorizationUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.origin === "https://auth.openai.com" &&
        url.pathname === "/api/accounts/authorize"
      );
    })
    .optional(),
  error: z.string().max(500).optional(),
});
export type OAuthStatus = z.infer<typeof oauthStatusSchema>;
export const providerCatalogSchema = z.strictObject({
  translationEngine: translationEngineSchema.optional(),
  accounts: z.array(providerAccountSchema).default([]),
  askModel: modelConfigSchema.optional(),
  oauth: oauthStatusSchema.optional(),
  capabilities: modelConfigSchema.shape.capabilities,
  model: modelConfigSchema,
  keyConfigured: z.boolean(),
  piAuth: z.boolean(),
  providers: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      models: z.array(
        z.strictObject({
          id: z.string(),
          endpoint: z.string(),
          api: z.string(),
          thinkingLevels: z.array(thinkingLevelSchema).default([]),
        }),
      ),
    }),
  ),
});
export type ProviderCatalog = z.infer<typeof providerCatalogSchema>;
