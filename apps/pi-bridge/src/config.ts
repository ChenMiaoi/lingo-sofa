import { z } from "zod";
export {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_KEY,
} from "@lingo-sofa/protocol";
import {
  settingsSchema,
  requestSchema,
  providerUpdateSchema,
  oauthRequestSchema,
  accountImportSchema,
} from "@lingo-sofa/protocol";
export const bridgeConfigSchema = z.strictObject({
  port: z.number().int().min(1_024).max(65_535).default(43_187),
  settings: settingsSchema.default(settingsSchema.parse({ mode: "bridge" })),
  allowedExtensions: z
    .array(z.string().regex(/^[a-p]{32}$/))
    .max(10)
    .default([]),
  shareUsage: z.boolean().default(false),
  shareBudget: z.boolean().default(false),
  usePiAuth: z.boolean().default(false),
  piAuthPath: z.string().min(1).optional(),
});
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export const bridgeEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().min(1).max(512),
  sourceKind: z.enum(["web", "discord"]),
  request: requestSchema,
});

export const nativeProviderEnvelopeSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("balance"),
  }),
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("import-accounts"),
    migration: accountImportSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("runtime-status"),
  }),
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("oauth"),
    request: oauthRequestSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("provider"),
  }),
  z.strictObject({
    version: z.literal(1),
    sourceKind: z.literal("web"),
    scope: z.literal("browser"),
    operation: z.literal("provider-update"),
    update: providerUpdateSchema,
  }),
]);
