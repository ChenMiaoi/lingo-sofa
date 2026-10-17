import { describe, expect, it } from "vitest";
import {
  importGlossary,
  exportGlossary,
} from "../apps/browser-extension/src/glossary-files.js";
describe("glossary files", () => {
  const terms = [{ source: "kernel", target: "内核" }];
  it("round trips JSON and merges TSV without duplicating existing entries", () => {
    expect(importGlossary(exportGlossary(terms), terms)).toEqual(terms);
    expect(importGlossary("\uFEFFcache\t缓存\r\n", terms)).toEqual([
      ...terms,
      { source: "cache", target: "缓存" },
    ]);
  });
  it("rejects conflicting, malformed, oversized and duplicate imports atomically", () => {
    for (const source of [
      '[{"source":"kernel","target":"核心"}]',
      "[{",
      "one column",
      "[]",
      "x".repeat(100001),
      '[{"source":"x","target":"a"},{"source":"x","target":"b"}]',
    ])
      expect(() => importGlossary(source, terms)).toThrow();
    expect(terms).toEqual([{ source: "kernel", target: "内核" }]);
    expect(() =>
      importGlossary(
        "x\t译词",
        Array.from({ length: 200 }, (_, i) => ({
          source: String(i),
          target: "词",
        })),
      ),
    ).toThrow(/200/);
    expect(() => exportGlossary([{ source: " ", target: "x" }])).toThrow();
  });
});
