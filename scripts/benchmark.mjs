import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { extract } from "@lingo-sofa/web-extraction";
import { TranslationService } from "@lingo-sofa/translation-core";
import { createPiClient } from "@lingo-sofa/provider-pi/browser";
import { settingsSchema, translationUnitSchema } from "@lingo-sofa/protocol";
import { modelServer } from "../tests/fixtures/model-server.ts";
const dom = new JSDOM(
  `<article>${Array.from({ length: 1000 }, (_, index) => `<p>Paragraph ${index} with <code>fetch()</code>.</p>`).join("")}</article>`,
);
globalThis.HTMLElement = dom.window.HTMLElement;
const samples = [];
for (let index = 0; index < 5; index++) {
  const started = performance.now();
  const blocks = extract(dom.window.document);
  if (blocks.length !== 1000) throw new Error("Fixture extraction mismatch");
  samples.push(performance.now() - started);
}
const model = await modelServer();
try {
  const settings = settingsSchema.parse({
    model: {
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    },
  });
  const service = new TranslationService({
    client: async (settings, onMetrics) =>
      createPiClient(settings.model, "fixture-key", undefined, onMetrics),
  });
  const unit = translationUnitSchema.parse({
    id: "sample",
    revision: "1",
    sourceKind: "web",
    text: "Hello",
    targetLanguage: "中文",
  });
  const request = () => ({
    kind: "translate",
    requestId: randomUUID(),
    automatic: false,
    units: [unit],
  });
  const started = performance.now();
  const reply = await service.handle(request(), "benchmark", settings, "web");
  const coldMs = performance.now() - started;
  const cachedAt = performance.now();
  const cached = await service.handle(request(), "benchmark", settings, "web");
  const cacheMs = performance.now() - cachedAt;
  if (!reply.ok || !cached.ok || model.requests.length !== 1)
    throw new Error("Benchmark model/cache verification failed");
  console.log(
    JSON.stringify(
      {
        environment: {
          os: process.platform,
          arch: process.arch,
          node: process.version,
        },
        fixture:
          "JSDOM, 1,000 paragraphs; local SSE fixture with 20ms output delay",
        extractionMs: samples.map((value) => Math.round(value * 100) / 100),
        medianExtractionMs:
          Math.round([...samples].sort((a, b) => a - b)[2] * 100) / 100,
        coldTranslationMs: Math.round(coldMs * 100) / 100,
        modelMs: reply.metrics?.durationMs,
        cacheMs: Math.round(cacheMs * 100) / 100,
        modelRequests: model.requests.length,
        uiResponseMs: null,
        note: "Synthetic extraction and fixture latency only; no real client responsiveness or provider performance claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await model.close();
  dom.window.close();
}
