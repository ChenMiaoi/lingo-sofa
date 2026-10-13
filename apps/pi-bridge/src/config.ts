import { z } from "zod";
import { settingsSchema, requestSchema } from "@lingo-sofa/protocol";
export const bridgeConfigSchema = z.strictObject({
  port: z.number().int().min(1_024).max(65_535).default(43_187),
  settings: settingsSchema.default(settingsSchema.parse({ mode: "bridge" })),
  allowedExtensions: z
    .array(z.string().regex(/^[a-p]{32}$/))
    .max(10)
    .default([]),
  shareUsage: z.boolean().default(false),
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
