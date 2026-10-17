import { describe, expect, it } from "vitest";
import {
  summarizeModels,
  mergeUsageSummaries,
  apiCost,
} from "@lingo-sofa/translation-core";
import { usageRecordSchema, usageSummarySchema } from "@lingo-sofa/protocol";
import { summarizeAvailableUsage } from "../apps/browser-extension/src/page-usage-data.js";
import { formatUsageBilling } from "@lingo-sofa/ui-shared";

const scope = "web:12:https://example.test:document:page-digest";
const record = usageRecordSchema.parse({
  requestId: crypto.randomUUID(),
  scope,
  model: "fixture",
  provider: "deepseek",
  sourceKind: "web",
  mode: "direct",
  status: "success",
  timestamp: 1,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 17,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.003,
    },
  },
  costKnown: true,
  durationMs: 2000,
  generationMs: 1000,
  firstTextMs: 1000,
  firstOutputMs: 1000,
  tps: 5,
});
describe("all-client model usage", () => {
  it("merges every page and client by provider/model without exposing request metadata", () => {
    const discord = {
      ...record,
      requestId: crypto.randomUUID(),
      mode: "bridge" as const,
      sourceKind: "discord" as const,
      scope: "private-channel",
    };
    const otherPage = {
      ...record,
      requestId: crypto.randomUUID(),
      scope: "other-page",
    };
    const otherModel = {
      ...discord,
      requestId: crypto.randomUUID(),
      model: "other-model",
    };
    const result = summarizeAvailableUsage(
      [record, record, otherPage, discord],
      "bridge",
      summarizeModels([discord, otherModel]),
    );
    expect(result.totals).toMatchObject({
      requests: 4,
      input: 48,
      output: 20,
      tokens: 68,
      cost: 0.012,
    });
    expect(result.models).toHaveLength(2);
    expect(
      result.models.find((model) => model.model === "fixture"),
    ).toMatchObject({ requests: 3, tokens: 51 });
    expect(
      result.models.find((model) => model.model === "fixture")!.cost,
    ).toBeCloseTo(0.009);
    expect(result.coverage).toBe("all-clients");
    expect(JSON.stringify(result)).not.toContain("private-channel");
    expect(JSON.stringify(result)).not.toContain("requestId");
    expect(
      usageSummarySchema.parse({
        totals: result.totals,
        models: result.models,
      }),
    ).toBeTruthy();
  });
  it("uses each request's API price snapshot and preserves unknown/partial cost", () => {
    const priced = {
      ...record,
      costKnown: false,
      pricing: {
        source: "official" as const,
        period: "fixed" as const,
        sampledAt: 0,
        prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      },
    };
    expect(apiCost(priced)).toBeCloseTo(0.0000202);
    const summary = summarizeModels([
      priced,
      priced,
      { ...record, requestId: crypto.randomUUID(), costKnown: false },
      {
        ...record,
        requestId: crypto.randomUUID(),
        usage: null,
        costKnown: false,
      },
    ]);
    expect(summary.totals).toMatchObject({
      requests: 3,
      tokens: 34,
      cost: null,
      unknown: 1,
      unpriced: 1,
    });
    expect(summary.totals.knownCost).toBeCloseTo(0.0000202);
    expect(formatUsageBilling(summary.totals)).toEqual({
      amount: "¥0.000136",
      pending:
        "待计费 2 次（1 次缺少用量，1 次缺少单价），补齐后计入累计费用。",
    });
    expect(summary.totals.cost).toBeNull();
    expect(priced.usage!.cost.total).toBe(0.003);
    expect(mergeUsageSummaries(summarizeModels([]), summary)).toEqual(summary);
  });
  it("distinguishes pending billing from priced zero and an empty ledger", () => {
    const pending = summarizeModels([
      { ...record, usage: null, costKnown: false },
    ]);
    expect(formatUsageBilling(pending.totals).amount).toBe("待计费");
    expect(
      formatUsageBilling(
        summarizeModels([{ ...record, costKnown: false }]).totals,
      ).amount,
    ).toBe("待计费");
    const zero = {
      ...record,
      requestId: crypto.randomUUID(),
      usage: {
        ...record.usage!,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    expect(
      formatUsageBilling(
        summarizeModels([zero, { ...record, usage: null, costKnown: false }])
          .totals,
      ).amount,
    ).toBe("¥0.000000");
    expect(formatUsageBilling(summarizeModels([]).totals)).toEqual({
      amount: "¥0.000000",
      pending: "",
    });
  });
  it("keeps providers distinct and reports an old assistant instead of claiming a complete total", () => {
    expect(
      summarizeModels([
        record,
        { ...record, requestId: crypto.randomUUID(), provider: "other" },
      ]).models,
    ).toHaveLength(2);
    expect(() => summarizeAvailableUsage([record], "bridge")).toThrow(
      "更新本地助手",
    );
    expect(summarizeAvailableUsage([], "direct")).toMatchObject({
      coverage: "browser",
      totals: { requests: 0, tokens: 0, cost: 0, knownCost: 0 },
    });
  });
});
