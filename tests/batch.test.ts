import { it, expect } from "vitest";
import { TranslationBatcher } from "@lingo-sofa/translation-core";
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
