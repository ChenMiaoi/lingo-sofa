import { expect, it } from "vitest";
import { settingsSchema, translationUnitSchema } from "@lingo-sofa/protocol";
import { LocalTranslationCache } from "../apps/browser-extension/src/translation-cache.js";

const settings = settingsSchema.parse({ mode: "direct" });
const unit = translationUnitSchema.parse({
  id: "one",
  revision: "1",
  sourceKind: "web",
  text: "Hello world",
  targetLanguage: "简体中文",
});
const preferences = { enabled: true, days: 7 };
function fixture(maxBytes?: number) {
  let saved: unknown = [];
  let now = 100_000;
  const storage = {
    read: async () => structuredClone(saved),
    write: async (entries: unknown) => {
      saved = structuredClone(entries);
    },
  };
  return {
    create: () => new LocalTranslationCache(storage, () => now, maxBytes),
    advance: (days: number) => {
      now += days * 86_400_000;
    },
    saved: () => saved,
  };
}
it("reuses persisted translations across tabs/restarts until a fixed TTL, without storing source text", async () => {
  const fixtureCache = fixture();
  const first = fixtureCache.create();
  const lookup = await first.lookup(
    [unit],
    "https://one.test",
    settings,
    preferences,
  );
  await first.store(
    lookup,
    [unit],
    [{ id: "one", revision: "1", text: "你好" }],
    preferences,
  );
  expect(JSON.stringify(fixtureCache.saved())).not.toContain("Hello world");
  fixtureCache.advance(6);
  const second = fixtureCache.create();
  expect(
    (
      await second.lookup(
        [{ ...unit, id: "new-tab", revision: "2" }],
        "https://one.test",
        settings,
        preferences,
      )
    ).texts,
  ).toEqual(["你好"]);
  fixtureCache.advance(1);
  expect(
    (await second.lookup([unit], "https://one.test", settings, preferences))
      .texts,
  ).toEqual([undefined]);
  expect(fixtureCache.saved()).toEqual([]);
});
it("invalidates changed content, context, language, glossary, account, model, mode or origin", async () => {
  const cache = fixture().create();
  const lookup = await cache.lookup(
    [unit],
    "direct|https://one.test",
    settings,
    preferences,
  );
  await cache.store(
    lookup,
    [unit],
    [{ id: "one", revision: "1", text: "你好" }],
    preferences,
  );
  for (const changed of [
    { ...unit, text: "Hello again" },
    { ...unit, context: "Other topic" },
    { ...unit, targetLanguage: "Japanese" },
    { ...unit, protectedParts: ["Hello"] },
  ])
    expect(
      (
        await cache.lookup(
          [changed],
          "direct|https://one.test",
          settings,
          preferences,
        )
      ).texts,
    ).toEqual([undefined]);
  for (const changed of [
    { ...settings, glossary: [{ source: "world", target: "世界" }] },
    { ...settings, model: { ...settings.model, model: "other" } },
    {
      ...settings,
      model: { ...settings.model, accountId: crypto.randomUUID() },
    },
  ])
    expect(
      (
        await cache.lookup(
          [unit],
          "direct|https://one.test",
          changed,
          preferences,
        )
      ).texts,
    ).toEqual([undefined]);
  for (const namespace of [
    "bridge|https://one.test",
    "direct|https://two.test",
  ])
    expect(
      (await cache.lookup([unit], namespace, settings, preferences)).texts,
    ).toEqual([undefined]);
});
it("does not repopulate a cleared cache from late responses and honors disabling and size limits", async () => {
  const local = fixture(200);
  const cache = local.create();
  const lookup = await cache.lookup([unit], "origin", settings, preferences);
  await cache.clear();
  await cache.store(
    lookup,
    [unit],
    [{ id: "one", revision: "1", text: "迟到" }],
    preferences,
  );
  expect(local.saved()).toEqual([]);
  const fresh = await cache.lookup([unit], "origin", settings, preferences);
  await cache.store(
    fresh,
    [unit],
    [{ id: "one", revision: "1", text: "长".repeat(300) }],
    preferences,
  );
  expect(local.saved()).toEqual([]);
  await cache.store(
    fresh,
    [unit],
    [{ id: "one", revision: "1", text: "关闭" }],
    { ...preferences, enabled: false },
  );
  expect(
    (
      await cache.lookup([unit], "origin", settings, {
        ...preferences,
        enabled: false,
      })
    ).texts,
  ).toEqual([undefined]);
});
