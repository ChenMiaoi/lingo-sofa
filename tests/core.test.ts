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
  it("accepts a single JSON fence while rejecting commentary, malformed output and extra fields", async () => {
    const plain = JSON.stringify([{ id: "one", text: "你好" }]);
    const fenced = "```json\n" + plain + "\n```";
    const units = [{ ...unit, text: "Hello", protectedParts: [] }];
    for (const text of [
      plain,
      "\n" + fenced + "\n",
      "```\r\n" + plain + "\r\n```",
    ]) {
      const result = await translate(
        client(text),
        units,
        [],
        new AbortController().signal,
      );
      expect(result.results[0]?.text).toBe("你好");
    }
    for (const text of [
      "Explanation\n" + fenced,
      "```json\nnot json\n```",
      '```json\n[{"id":"one","text":"你好","unexpected":"value"}]\n```',
    ])
      await expect(
        translate(client(text), units, [], new AbortController().signal),
      ).rejects.toThrow();
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
  it("accepts echoed input metadata while returning only aligned translation fields", async () => {
    const result = await translate(
      {
        complete: async (_system, input) => {
          const items = JSON.parse(input) as {
            id: string;
            text: string;
            targetLanguage: string;
            context: string;
          }[];
          return {
            text: JSON.stringify(
              items.map((item) => ({
                id: item.id,
                text: item.text,
                targetLanguage: item.targetLanguage,
                context: item.context,
              })),
            ),
            metrics,
          };
        },
      },
      [unit],
      [],
      new AbortController().signal,
    );
    expect(result.results).toEqual([
      { id: unit.id, revision: unit.revision, text: unit.text },
    ]);
    expect(result.results[0]).not.toHaveProperty("targetLanguage");
    expect(result.results[0]).not.toHaveProperty("context");
  });
  it("continues rejecting arbitrary result fields and malformed echoed metadata", async () => {
    for (const extra of [
      { confidence: 1 },
      { targetLanguage: 123 },
      { targetLanguage: "x".repeat(65) },
      { context: 123 },
      { context: [] },
    ]) {
      await expect(
        translate(
          client(
            JSON.stringify([
              { id: unit.id, text: protect(unit.text).text, ...extra },
            ]),
          ),
          [unit],
          [],
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });
});
it("does not mistake transport string lengths for a model context/output ceiling", async () => {
  const longContext = "reference ".repeat(2000);
  const result = await translate(
    client(
      JSON.stringify([
        { id: "large", text: "译".repeat(33000), context: longContext },
      ]),
    ),
    [
      {
        ...unit,
        id: "large",
        text: "Hello",
        context: longContext,
        protectedParts: [],
      },
    ],
    [],
    new AbortController().signal,
  );
  expect(result.results[0]!.text.length).toBe(33000);
  expect(result.results[0]).not.toHaveProperty("context");
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
describe("usage accounting", () => {
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
  it("tracks concurrent requests without a local spend ceiling and prevents duplicate accounting", () => {
    const ledger = new UsageLedger();
    ledger.begin("one");
    ledger.begin("two");
    expect(() => ledger.begin("one")).toThrow("already accounted");
    ledger.settle(record("one"));
    expect(() => ledger.begin("one")).toThrow("already accounted");
    ledger.release("two");
    ledger.begin("two");
    expect(ledger.list()).toHaveLength(1);
  });
  it("preserves unknown consumption without blocking new requests and calculates timezone boundaries", () => {
    const ledger = new UsageLedger();
    ledger.settle({ ...record("one"), usage: null });
    ledger.begin("two");
    expect(ledger.list()[0]!.usage).toBeNull();
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
it("validates exact automatic site origins", () => {
  for (const origin of [
    "file:///tmp",
    "https://user:secret@example.com",
    "https://example.com/private",
    "https://example.com/",
  ])
    expect(() => settingsSchema.parse({ autoOrigins: [origin] })).toThrow();
  expect(
    settingsSchema.parse({ autoOrigins: ["https://example.com"] }).autoOrigins,
  ).toEqual(["https://example.com"]);
});
it("keeps accounting isolated by record scope without enforcing frontend budgets", () => {
  const ledger = new UsageLedger();
  ledger.begin("web");
  ledger.begin("discord");
  ledger.settle({ ...record("web"), scope: "extension|page" });
  ledger.settle({
    ...record("discord"),
    scope: "discord|channel",
    usage: null,
  });
  ledger.begin("discord-next");
  ledger.clearScope("extension|page");
  expect(ledger.list()).toMatchObject([{ requestId: "discord", usage: null }]);
});

it("serializes one scope without blocking other scopes or running cancelled waiting jobs", async () => {
  const queue = new TaskQueue<string>(2, 5);
  let release!: () => void;
  const order: string[] = [];
  const first = queue.submit(
    "a1",
    () =>
      new Promise((resolve) => {
        release = () => resolve("first");
      }),
    0,
    "page-a",
  );
  const cancelled = queue.submit(
    "a2",
    async () => {
      order.push("cancelled");
      return "cancelled";
    },
    0,
    "page-a",
  );
  const cancelledCheck = expect(cancelled).rejects.toThrow("cancelled");
  const other = queue.submit(
    "b",
    async () => {
      order.push("other");
      return "other";
    },
    0,
    "page-b",
  );
  const last = queue.submit(
    "a3",
    async () => {
      order.push("last");
      return "last";
    },
    0,
    "page-a",
  );
  await Promise.resolve();
  queue.cancel("a2");
  expect(await other).toBe("other");
  expect(order).toEqual(["other"]);
  release();
  await first;
  await cancelledCheck;
  expect(await last).toBe("last");
  expect(order).toEqual(["other", "last"]);
});
