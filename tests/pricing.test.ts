import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelConfigSchema, metricsSchema } from "@lingo-sofa/protocol";
import { resolveModel, createPiClient } from "@lingo-sofa/provider-pi/browser";
import {
  createPiClient as createNodeClient,
  resolveModel as resolveNodeModel,
} from "@lingo-sofa/provider-pi/node";
import { priceUsage, resolvePricing } from "@lingo-sofa/provider-pi";
import { formatPricing } from "@lingo-sofa/ui-shared";
import { SafePiSessions } from "../apps/pi-bridge/src/sdk.js";
import { modelServer } from "./fixtures/model-server.js";

const config = modelConfigSchema.parse({
  provider: "deepseek",
  model: "deepseek-flash",
  endpoint: "https://api.deepseek.com",
});
const snapshot = (date: string) =>
  resolveModel(config, Date.parse(date)).pricing;
afterEach(() => vi.restoreAllMocks());

it.each([
  ["2026-10-14T00:59:59.999Z", "off-peak"],
  ["2026-10-14T01:00:00.000Z", "peak"],
  ["2026-10-14T03:59:59.999Z", "peak"],
  ["2026-10-14T04:00:00.000Z", "off-peak"],
  ["2026-10-14T05:59:59.999Z", "off-peak"],
  ["2026-10-14T06:00:00.000Z", "peak"],
  ["2026-10-14T09:59:59.999Z", "peak"],
  ["2026-10-14T10:00:00.000Z", "off-peak"],
  ["2026-10-10T02:00:00.000Z", "off-peak"], // Saturday make-up workday stays off-peak.
  ["2026-10-11T02:00:00.000Z", "off-peak"],
  ["2026-01-01T02:00:00.000Z", "off-peak"],
  ["2026-02-23T02:00:00.000Z", "off-peak"],
  ["2026-04-06T02:00:00.000Z", "off-peak"],
  ["2026-05-05T02:00:00.000Z", "off-peak"],
  ["2026-06-19T02:00:00.000Z", "off-peak"],
  ["2026-09-25T02:00:00.000Z", "off-peak"],
  ["2026-10-07T02:00:00.000Z", "off-peak"],
  ["2026-10-08T02:00:00.000Z", "peak"],
  ["2027-01-01T02:00:00.000Z", "conservative"],
  ["2027-01-01T12:00:00.000Z", "off-peak"],
  ["2025-12-31T17:00:00.000Z", "off-peak"],
])("uses the official time/calendar rule at %s", (date, period) => {
  const at = Date.parse(date);
  const resolved = resolveModel(config, at);
  expect(resolved.pricing.period).toBe(period);
  expect(resolved.model.cost.input).toBe(period === "off-peak" ? 0.15 : 0.3);
  expect(resolveNodeModel(config, at).pricing).toEqual(resolved.pricing);
});

it("preserves provenance and reserves peak prices even in off-peak hours", () => {
  const price = snapshot("2026-10-14T12:00:00Z");
  expect(price).toMatchObject({
    source: "official",
    updatedAt: "2026-10-14",
    calendarYear: 2026,
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    prices: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  });
  expect(formatPricing(price)).toContain("谷时");
  expect(formatPricing(price)).toContain("2026-10-14");
  const upper = resolveModel(config, price.sampledAt, true).pricing;
  expect(upper).toMatchObject({
    period: "conservative",
    prices: { output: 1.2 },
  });
  const pro = resolveModel(
    { ...config, model: "deepseek-v4-pro" },
    price.sampledAt,
  );
  expect(pro.model.cost).toEqual({
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWrite: 0,
  });
});

