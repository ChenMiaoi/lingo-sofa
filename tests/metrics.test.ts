import { it, expect } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { measure } from "@lingo-sofa/provider-pi";
import { summarize } from "@lingo-sofa/translation-core";
const message: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  model: "fixture",
  provider: "openai-compatible",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 10,
    output: 20,
    reasoning: 7,
    cacheRead: 30,
    cacheWrite: 5,
    totalTokens: 65,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0.03,
      cacheWrite: 0.04,
      total: 0.1,
    },
  },
};
it("measures thinking and text over the same output window and prefers Pi duration", () => {
  expect(
    measure({ ...message, durationMs: 5000 }, 6000, 1000, 2000, 3000, 3, true),
  ).toMatchObject({
    durationMs: 5000,
    firstOutputMs: 1000,
    firstTextMs: 2000,
    generationMs: 2000,
    tps: 10,
  });
  expect(measure(message, 2000, 1000, 1000, 1000, 1, true).tps).toBeNull();
  expect(measure(message, 2000, null, null, null, 0, true).tps).toBeNull();
});
it("keeps zero-token errors unknown and averages throughput across valid windows", () => {
  const empty = {
    ...message,
    usage: {
      ...message.usage,
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
  expect(measure(empty, 30, null, null, null, 0, false).usage).toBeNull();
  const base = {
    scope: "fixture",
    model: "fixture",
    provider: "fixture",
    mode: "direct" as const,
    sourceKind: "web" as const,
    status: "success" as const,
    timestamp: 0,
  };
  const a = {
    ...base,
    requestId: "a",
    ...measure(message, 3000, 1000, 1000, 2000, 2, true),
  };
  const b = {
    ...base,
    requestId: "b",
    ...measure(message, 6000, 1000, 1000, 4000, 2, true),
  };
  const total = summarize([a, b, a]);
  expect(total).toMatchObject({
    requests: 2,
    tokens: 130,
    input: 90,
    output: 40,
    cost: 0.2,
    tps: 10,
  });
});
