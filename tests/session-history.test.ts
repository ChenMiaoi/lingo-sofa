import { expect, test } from "bun:test";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionHistory,
  sessionSnapshot,
  displayMetadata,
} from "../apps/omp-worker/src/session-history";
import { ToolApprovals } from "../apps/omp-worker/src/tool-approval";

const message = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "deepseek",
  model: "deepseek-flash",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

test("restoring an unanswered followup never pairs it with an earlier answer", () => {
  const messages = [
    { role: "user", content: "First question", timestamp: 1 },
    message("First answer"),
    { role: "user", content: "Cancelled followup", timestamp: 2 },
  ];
  const session = {
    messages,
    getSessionStats: () => ({ tokens: {}, toolCalls: 0, cost: 0 }),
  } as unknown as sdk.AgentSession;
  expect(sessionSnapshot(session).question).toBe("Cancelled followup");
  expect(sessionSnapshot(session).output).toBe("");
  messages.push(message("Current partial answer"));
  expect(sessionSnapshot(session).output).toBe("Current partial answer");
  expect(sessionSnapshot(session).messages[1]?.content).toBe("First answer");
});
test("OMP transcripts retain old sessions, metadata and complete context across cold reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-history-"));
  try {
    const history = new SessionHistory(sdk, directory);
    const original = await history.create({
      provider: "deepseek",
      modelId: "deepseek-flash",
      context: { text: "ORIGINAL_SOURCE" },
    });
    const id = original.getSessionId();
    original.appendMessage({
      role: "user",
      content: "FIRST_QUESTION",
      timestamp: Date.now(),
    });
    original.appendMessage(message("FIRST_ANSWER"));
    original.appendCustomEntry("test-summary", { summary: "KEEP_THIS" });
    await original.flush();
    await original.close();
    const next = await history.create({ provider: "openai", modelId: "test" });
    await next.close();
    expect((await history.list()).map((item) => item.id)).toContain(id);
    await history.select(id);
    const cold = new SessionHistory(sdk, directory);
    expect(await cold.current()).toBe(id);
    const restored = await cold.open(id);
    expect(cold.metadata(restored).context).toEqual({
      text: "ORIGINAL_SOURCE",
    });
    const context = restored.buildSessionContext();
    expect(JSON.stringify(context.messages)).toContain("FIRST_QUESTION");
    expect(JSON.stringify(context.messages)).toContain("FIRST_ANSWER");
    restored.appendMessage({
      role: "user",
      content: "FOLLOW_UP",
      timestamp: Date.now(),
    });
    await restored.flush();
    await restored.close();
    const again = await cold.open(id);
    expect(JSON.stringify(again.buildSessionContext().messages)).toContain(
      "FOLLOW_UP",
    );
    await again.close();
    await cold.select(null);
    expect(await cold.current()).toBeNull();
    expect((await cold.list()).length).toBe(2);
    await expect(cold.open("../credentials.sqlite")).rejects.toThrow(
      "invalid_session_id",
    );
    await expect(cold.open("unknown")).rejects.toThrow("session_not_found");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test.skipIf(process.platform === "win32")(
  "history never resumes a transcript symlink outside its own directory",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "lingo-history-scope-"));
    try {
      const history = new SessionHistory(sdk, join(directory, "app"));
      const external = new SessionHistory(sdk, join(directory, "external"));
      const manager = await external.create({
        provider: "deepseek",
        modelId: "deepseek-flash",
      });
      const file = manager.getSessionFile()!;
      const id = manager.getSessionId();
      await manager.close();
      await history.init();
      await symlink(file, join(history.directory, file.split(/[\\/]/).at(-1)!));
      await expect(history.open(id)).rejects.toThrow();
      await writeFile(join(history.directory, "current.json"), "bad json");
      await expect(history.current()).rejects.toThrow(
        "session_pointer_invalid",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test("display projections stay under IPC limits for large Unicode messages without losing durable data", () => {
  const assistant = message(("🛋️" + '"\\\n\0').repeat(20000));
  const user = {
    role: "user",
    content: assistant.content[0]!.text,
    timestamp: Date.now(),
  };
  const snapshot = sessionSnapshot({
    messages: Array.from({ length: 50 }, (_, index) =>
      index % 2 ? assistant : user,
    ),
    getSessionStats: () => ({ tokens: {}, toolCalls: 0, cost: 0 }),
  } as unknown as sdk.AgentSession);
  const original = {
    text: '"\\\n\0'.repeat(15000),
    origin: "Fixture",
    kind: "input",
  };
  const metadata = displayMetadata({
    provider: "deepseek",
    modelId: "test",
    context: original,
  });
  expect(
    Buffer.byteLength(JSON.stringify({ ...snapshot, metadata })),
  ).toBeLessThan(60_000);
  expect(JSON.stringify(original).length).toBeGreaterThan(15000);
  expect(snapshot.messages).toHaveLength(16);
  expect(snapshot.messageCount).toBe(50);
  expect(snapshot.question).toContain("提问显示已截断");
  expect(snapshot.messages.every((item) => item.truncated)).toBe(true);
  expect(assistant.content[0]!.text.length).toBeGreaterThan(20000);
});
test("tool approvals are one-shot, scoped, deny on cancellation and never execute implicitly", async () => {
  const approvals = new ToolApprovals();
  const abort = new AbortController();
  let published = false;
  const waiting = approvals.request(
    "session",
    "call",
    abort.signal,
    async () => {
      published = true;
    },
  );
  expect(published).toBe(true);
  expect(() => approvals.decide("other", "call", true)).toThrow(
    "approval_expired",
  );
  approvals.decide("session", "call", false);
  expect(await waiting).toBe(false);
  expect(() => approvals.decide("session", "call", true)).toThrow(
    "approval_expired",
  );
  const cancelled = approvals.request(
    "session",
    "cancel",
    abort.signal,
    async () => {},
  );
  abort.abort();
  expect(await cancelled).toBe(false);
  const approved = approvals.request(
    "session",
    "ok",
    undefined,
    async () => {},
  );
  approvals.decide("session", "ok", true);
  expect(await approved).toBe(true);
});

test("durable activity restores every turn and complete tool data through bounded chunks", async () => {
  const { sessionActivity, activityChunk } =
    await import("../apps/omp-worker/src/session-activity");
  const directory = await mkdtemp(join(tmpdir(), "lingo-activity-"));
  try {
    const history = new SessionHistory(sdk, directory);
    const manager = await history.create({
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
    const id = manager.getSessionId();
    const long = '思考🛋️\\"\n'.repeat(15000) + "COMPLETE_END";
    manager.appendMessage({ role: "user", content: "First", timestamp: 1 });
    manager.appendMessage({
      ...message(""),
      content: [
        { type: "thinking", thinking: long },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "synthetic.txt" },
        },
      ],
      stopReason: "toolUse",
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: long }],
      isError: true,
      timestamp: 2,
    });
    manager.appendMessage(message("Final answer"));
    manager.appendMessage({
      role: "user",
      content: "Interrupted second turn",
      timestamp: 3,
    });
    manager.appendMessage({
      ...message(""),
      content: [
        { type: "thinking", thinking: "Partial thought" },
        {
          type: "toolCall",
          id: "tool-2",
          name: "read",
          arguments: { path: "unexecuted.txt" },
        },
      ],
    });
    await manager.flush();
    await manager.close();
    const restored = await history.open(id);
    const activity = sessionActivity(restored);
    expect(activity.turns).toHaveLength(2);
    expect(activity.turns[0]!.thinkingOutput).toBe(long);
    expect(activity.turns[0]!.toolCalls[1]!.text).toBe(long);
    expect(activity.turns[0]!.toolCalls[1]!.isError).toBe(true);
    expect(activity.turns[1]!.toolCalls).toHaveLength(1);
    expect(activity.turns[1]!.output).toBe("");
    let offset = 0;
    let version: string | undefined;
    const chunks: string[] = [];
    for (;;) {
      const page = activityChunk(restored, offset, version);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(26000);
      chunks.push(page.chunk);
      version = page.version;
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    }
    expect(chunks.length).toBeGreaterThan(2);
    expect(JSON.parse(chunks.join(""))).toEqual(activity);
    expect(() => activityChunk(restored, -1)).toThrow("invalid_page");
    restored.appendMessage(message("Late completion"));
    expect(() => activityChunk(restored, 0, version)).toThrow(
      "session_activity_changed",
    );
    await restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history pages enumerate once per stable snapshot and search the complete metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-pages-"));
  let reads = 0;
  const entries = Array.from({ length: 125 }, (_, index) => ({
    id: `session-${index}`,
    title: index === 124 ? "x".repeat(110) + "needle" : `Title ${index}`,
    firstMessage: "",
    modified: new Date(1000 - index),
    messageCount: 2,
  }));
  const fake = {
    SessionManager: {
      list: async () => {
        reads++;
        return [...entries];
      },
    },
  } as unknown as typeof sdk;
  const history = new SessionHistory(fake, directory);
  try {
    const first = await history.page(0);
    expect(first.sessions).toHaveLength(50);
    entries.unshift({ ...entries[0]!, id: "new", modified: new Date(2000) });
    const second = await history.page(50, "", first.snapshot);
    const last = await history.page(100, "", first.snapshot);
    expect(reads).toBe(1);
    expect(
      new Set(
        [...first.sessions, ...second.sessions, ...last.sessions].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(125);
    expect((await history.page(0)).total).toBe(126);
    expect(
      (await history.page(0, "needle")).sessions.map((item) => item.id),
    ).toEqual(["session-124"]);
    await expect(history.page(50, "changed", first.snapshot)).rejects.toThrow(
      "history_changed",
    );
    for (let i = 0; i < 8; i++) await history.page(0, String(i));
    await expect(history.page(50, "", first.snapshot)).rejects.toThrow(
      "history_changed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