it("honors custom prices and treats alternate endpoints as unknown", () => {
  const custom = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 };
  expect(resolveModel({ ...config, prices: custom }, 0).pricing).toMatchObject({
    source: "custom",
    period: "fixed",
    prices: custom,
  });
  expect(
    resolveModel({ ...config, endpoint: "https://proxy.example" }, 0),
  ).toMatchObject({
    costKnown: false,
    pricing: { source: "unknown", prices: null },
  });
  expect(
    resolvePricing(
      { ...config, provider: "other" },
      { baseUrl: config.endpoint, cost: custom },
      0,
    ),
  ).toMatchObject({ source: "catalog", prices: custom });
  expect(resolveModel({ ...config, model: "__proto__" }, 0).costKnown).toBe(
    false,
  );
  expect(() => resolvePricing(config, undefined, NaN)).toThrow("timestamp");
});

it("prices mutually exclusive usage buckets without counting reasoning twice or mutating Pi data", () => {
  const usage = {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    totalTokens: 3_000_000,
    reasoning: 100_000,
    cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 0, total: 297 },
  };
  const peak = priceUsage(usage, snapshot("2026-10-14T02:00:00Z"));
  const off = priceUsage(usage, snapshot("2026-10-14T12:00:00Z"));
  expect(peak.cost.total).toBeCloseTo(1.506);
  expect(off.cost.total).toBeCloseTo(0.753);
  expect(usage.cost.total).toBe(297);
  expect(peak.reasoning).toBe(100_000);
  expect(
    priceUsage(
      usage,
      resolvePricing(
        { ...config, endpoint: "https://proxy.example" },
        undefined,
        0,
      ),
    ),
  ).toBe(usage);
});

it("takes a new snapshot for every browser call and freezes it across a price boundary", async () => {
  const server = await modelServer();
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-10-14T00:59:59Z"));
  const client = createPiClient(
    config,
    "fixture-key",
    async (_url, options) => {
      now.mockReturnValue(Date.parse("2026-10-14T01:00:01Z"));
      return fetch(server.endpoint, options);
    },
  );
  try {
    const first = await client.complete(
      "system",
      "hello",
      new AbortController().signal,
    );
    expect(first.metrics.pricing?.period).toBe("off-peak");
    expect(first.metrics.usage?.cost.total).toBeCloseTo(0.00000906, 10);
    const second = await client.complete(
      "system",
      "hello",
      new AbortController().signal,
    );
    expect(second.metrics.pricing?.period).toBe("peak");
    expect(second.metrics.usage?.cost.total).toBeCloseTo(0.00001812, 10);
    expect(metricsSchema.parse(first.metrics).pricing).toEqual(
      first.metrics.pricing,
    );
    expect(first.metrics.pricing?.period).toBe("off-peak");
  } finally {
    await server.close();
  }
});

it("recalculates Node and Pi SDK session totals across peak/off-peak turns", async () => {
  const server = await modelServer();
  const directory = await mkdtemp(join(tmpdir(), "lingo-pricing-"));
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) =>
    originalFetch(server.endpoint, options),
  );
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
  const sessions = new SafePiSessions(config, "fixture-key", directory);
  try {
    const first = await sessions.ask(
      "scope",
      "Hello",
      "Context",
      new AbortController().signal,
      () => {},
    );
    expect(first.metrics.pricing?.period).toBe("off-peak");
    expect(sessions.stats("scope")?.cost).toBeCloseTo(0.00000906, 10);
    now.mockReturnValue(Date.parse("2026-10-14T01:00:01Z"));
    const second = await sessions.ask(
      "scope",
      "Again",
      "Context",
      new AbortController().signal,
      () => {},
    );
    expect(second.metrics.pricing?.period).toBe("peak");
    expect(sessions.stats("scope")?.cost).toBeCloseTo(0.00002718, 10);
    expect(sessions.stats("scope")?.tokens.total).toBe(88);
    const translated = await createNodeClient(
      config,
      await sessions.runtime(),
    ).complete("system", "hello", new AbortController().signal);
    expect(translated.metrics.pricing?.period).toBe("peak");
    expect(translated.metrics.usage?.cost.total).toBeCloseTo(0.00001812, 10);
    sessions.clear("scope");
    expect(sessions.stats("scope")).toBeUndefined();
  } finally {
    sessions.dispose();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
