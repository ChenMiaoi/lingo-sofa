import { expect, it, vi } from "vitest";
import { settingsSchema } from "@lingo-sofa/protocol";
vi.mock("wxt/browser", () => ({ browser: {} }));
import { mergeSettingsPatch } from "../apps/browser-extension/src/storage.js";

it("changes only submitted preferences and never restores defaults into omitted fields", () => {
  const saved = settingsSchema.parse({
    mode: "direct",
    targetLanguage: "English",
    persistUsage: true,
    retentionDays: 90,
    autoOrigins: ["https://reading.test"],
    glossary: [{ source: "kernel", target: "内核" }],
  });
  expect(mergeSettingsPatch(saved, { timeZone: "UTC" })).toEqual({
    ...saved,
    timeZone: "UTC",
  });
  expect(mergeSettingsPatch(saved, { persistUsage: false })).toEqual({
    ...saved,
    persistUsage: false,
  });
  expect(mergeSettingsPatch(saved, {})).toEqual(saved);
  expect(saved.persistUsage).toBe(true);
});
it("rejects malformed patches without changing persisted preferences", () => {
  const saved = settingsSchema.parse({ mode: "direct" });
  for (const patch of [
    null,
    [],
    { unknown: true },
    { retentionDays: -1 },
    { autoOrigins: ["https://reading.test/path"] },
  ])
    expect(() => mergeSettingsPatch(saved, patch)).toThrow();
  expect(saved.mode).toBe("direct");
});
