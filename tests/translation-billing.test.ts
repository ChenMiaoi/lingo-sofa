// @vitest-environment jsdom
import { it, expect } from "vitest";
import {
  TranslationService,
  TranslationBatcher,
} from "@lingo-sofa/translation-core";
import {
  settingsSchema,
  replySchema,
  type Metrics,
  type TranslationUnit,
} from "@lingo-sofa/protocol";
import { formatTranslationBilling } from "@lingo-sofa/ui-shared";
import { PageTranslator } from "@lingo-sofa/web-extraction";
import { MessageTranslations } from "../apps/discord-vencord/src/controller.js";
const metrics: Metrics = {
  usage: {
    input: 80,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    cost: {
      input: 0.000024,
      output: 0.000024,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.000048,
    },
  },
  costKnown: true,
  durationMs: 1,
  firstOutputMs: null,
  firstTextMs: null,
  generationMs: null,
  tps: null,
};
const unit = (id: string, text = id): TranslationUnit => ({
  id,
  text,
  revision: "1",
  sourceKind: "web",
  targetLanguage: "中文",
  protectedParts: [],
});
const settings = settingsSchema.parse({});
function service(known = true) {
  return new TranslationService({
    client: async () => ({
      complete: async (_system, prompt) => ({
        text: JSON.stringify(
          (JSON.parse(prompt) as TranslationUnit[]).map(({ id, text }) => ({
            id,
            text: `译 ${text}`,
          })),
        ),
        metrics: { ...metrics, costKnown: known },
      }),
    }),
  });
}
it("attaches actual batch totals only to misses and zero new charges to cache hits", async () => {
  const app = service();
  const send = async (units: TranslationUnit[]) =>
    replySchema.parse(
      await app.handle(
        {
          kind: "translate",
          requestId: crypto.randomUUID(),
          automatic: false,
          units,
        },
        "scope",
        settings,
        "web",
      ),
    );
  const first = await send([unit("a"), unit("b")]);
  expect(first.ok && first.results?.map((r) => r.billing)).toEqual(
    Array(2).fill({
      source: "request",
      batchSize: 2,
      tokens: 100,
      cost: 0.000048,
    }),
  );
  const mixed = await send([unit("a2", "a"), unit("c")]);
  expect(mixed.ok && mixed.results?.map((r) => r.billing)).toEqual([
    { source: "cache", batchSize: 1, tokens: 0, cost: 0 },
    { source: "request", batchSize: 1, tokens: 100, cost: 0.000048 },
  ]);
  const cached = await send([unit("a3", "a")]);
  expect(cached.ok && cached.results?.[0]?.billing?.source).toBe("cache");
  expect(app.ledger.list()).toHaveLength(2);
});
it("does not report unknown prices or usage as zero", async () => {
  const app = service(false);
  const reply = await app.handle(
    {
      kind: "translate",
      requestId: crypto.randomUUID(),
      automatic: false,
      units: [unit("a")],
    },
    "scope",
    settings,
    "web",
  );
  expect(reply.ok && reply.results?.[0]?.billing).toMatchObject({
    tokens: 100,
    cost: null,
  });
  expect(
    formatTranslationBilling({
      source: "request",
      batchSize: 1,
      tokens: null,
      cost: null,
    }).text,
  ).toBe("Token 用量未知 · 费用未知");
  expect(formatTranslationBilling().text).toContain("未知");
  expect(
    formatTranslationBilling({
      source: "request",
      batchSize: 1,
      tokens: 1,
      cost: 0.0000001,
    }).text,
  ).toContain("< $0.000001");
});
it("labels shared batch usage and cached requests clearly and rejects invalid billing", () => {
  const value = formatTranslationBilling({
    source: "request",
    batchSize: 3,
    tokens: 100,
    cost: 0.000048,
  });
  expect(value.text).toBe("同批 3 段合计 · 100 Tokens · ≈ $0.000048");
  expect(value.title).toContain("不能逐段累加");
  expect(
    formatTranslationBilling({
      source: "cache",
      batchSize: 1,
      tokens: 0,
      cost: 0,
    }).text,
  ).toBe("缓存命中 · 本次 0 Tokens · $0");
  expect(
    replySchema.safeParse({
      ok: true,
      results: [
        {
          id: "x",
          revision: "1",
          text: "译文",
          billing: { source: "cache", batchSize: 1, tokens: 5, cost: 1 },
        },
      ],
    }).success,
  ).toBe(false);
});
it("keeps ID-aligned billing through batching and the inline DOM lifecycle", async () => {
  const billing = {
    source: "request" as const,
    batchSize: 2,
    tokens: 100,
    cost: 0.000048,
  };
  const batcher = new TranslationBatcher(async (units) =>
    units.map((u) => ({ ...u, text: `译 ${u.text}`, billing })).reverse(),
  );
  document.body.innerHTML = '<p id="a">A</p><p id="b">B</p>';
  const page = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: (block, id, revision, signal) =>
      batcher.translateResult({ ...unit(id, block.text), revision }, signal),
  });
  page.start();
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelectorAll(".lingo-sofa-inline-usage")).toHaveLength(2);
  expect(
    document.querySelector("#a .lingo-sofa-inline-usage")?.textContent,
  ).toBe("同批 2 段合计 · 100 Tokens · ≈ $0.000048");
  expect(page.trackedCount).toBe(2);
  page.stop();
  expect(document.querySelector(".lingo-sofa-inline-usage")).toBeNull();
});
it("retains billing in a Discord message state and clears it when edited", async () => {
  const billing = {
    source: "request" as const,
    batchSize: 1,
    tokens: 100,
    cost: 0.000048,
  };
  const app = new MessageTranslations({
    request: async (_scope, request) =>
      request.kind === "translate"
        ? {
            ok: true,
            results: request.units.map((u) => ({
              id: u.id,
              revision: u.revision,
              text: "译文",
              billing,
            })),
          }
        : { ok: true },
  });
  const message = { account: "a", channel: "c", id: "m", content: "Hello" };
  app.translate(message, "中文");
  await new Promise((r) => setTimeout(r, 20));
  expect(app.get(message)?.billing).toEqual(billing);
  app.update({ ...message, content: "Edited" });
  expect(app.get(message)).toBeUndefined();
  app.clear();
});
