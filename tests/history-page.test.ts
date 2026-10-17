import { describe, expect, it } from "vitest";
import { usageRecordSchema } from "@lingo-sofa/protocol";
import { historyPage } from "../apps/browser-extension/src/history-page.js";
const query = {
  offset: 0,
  range: "all",
  source: "",
  provider: "",
  model: "",
  scope: "",
  status: "",
};
const now = Date.UTC(2026, 9, 18, 2);
const records = Array.from({ length: 123 }, (_, i) =>
  usageRecordSchema.parse({
    requestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    scope: "web:site",
    provider: "deepseek",
    model: i % 2 ? "a" : "b",
    mode: "direct",
    sourceKind: "web",
    status: "success",
    timestamp: now - i * 1000,
    usage: null,
    costKnown: false,
    durationMs: 1,
    firstOutputMs: null,
    firstTextMs: null,
    generationMs: null,
    tps: null,
  }),
);
describe("history pagination", () => {
  it("bounds payloads, preserves global filters and clamps a pruned last page", () => {
    const first = historyPage(records, query, "UTC", now);
    expect(first.records).toHaveLength(50);
    expect(first.total).toBe(123);
    const next = historyPage(records, { ...query, offset: 50 }, "UTC", now);
    expect(next.records[0]?.requestId).toBe(records[50]!.requestId);
    const last = historyPage(records, { ...query, offset: 1000 }, "UTC", now);
    expect(last.offset).toBe(100);
    expect(last.records).toHaveLength(23);
    const filtered = historyPage(
      records,
      { ...query, model: "a", offset: 50 },
      "UTC",
      now,
    );
    expect(filtered.total).toBe(61);
    expect(filtered.records).toHaveLength(11);
    expect(filtered.models.sort()).toEqual(["a", "b"]);
  });
  it("uses the selected time zone and rejects invalid queries", () => {
    expect(
      historyPage(records, { ...query, range: "day" }, "UTC", now + 86400000)
        .total,
    ).toBe(0);
    expect(
      historyPage(records, { ...query, source: "discord" }, "UTC", now)
        .allCount,
    ).toBe(123);
    for (const offset of [-1, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        historyPage(records, { ...query, offset }, "UTC", now),
      ).toThrow();
    expect(historyPage([], query, "UTC", now)).toMatchObject({
      offset: 0,
      total: 0,
      records: [],
    });
  });
  it("reaches records beyond ten thousand and filters across local date boundaries", () => {
    const many = Array.from({ length: 12000 }, (_, index) => ({
      ...records[0]!,
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      timestamp: now - index * 1000,
    }));
    const page = historyPage(many, { ...query, offset: 10050 }, "UTC", now);
    expect(page.total).toBe(12000);
    expect(page.records[0]?.requestId).toBe(many[10050]!.requestId);
    expect(
      historyPage(
        many,
        { ...query, offset: Number.MAX_SAFE_INTEGER },
        "UTC",
        now,
      ).offset,
    ).toBe(11950);
    const boundary = [
      { ...records[0]!, timestamp: Date.UTC(2026, 9, 17, 23, 30) },
    ];
    expect(
      historyPage(boundary, { ...query, range: "day" }, "UTC", now).total,
    ).toBe(0);
    expect(
      historyPage(boundary, { ...query, range: "day" }, "Asia/Shanghai", now)
        .total,
    ).toBe(1);
    expect(
      historyPage(boundary, { ...query, range: "month" }, "UTC", now).total,
    ).toBe(1);
  });
});
