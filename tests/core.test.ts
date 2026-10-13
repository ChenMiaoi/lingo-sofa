import { describe, it, expect } from "vitest";
import {
  settingsSchema,
  translationUnitSchema,
  modelConfigSchema,
  requestSchema,
  type UsageRecord,
  type ModelClient,
} from "@lingo-sofa/protocol";
import {
  protect,
  restore,
  translate,
  cacheKey,
  TaskQueue,
  UsageLedger,
  summarize,
  period,
} from "@lingo-sofa/translation-core";
const unit = translationUnitSchema.parse({
  id: "one",
  revision: "1",
  sourceKind: "web",
  text: "Use `fetch` at https://example.com",
  targetLanguage: "中文",
});
const metrics = {
  usage: null,
  costKnown: false,
  durationMs: 20,
  firstOutputMs: null,
  firstTextMs: null,
  generationMs: null,
  tps: null,
};
function client(text: string): ModelClient {
  return { complete: async () => ({ text, metrics }) };
}
function record(id: string): UsageRecord {
  return {
    ...metrics,
    requestId: id,
    scope: "web:a",
    model: "m",
    provider: "p",
    mode: "direct",
    sourceKind: "web",
    status: "success",
    timestamp: Date.UTC(2026, 9, 14),
    costKnown: true,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 2,
      totalTokens: 37,
      reasoning: 3,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.001,
        cacheWrite: 0.001,
        total: 0.032,
      },
    },
  };
}
describe("translation protection and alignment", () => {
  it("preserves code, URLs and repeated protected DOM parts", () => {
    const original = "Read fetch fetch and `npm install` https://example.com";
    const content = protect(original, ["fetch"]);
    expect(restore(content.text, content)).toBe(original);
    expect(() =>
      restore(content.text.replace(/⟦LS:0⟧/, ""), content),
    ).toThrow();
  });
  it("rejects damaged, missing, duplicate and unexpected IDs", async () => {
    for (const output of [
      [{ id: "wrong", text: "你好" }],
      [],
      [
        { id: "one", text: "a" },
        { id: "one", text: "b" },
      ],
      [{ id: "one", text: "你好" }],
    ]) {
      await expect(
        translate(
          client(JSON.stringify(output)),
          [unit],
          [],
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });
  it("aligns out-of-order results and retains revision", async () => {
    const a = { ...unit, text: "Hello", id: "a" },
      b = { ...unit, text: "World", id: "b" };
    const result = await translate(
      client(
        JSON.stringify([
          { id: "b", text: "世界" },
          { id: "a", text: "你好" },
        ]),
      ),
      [a, b],
      [],
      new AbortController().signal,
    );
    expect(result.results).toEqual([
      { id: "a", revision: "1", text: "你好" },
      { id: "b", revision: "1", text: "世界" },
    ]);
    expect(cacheKey("web:a", a, "m", [])).not.toBe(
      cacheKey("discord:a", a, "m", []),
    );
    expect(cacheKey("web:a", a, "m", [])).not.toBe(
      cacheKey("web:a", a, "m2", []),
    );
  });
});
describe("bounded cancellable queue", () => {
  it("prioritizes pending manual work and limits concurrency", async () => {
    const queue = new TaskQueue<string>(1, 3);
    const order: string[] = [];
    let release!: (value: string) => void;
    const first = queue.submit(
      "first",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const auto = queue.submit("auto", async () => {
      order.push("auto");
      return "auto";
    });
    const manual = queue.submit(
      "manual",
      async () => {
        order.push("manual");
        return "manual";
      },
      10,
    );
    await expect(queue.submit("overflow", async () => "x")).rejects.toThrow(
      "full",
    );
    await Promise.resolve();
    release("first");
    await Promise.all([first, auto, manual]);
    expect(order).toEqual(["manual", "auto"]);
  });
  it("cancels active and queued requests without displaying late success", async () => {
    const queue = new TaskQueue<string>(1);
    let finish!: (value: string) => void;
    const first = queue.submit(
      "first",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const second = queue.submit("second", async () => "second");
    const failures = [
      expect(first).rejects.toThrow("cancelled"),
      expect(second).rejects.toThrow("cancelled"),
    ];
    await Promise.resolve();
    queue.clear();
    finish("late");
    await Promise.all(failures);
  });
});
describe("usage and budget accounting", () => {
  it("deduplicates snapshots and never adds reasoning twice", () => {
    const result = summarize([record("one"), record("one")]);
    expect(result).toMatchObject({
      requests: 1,
      input: 32,
      output: 5,
      tokens: 37,
      cost: 0.032,
    });
    expect(summarize([{ ...record("unknown"), usage: null }]).cost).toBeNull();
  });
  it("reserves concurrent spend and stops at the daily limit", () => {
    const ledger = new UsageLedger();
    const settings = settingsSchema.parse({ dailyTokens: 100 });
    const now = record("one").timestamp;
    ledger.reserve("one", 60, null, settings, now);
    expect(() => ledger.reserve("two", 60, null, settings, now)).toThrow(
      "budget",
    );
    ledger.settle(record("one"));
    ledger.reserve("two", 60, null, settings, now);
    expect(() => ledger.reserve("three", 4, null, settings, now)).toThrow(
      "budget",
    );
  });
  it("pauses strict budgets on unknown usage and calculates timezone boundaries", () => {
    const ledger = new UsageLedger();
    ledger.settle({ ...record("one"), usage: null });
    expect(() =>
      ledger.reserve(
        "two",
        10,
        null,
        settingsSchema.parse({ dailyTokens: 100 }),
        record("one").timestamp,
      ),
    ).toThrow("unknown");
    expect(period(Date.UTC(2026, 9, 13, 17), "Asia/Shanghai").day).toBe(
      "2026-10-14",
    );
  });
});
describe("request boundaries", () => {
  it("rejects arbitrary proxy fields and insecure remote endpoints", () => {
    expect(() =>
      requestSchema.parse({
        kind: "translate",
        requestId: crypto.randomUUID(),
        units: [unit],
        url: "https://attacker.test",
      }),
    ).toThrow();
    expect(() =>
      modelConfigSchema.parse({
        provider: "openai-compatible",
        model: "m",
        endpoint: "http://remote.test",
      }),
    ).toThrow();
  });
});
