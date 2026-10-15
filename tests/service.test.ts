import { it, expect } from "vitest";
import { TranslationService } from "@lingo-sofa/translation-core";
import { settingsSchema, type Metrics } from "@lingo-sofa/protocol";
const metrics: Metrics = {
  usage: null,
  costKnown: false,
  durationMs: 1,
  firstOutputMs: null,
  firstTextMs: null,
  generationMs: null,
  tps: null,
};
it("clearing a running conversation discards late output and resets its context", async () => {
  const cleared: string[] = [];
  let resolve!: (value: { text: string; metrics: Metrics }) => void;
  const service = new TranslationService({
    client: async () => ({
      complete: async () => ({ text: "answer", metrics }),
    }),
    ask: async () =>
      new Promise((done) => {
        resolve = done;
      }),
    clearSession: (key) => {
      cleared.push(key);
    },
  });
  const settings = settingsSchema.parse({});
  const request = {
    kind: "ask" as const,
    requestId: crypto.randomUUID(),
    sessionId: "s",
    context: "old",
    question: "explain",
  };
  const result = service.handle(request, "scope", settings, "web");
  while (!resolve) await new Promise((done) => setTimeout(done, 0));
  await service.handle(
    { kind: "clear-session", sessionId: "s" },
    "scope",
    settings,
    "web",
  );
  resolve({ text: "late", metrics });
  expect(await result).toMatchObject({ ok: false });
  expect(service.ledger.list()[0]!.status).toBe("cancelled");
  expect(cleared).toEqual(["scope|s"]);
  const next = service.handle(
    { ...request, requestId: crypto.randomUUID(), context: "new" },
    "scope",
    settings,
    "web",
  );
  const previous = resolve;
  while (resolve === previous) await new Promise((done) => setTimeout(done, 0));
  resolve({ text: "fresh", metrics });
  expect(await next).toMatchObject({ ok: true, text: "fresh" });
  service.reset();
  expect(cleared).toEqual(["scope|s", "scope|s"]);
});
it("keeps cancellation pending until upstream accounting has settled", async () => {
  let finish!: () => void;
  const service = new TranslationService({
    client: async (_settings, onMetrics) => ({
      complete: async () => {
        await new Promise<void>((done) => {
          finish = done;
        });
        onMetrics(metrics);
        return { text: "late", metrics };
      },
    }),
  });
  const id = crypto.randomUUID();
  const settings = settingsSchema.parse({});
  const result = service.handle(
    {
      kind: "ask",
      requestId: id,
      sessionId: "s",
      context: "context",
      question: "explain",
    },
    "scope",
    settings,
    "web",
  );
  while (!finish) await new Promise((done) => setTimeout(done, 0));
  await service.handle(
    { kind: "cancel", requestId: id },
    "scope",
    settings,
    "web",
  );
  expect(service.queue.size).toBe(1);
  finish();
  expect(await result).toMatchObject({ ok: false });
  expect(service.ledger.list()).toMatchObject([
    { requestId: id, status: "cancelled", durationMs: 1 },
  ]);
});
it("sends only cache misses in a mixed batch and binds cached text to new revisions", async () => {
  const sent: { id: string; text: string }[][] = [];
  const service = new TranslationService({
    client: async () => ({
      complete: async (_system, prompt) => {
        const units = JSON.parse(prompt) as { id: string; text: string }[];
        sent.push(units);
        return {
          text: JSON.stringify(
            units.map((unit) => ({ id: unit.id, text: `译 ${unit.text}` })),
          ),
          metrics,
        };
      },
    }),
  });
  const make = (id: string, text: string) => ({
    id,
    text,
    revision: "1",
    sourceKind: "web" as const,
    targetLanguage: "中文",
    protectedParts: [],
  });
  const settings = settingsSchema.parse({});
  await service.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [make("a", "Hello")],
    },
    "scope",
    settings,
    "web",
  );
  const reply = await service.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [{ ...make("b", "Hello"), revision: "2" }, make("c", "World")],
    },
    "scope",
    settings,
    "web",
  );
  expect(reply).toMatchObject({
    ok: true,
    results: [
      { id: "b", revision: "2", text: "译 Hello" },
      { id: "c", revision: "1", text: "译 World" },
    ],
  });
  expect(sent[1]).toEqual([
    { id: "c", text: "World", targetLanguage: "中文", context: "" },
  ]);
  expect(service.ledger.list()).toHaveLength(2);
  await service.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [make("d", "Hello")],
    },
    "scope",
    settings,
    "web",
  );
  expect(sent).toHaveLength(2);
  await service.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [make("d", "Hello")],
    },
    "other-scope",
    settings,
    "web",
  );
  expect(sent).toHaveLength(3);
  expect(service.cacheStats("scope")).toEqual({
    hits: 2,
    lookups: 4,
    ratio: 0.5,
  });
  expect(service.cacheStats("other-scope")).toEqual({
    hits: 0,
    lookups: 1,
    ratio: 0,
  });
  await service.handle({ kind: "clear-data" }, "scope", settings, "web");
  await service.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [make("e", "Hello")],
    },
    "other-scope",
    settings,
    "web",
  );
  expect(sent).toHaveLength(3);
  expect(service.cacheStats("scope").lookups).toBe(0);
});

it("retains the in-flight checkpoint if session usage cannot be persisted", async () => {
  let finished = false;
  let began = false;
  const service = new TranslationService({
    sessionCalls: true,
    onBegin: async () => {
      began = true;
    },
    onRecords: async () => {
      throw new Error("disk full");
    },
    onFinish: async () => {
      finished = true;
    },
    client: async (_settings, _onMetrics, call) => ({
      complete: async () => {
        expect(call!.translationLanguages).toEqual(["中文"]);
        const finish = await call!.begin({
          id: call!.requestId,
          inputTokens: 1,
          outputTokens: 1,
          purpose: "translation",
        });
        await finish(metrics, "failed");
        return { text: "[]", metrics };
      },
    }),
  });
  const result = await service.handle(
    {
      kind: "translate",
      automatic: false,
      requestId: crypto.randomUUID(),
      units: [
        {
          id: "one",
          revision: "1",
          sourceKind: "web",
          text: "Hello",
          targetLanguage: "中文",
          protectedParts: [],
        },
      ],
    },
    "scope",
    settingsSchema.parse({}),
    "web",
  );
  expect(result).toMatchObject({ ok: false, error: "disk full" });
  expect(began).toBe(true);
  expect(finished).toBe(false);
  expect(service.ledger.list()).toHaveLength(1);
});
