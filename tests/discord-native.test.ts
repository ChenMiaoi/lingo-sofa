import { beforeEach, expect, it, vi } from "vitest";
import { DiscordBridgeClient } from "../apps/discord-vencord/src/client.js";

const fake = vi.hoisted(() => ({
  install: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("@lingo-sofa/local-runtime", () => ({
  RuntimeClient: class {
    start = fake.start;
    stop = fake.stop;
    connection = fake.connection;
  },
}));
vi.mock("@lingo-sofa/local-runtime/installer", () => ({
  AssistantInstaller: class {
    ensureInstalled = fake.install;
  },
}));
beforeEach(() => {
  vi.resetModules();
  fake.install.mockReset().mockResolvedValue(undefined);
  fake.start.mockReset();
  fake.stop.mockReset().mockResolvedValue(undefined);
  fake.connection
    .mockReset()
    .mockResolvedValue({ port: 43187, token: "a".repeat(64) });
});

it("waits for native startup before returning the Discord connection", async () => {
  let ready!: () => void;
  fake.start.mockReturnValue(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const native = await import("../apps/discord-vencord/src/native.js");
  const starting = native.start(null);
  await expect.poll(() => fake.start.mock.calls.length).toBe(1);
  const waiting = native.connection(null);
  expect(fake.connection).not.toHaveBeenCalled();
  ready();
  await expect(starting).resolves.toEqual({ ok: true });
  await expect(waiting).resolves.toEqual({
    port: 43187,
    token: "a".repeat(64),
  });
  await native.stop(null);
});

it("shows a native startup failure instead of masking it as an unpaired assistant", async () => {
  let fail!: (reason: Error) => void;
  fake.start.mockReturnValue(
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const native = await import("../apps/discord-vencord/src/native.js");
  const starting = native.start(null);
  await expect.poll(() => fake.start.mock.calls.length).toBe(1);
  const waiting = expect(native.connection(null)).rejects.toThrow("端口占用");
  fail(new Error("本地助手启动失败，请检查安装、版本或端口占用"));
  await waiting;
  await expect(starting).resolves.toMatchObject({ ok: false });
  expect(fake.connection).not.toHaveBeenCalled();
  await native.stop(null);
});

it("does not reconnect a plugin disabled while its initial startup is pending", async () => {
  let ready!: () => void;
  fake.start.mockReturnValue(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const native = await import("../apps/discord-vencord/src/native.js");
  const starting = native.start(null);
  await expect.poll(() => fake.start.mock.calls.length).toBe(1);
  const waiting = native.connection(null);
  await native.stop(null);
  ready();
  await starting;
  await expect(waiting).resolves.toBeNull();
  expect(fake.connection).not.toHaveBeenCalled();
});

it("preserves a failed reconnect reason and recovers when the user retries", async () => {
  fake.start.mockResolvedValue(undefined);
  const native = await import("../apps/discord-vencord/src/native.js");
  await native.start(null);
  fake.connection.mockRejectedValueOnce(
    new Error("本地助手启动失败，请检查端口占用"),
  );
  await expect(native.connection(null)).rejects.toThrow("端口占用");
  await expect(native.installationStatus(null)).resolves.toMatchObject({
    message: "本地助手启动失败，请检查端口占用",
  });
  await expect(native.connection(null)).resolves.toEqual({
    port: 43187,
    token: "a".repeat(64),
  });
  await native.stop(null);
});

it("does not send a cancelled model request after the assistant becomes ready", async () => {
  let ready!: (value: { port: number; token: string }) => void;
  const connection = new Promise<{ port: number; token: string }>((resolve) => {
    ready = resolve;
  });
  const fetcher = vi.fn<typeof fetch>();
  const client = new DiscordBridgeClient({
    port: () => 0,
    token: () => "",
    connect: () => connection,
    fetcher,
  });
  const controller = new AbortController();
  const pending = client.request(
    "discord:fixture",
    {
      kind: "ask",
      requestId: crypto.randomUUID(),
      sessionId: "fixture",
      question: "Synthetic test question",
      context: "Synthetic test context",
    },
    controller.signal,
  );
  controller.abort();
  ready({ port: 43187, token: "a".repeat(64) });
  await expect(pending).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
