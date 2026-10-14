import { it, expect } from "vitest";
import { TranslationBatcher, translate } from "@lingo-sofa/translation-core";
import {
  translationUnitSchema,
  type TranslationUnit,
} from "@lingo-sofa/protocol";
const unit = (id: number) =>
  translationUnitSchema.parse({
    id: String(id),
    revision: "1",
    sourceKind: "web",
    text: "Hello",
    targetLanguage: "中文",
  });
it("batches 1,000 paragraphs with bounded parallel requests and ID alignment", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const batcher = new TranslationBatcher(async (units) => {
    calls++;
    peak = Math.max(peak, ++active);
    expect(units.length).toBeLessThanOrEqual(16);
    await Promise.resolve();
    active--;
    return units
      .map((item) => ({
        id: item.id,
        revision: item.revision,
        text: `译 ${item.id}`,
      }))
      .reverse();
  });
  const results = await Promise.all(
    Array.from({ length: 1000 }, (_, id) =>
      batcher.translate(unit(id), new AbortController().signal),
    ),
  );
  expect(results[999]).toBe("译 999");
  expect(calls).toBe(63);
  expect(peak).toBe(2);
});
it("cancels individual blocks without losing other results in the same batch", async () => {
  const a = new AbortController(),
    b = new AbortController();
  let finish!: () => void;
  let shared!: AbortSignal;
  const batcher = new TranslationBatcher(async (units, signal) => {
    shared = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return units.map((item) => ({
      id: item.id,
      revision: item.revision,
      text: "ok",
    }));
  });
  const first = batcher.translate(unit(1), a.signal);
  const failure = expect(first).rejects.toThrow("cancelled");
  const second = batcher.translate(unit(2), b.signal);
  await Promise.resolve();
  a.abort(new Error("cancelled"));
  expect(shared.aborted).toBe(false);
  finish();
  await failure;
  expect(await second).toBe("ok");
});
it("rejects missing IDs and does not submit cancelled pending paragraphs", async () => {
  const sent: TranslationUnit[][] = [];
  const batcher = new TranslationBatcher(async (units) => {
    sent.push(units);
    return [];
  });
  const controller = new AbortController();
  const skipped = expect(
    batcher.translate(unit(1), controller.signal),
  ).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await expect(
    batcher.translate(unit(2), new AbortController().signal),
  ).rejects.toThrow("missing");
  await skipped;
  expect(sent[0]!.map((item) => item.id)).toEqual(["2"]);
});

it("bounds batches using the current output allowance rather than context capacity", async () => {
  const sent: TranslationUnit[][] = [];
  const batcher = new TranslationBatcher(
    async (units) => {
      sent.push(units);
      return units.map((item) => ({ ...item, text: "ok" }));
    },
    1000,
    4000,
    512,
  );
  await Promise.all(
    Array.from({ length: 12 }, (_, id) =>
      batcher.translate(
        { ...unit(id), text: "A short sentence to translate." },
        new AbortController().signal,
      ),
    ),
  );
  expect(sent.length).toBeGreaterThan(1);
  expect(
    sent.every(
      (items) =>
        new TextEncoder().encode(
          items.map((item) => JSON.stringify(item)).join(""),
        ).length <=
        Math.floor(512 * 1.3) - 128,
    ),
  ).toBe(true);
});

it("splits long prose, preserves Markdown and protected parts, and sums separately charged requests", async () => {
  const text =
    "An ordinary sentence. ".repeat(35) +
    "**important text** [a link](https://example.test/) `fetch()` $x^2$";
  const sent: TranslationUnit[][] = [];
  const batcher = new TranslationBatcher(
    async (units) => {
      sent.push(units);
      const response = await translate(
        {
          complete: async (_system, input) => ({
            text: JSON.stringify(
              (JSON.parse(input) as { id: string; text: string }[]).map(
                (item) => ({ id: item.id, text: item.text }),
              ),
            ),
            metrics: {
              usage: null,
              costKnown: false,
              durationMs: 0,
              firstOutputMs: null,
              firstTextMs: null,
              generationMs: null,
              tps: null,
            },
          }),
        },
        units,
        [],
        new AbortController().signal,
      );
      return response.results.map((item) => ({
        ...item,
        billing: {
          source: "request" as const,
          batchSize: 1,
          tokens: 20,
          cost: 0.001,
        },
      }));
    },
    1000,
    4000,
    512,
  );
  const result = await batcher.translateResult(
    { ...unit(1), text },
    new AbortController().signal,
  );
  expect(result.text).toBe(text);
  expect(result.id).toBe("1");
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.every((items) => items.length === 1)).toBe(true);
  expect(result.billing?.tokens).toBe(sent.length * 20);
  expect(result.billing?.cost).toBeCloseTo(sent.length * 0.001);
  expect(
    sent.flat().some((item) => item.text.includes("**important text**")),
  ).toBe(true);
});

it("stops queued long-paragraph pieces after one fails instead of retrying paid work", async () => {
  let calls = 0;
  const batcher = new TranslationBatcher(
    async () => {
      calls++;
      throw new Error("Model output limit reached");
    },
    1000,
    4000,
    512,
  );
  await expect(
    batcher.translate(
      { ...unit(1), text: "A sentence. ".repeat(100) },
      new AbortController().signal,
    ),
  ).rejects.toThrow("output limit");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBeLessThanOrEqual(2);
});
