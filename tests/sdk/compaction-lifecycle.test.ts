import { expect, test } from "bun:test";
import {
  compact,
  createFileOps,
  type CompactionPreparation,
  type SummaryOptions,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";

const model: Model<"w0-lifecycle"> = {
  id: "w0-lifecycle",
  name: "W0 lifecycle fixture",
  api: "w0-lifecycle",
  identity: { class: "unknown" },
  compat: undefined,
  provider: "w0",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function preparation(): CompactionPreparation {
  const user = (text: string) => ({
    role: "user" as const,
    content: text,
    timestamp: 1,
  });
  return {
    firstKeptEntryId: "kept",
    messagesToSummarize: [user("History before split turn.")],
    turnPrefixMessages: [user("Prefix inside split turn.")],
    recentMessages: [user("Retained suffix.")],
    isSplitTurn: true,
    tokensBefore: 2048,
    fileOps: createFileOps(),
    settings: {
      enabled: true,
      remoteEnabled: false,
      reserveTokens: 512,
      keepRecentTokens: 128,
    },
  };
}

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const options = (
  completeImpl: NonNullable<SummaryOptions["completeImpl"]>,
) => ({
  completeImpl,
  oneshotRetry: false as const,
});

for (const failingBranch of [0, 1]) {
  test(`split summary failure ${failingBranch} aborts and drains its sibling`, async () => {
    const bothStarted = Promise.withResolvers<void>();
    const siblingAborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const originalError = new Error("W0_SUMMARY_FAILURE");
    let calls = 0;
    let settled = false;
    let siblingFinished = false;
    const pending = compact(
      preparation(),
      model,
      "w0-synthetic-key",
      undefined,
      undefined,
      options(async (_model, _context, streamOptions) => {
        const branch = calls++;
        if (calls === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (branch === failingBranch) throw originalError;
        const signal = streamOptions.signal!;
        const aborted = () => siblingAborted.resolve();
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
        try {
          await cleanup.promise;
          siblingFinished = true;
          signal.throwIfAborted();
          return reply("Unexpected sibling success");
        } finally {
          signal.removeEventListener("abort", aborted);
        }
      }),
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.race([
        siblingAborted.promise,
        Bun.sleep(500).then(() => {
          throw new Error("Sibling was not cancelled");
        }),
      ]);
      expect(settled).toBe(false);
      expect(siblingFinished).toBe(false);
    } finally {
      cleanup.resolve();
    }
    expect(await pending).toBe(originalError);
    expect(siblingFinished).toBe(true);
    expect(calls).toBe(2);
  });
}

test("caller cancellation reaches both summaries and drains them", async () => {
  const controller = new AbortController();
  const bothStarted = Promise.withResolvers<void>();
  let calls = 0;
  let finished = 0;
  const pending = compact(
    preparation(),
    model,
    "w0-synthetic-key",
    undefined,
    controller.signal,
    options(async (_model, _context, streamOptions) => {
      calls++;
      if (calls === 2) bothStarted.resolve();
      const signal = streamOptions.signal!;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Bun.sleep(10);
      finished++;
      signal.throwIfAborted();
      return reply("Unexpected success");
    }),
  ).catch((error: unknown) => error);
  await bothStarted.promise;
  controller.abort(new Error("W0_CALLER_CANCELLED"));
  expect(await pending).toBeInstanceOf(Error);
  expect(calls).toBe(2);
  expect(finished).toBe(2);
});

test("split summaries and the following short summary use three calls with peak two", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const result = await compact(
    preparation(),
    model,
    "w0-synthetic-key",
    undefined,
    undefined,
    options(async (_model, _context, streamOptions) => {
      expect(streamOptions.signal?.aborted).not.toBe(true);
      const id = ++calls;
      peak = Math.max(peak, ++active);
      await Bun.sleep(5);
      active--;
      return reply(`W0 summary ${id}`);
    }),
  );
  expect(result.summary).toContain("W0 summary 1");
  expect(result.summary).toContain("W0 summary 2");
  expect(calls).toBe(3);
  expect(peak).toBe(2);
  expect(active).toBe(0);
});
