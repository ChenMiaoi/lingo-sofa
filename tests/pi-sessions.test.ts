import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelConfigSchema, type Metrics } from "@lingo-sofa/protocol";
import type { ModelCallContext } from "@lingo-sofa/translation-core";
import { SafePiSessions } from "../apps/pi-bridge/src/sdk.js";
import { modelServer } from "./fixtures/model-server.js";
const signal = () => new AbortController().signal;
const prompt = (id: string, text = "Hello") => JSON.stringify([{ id, text }]);
type Sent = {
  messages: { role: string; content: string }[];
  max_completion_tokens: number;
};

it("reuses native Pi history within a page/channel while isolating other scopes and Ask Pi", async () => {
  const model = await modelServer();
  const directory = await mkdtemp(join(tmpdir(), "lingo-sessions-"));
  const sessions = new SafePiSessions(
    modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    }),
    "fixture",
    directory,
  );
  try {
    await sessions
      .translationClient("web:page-a", "中文", [], () => {})
      .complete("Translate latest input", prompt("a", "PAGE_A"), signal());
    await sessions
      .translationClient("web:page-a", "中文", [], () => {})
      .complete("Translate latest input", prompt("b"), signal());
    await sessions
      .translationClient("web:page-b", "中文", [], () => {})
      .complete("Translate latest input", prompt("c"), signal());
    await sessions
      .translationClient("discord:account:channel-a", "中文", [], () => {})
      .complete("Translate latest input", prompt("d"), signal());
    await sessions.ask(
      "web:page-a|ask-one",
      "Question",
      "SELECTED_CONTEXT",
      signal(),
      () => {},
    );
    await sessions
      .translationClient("web:page-a", "日本語", [], () => {})
      .complete("Translate latest input", prompt("e"), signal());
    const sent = model.requests as Sent[];
    expect(sent[1]!.messages.slice(0, sent[0]!.messages.length)).toEqual(
      sent[0]!.messages,
    );
    expect(sent[1]!.messages.length).toBeGreaterThan(sent[0]!.messages.length);
    for (const index of [2, 3, 4, 5])
      expect(JSON.stringify(sent[index])).not.toContain("PAGE_A");
    expect(sent[4]!.messages[0]!.content).not.toContain(
      "Translate latest input",
    );
    expect(sent.every((item) => !Object.hasOwn(item, "tools"))).toBe(true);
    expect(
      (
        await sessions.get("web:page-a|ask-one")
      ).settingsManager.getCompactionSettings().enabled,
    ).toBe(true);
  } finally {
    sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("serializes concurrent requests to one native session and skips cancelled queued work", async () => {
  const model = await modelServer({ delay: 60 });
  const directory = await mkdtemp(join(tmpdir(), "lingo-session-lock-"));
  const sessions = new SafePiSessions(
    modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    }),
    "fixture",
    directory,
  );
  try {
    const client = sessions.translationClient("channel", "中文", [], () => {});
    const controller = new AbortController();
    const first = client.complete("translate", prompt("a"), signal());
    const cancelled = expect(
      client.complete("translate", prompt("cancelled"), controller.signal),
    ).rejects.toThrow();
    const second = client.complete("translate", prompt("b"), signal());
    controller.abort(new Error("cancelled"));
    await Promise.all([first, second, cancelled]);
    expect(model.requests).toHaveLength(2);
    expect((model.requests as Sent[])[1]!.messages.length).toBeGreaterThan(
      (model.requests as Sent[])[0]!.messages.length,
    );
  } finally {
    sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("native Pi compaction passes through accounting and a denied summary sends no provider request", async () => {
  const model = await modelServer({
    contextWindow: 4096,
    maxOutputTokens: 1024,
    inputTokens: (call) => (call >= 3 ? 3200 : 32),
  });
  const directory = await mkdtemp(join(tmpdir(), "lingo-compaction-"));
  const sessions = new SafePiSessions(
    modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    }),
    "fixture",
    directory,
  );
  const calls: { purpose: string; metrics?: Metrics; output: number }[] = [];
  let deny = false;
  const frame = (): ModelCallContext => ({
    scope: "page",
    requestId: crypto.randomUUID(),
    begin: async (call) => {
      if (deny && call.purpose === "compaction")
        throw new Error("Summary budget exceeded");
      const record = {
        purpose: call.purpose,
        output: call.outputTokens,
      } as (typeof calls)[number];
      calls.push(record);
      return async (metrics) => {
        record.metrics = metrics;
      };
    },
  });
  try {
    for (let index = 0; index < 2; index++)
      await sessions
        .translationClient("page", "中文", [], () => {}, frame())
        .complete(
          "Translate latest input",
          prompt(String(index), "A".repeat(2200)),
          signal(),
        );
    deny = true;
    await sessions
      .translationClient("page", "中文", [], () => {}, frame())
      .complete(
        "Translate latest input",
        prompt("third", "A".repeat(2200)),
        signal(),
      );
    const before = model.requests.length;
    await sessions
      .translationClient("page", "中文", [], () => {}, frame())
      .complete("Translate latest input", prompt("denied"), signal())
      .catch(() => {});
    expect(model.requests.length).toBe(before);
    const kept = await sessions.get("translation:page|中文|[]");
    expect(JSON.stringify(kept.messages)).not.toContain('"denied"');
    deny = false;
    await sessions
      .translationClient("page", "中文", [], () => {}, frame())
      .complete("Translate latest input", prompt("after"), signal());
    expect(
      calls.some(
        (call) => call.purpose === "compaction" && call.metrics?.usage !== null,
      ),
    ).toBe(true);
    expect(calls.every((call) => call.output <= 1024)).toBe(true);
    expect(model.requests.length).toBeGreaterThan(before + 1);
  } finally {
    sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("continues an Ask Pi session beyond twenty turns without mixing translation history", async () => {
  const model = await modelServer({ delay: 0 });
  const directory = await mkdtemp(join(tmpdir(), "lingo-ask-turns-"));
  const sessions = new SafePiSessions(
    modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    }),
    "fixture",
    directory,
  );
  try {
    for (let turn = 0; turn < 21; turn++)
      await sessions.ask(
        "ask-session",
        `Question ${turn}`,
        "reference",
        signal(),
        () => {},
      );
    expect(model.requests).toHaveLength(21);
    expect(sessions.stats("ask-session")?.assistantMessages).toBe(21);
  } finally {
    sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("ends the stream when recording a failed model call also fails", async () => {
  const model = await modelServer({ status: 400 });
  const directory = await mkdtemp(join(tmpdir(), "lingo-session-settlement-"));
  const sessions = new SafePiSessions(
    modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    }),
    "fixture",
    directory,
  );
  const call: ModelCallContext = {
    scope: "page",
    requestId: crypto.randomUUID(),
    begin: async () => async () => {
      throw new Error("Usage persistence failed");
    },
  };
  try {
    await expect(
      sessions
        .translationClient("page", "中文", [], () => {}, call)
        .complete("Translate", prompt("a"), signal()),
    ).rejects.toThrow("Model request failed");
    expect(model.requests).toHaveLength(1);
  } finally {
    sessions.dispose();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
