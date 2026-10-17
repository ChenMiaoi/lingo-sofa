import { describe, expect, it, vi } from "vitest";
import {
  createWebTranslator,
  translationLanguage,
} from "@lingo-sofa/provider-web";
import { proseTemplate } from "../packages/provider-web/src/prose.js";
import { TranslationService, summarize } from "@lingo-sofa/translation-core";
import { settingsSchema, type TranslationUnit } from "@lingo-sofa/protocol";

const unit: TranslationUnit = {
  id: "paragraph",
  revision: "1",
  sourceKind: "web",
  targetLanguage: "简体中文",
  text: "Hello world",
  protectedParts: [],
};
function fixtureNetwork() {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("edge.microsoft.com")) {
      const texts = JSON.parse(String(init?.body)) as string[];
      return Response.json(
        texts.map((text) => ({ translations: [{ text: text.toUpperCase() }] })),
      );
    }
    const text = new URLSearchParams(String(init?.body)).get("q")!;
    return Response.json([[[text.toUpperCase(), text]], null, "en"]);
  });
}
describe.each(["bing", "google"] as const)("%s translation", (engine) => {
  it("translates prose while keeping nested Markdown, code, formulas, URLs and terms local", async () => {
    const network = fixtureNetwork();
    const text =
      "# Hello **world and [documentation](https://example.com/path?q=a)**.\nUse `fetch()` for $x+y$ with sofa. <@123>";
    const result = await createWebTranslator(engine, network).translate(
      [{ ...unit, text }],
      [{ source: "sofa", target: "沙发" }],
      new AbortController().signal,
    );
    expect(result.results[0]?.text).toBe(
      "# HELLO **WORLD AND [DOCUMENTATION](https://example.com/path?q=a)**.\nUSE `fetch()` FOR $x+y$ WITH 沙发. <@123>",
    );
    expect(result.metrics).toMatchObject({
      billingMode: "free",
      usage: null,
      costKnown: true,
    });
    const bodies = network.mock.calls
      .map(([, init]) => String(init?.body))
      .join(" ");
    expect(bodies).not.toMatch(/fetch|example\.com|LS_PROTECTED|sofa|123|x\+y/);
    expect(
      network.mock.calls.every(([input]) =>
        String(input).startsWith("https://"),
      ),
    ).toBe(true);
  });
  it("keeps long Unicode text intact and bounds upstream payloads", async () => {
    const network = fixtureNetwork();
    const text = "hello😀 ".repeat(1000);
    const result = await createWebTranslator(engine, network).translate(
      [{ ...unit, text }],
      [],
      new AbortController().signal,
    );
    expect(result.results[0]?.text).toBe(text.toUpperCase());
    for (const [, init] of network.mock.calls)
      expect(String(init?.body)).not.toContain('\\ud83d"');
  });
  it("does not retry or fall back when the selected service fails", async () => {
    const network = vi.fn<typeof fetch>(
      async () => new Response("private upstream detail", { status: 429 }),
    );
    await expect(
      createWebTranslator(engine, network).translate(
        [unit],
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("429");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed results and propagates cancellation", async () => {
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ invalid: "response" }),
    );
    await expect(
      createWebTranslator(engine, network).translate(
        [unit],
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("无效结果");
    const controller = new AbortController();
    controller.abort();
    network.mockClear();
    await expect(
      createWebTranslator(engine, network).translate(
        [unit],
        [],
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});
it("normalizes target languages for each service and rejects arbitrary model instructions", () => {
  expect(translationLanguage("简体中文", "bing")).toBe("zh-Hans");
  expect(translationLanguage("zh-Hant", "google")).toBe("zh-TW");
  expect(translationLanguage("Français", "google")).toBe("fr");
  expect(() => translationLanguage("translate and explain", "bing")).toThrow(
    "语言",
  );
});
it("preserves all-protected content without making network requests", async () => {
  const network = fixtureNetwork();
  const text = "`hello()` $a+b$";
  const result = await createWebTranslator("bing", network).translate(
    [{ ...unit, text }],
    [],
    new AbortController().signal,
  );
  expect(result.results[0]?.text).toBe(text);
  expect(network).not.toHaveBeenCalled();
  const template = proseTemplate("[read](https://example.com).", [], []);
  expect(() => template.combine([])).toThrow("数量");
});
it("uses free translation without a model session and isolates cache entries by engine", async () => {
  const network = fixtureNetwork();
  const modelClient = vi.fn(async () => ({
    complete: async () => ({
      text: "answer",
      metrics: {
        usage: null,
        costKnown: false,
        durationMs: 1,
        firstOutputMs: null,
        firstTextMs: null,
        generationMs: null,
        tps: null,
      },
    }),
  }));
  const service = new TranslationService({
    sessionCalls: true,
    client: modelClient,
    translator: (settings) =>
      createWebTranslator(
        settings.translationEngine === "google" ? "google" : "bing",
        network,
      ),
  });
  const settings = settingsSchema.parse({ translationEngine: "bing" });
  const request = () => ({
    kind: "translate" as const,
    automatic: false,
    requestId: crypto.randomUUID(),
    units: [unit],
  });
  expect(
    await service.handle(request(), "page", settings, "web"),
  ).toMatchObject({
    ok: true,
    results: [{ billing: { billingMode: "free", cost: 0, tokens: null } }],
  });
  expect(
    await service.handle(request(), "page", settings, "web"),
  ).toMatchObject({ ok: true, results: [{ billing: { source: "cache" } }] });
  expect(network).toHaveBeenCalledTimes(1);
  await service.handle(
    request(),
    "page",
    { ...settings, translationEngine: "google" },
    "web",
  );
  expect(network).toHaveBeenCalledTimes(2);
  expect(modelClient).not.toHaveBeenCalled();
  expect(summarize(service.ledger.list())).toMatchObject({
    requests: 2,
    cost: 0,
    unknown: 0,
    tokens: 0,
  });
  expect(
    await service.handle(
      {
        kind: "ask",
        requestId: crypto.randomUUID(),
        sessionId: "ask",
        context: "context",
        question: "explain",
      },
      "page",
      settings,
      "web",
    ),
  ).toMatchObject({ ok: true, text: "answer" });
  expect(modelClient).toHaveBeenCalledTimes(1);
});
