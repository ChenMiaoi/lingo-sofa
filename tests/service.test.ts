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
