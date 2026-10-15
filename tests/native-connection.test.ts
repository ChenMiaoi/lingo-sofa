import { it, expect, vi } from "vitest";
import { browser, type Browser } from "wxt/browser";
vi.mock("wxt/browser", () => ({ browser: { runtime: {} } }));
import { NativeConnection } from "../apps/browser-extension/src/native-connection.js";
function port() {
  const messages: ((message: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  const sent: { transportId: string; payload: unknown }[] = [];
  return {
    messages,
    disconnects,
    sent,
    api: {
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          messages.push(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) => disconnects.push(listener),
      },
      postMessage: (message: { transportId: string; payload: unknown }) =>
        sent.push(message),
      disconnect: () => {
        for (const listener of disconnects) listener();
      },
    } as unknown as Browser.runtime.Port,
  };
}
const status = {
  version: 1,
  instanceId: "00000000-0000-4000-8000-000000000000",
  clients: 1,
};
async function ready(native: ReturnType<typeof port>) {
  native.messages[0]!({
    transportId: native.sent[0]!.transportId,
    payload: status,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
it("multiplexes out-of-order native replies on one ready port", async () => {
  const native = port();
  const connect = vi.fn(() => native.api);
  const client = new NativeConnection(connect);
  const one = client.request({ request: 1 });
  const two = client.request({ request: 2 });
  expect(native.sent).toHaveLength(1);
  await ready(native);
  expect(connect).toHaveBeenCalledTimes(1);
  native.messages[0]!({
    transportId: native.sent[2]!.transportId,
    payload: "second",
  });
  native.messages[0]!({
    transportId: native.sent[1]!.transportId,
    payload: "first",
  });
  expect(await one).toBe("first");
  expect(await two).toBe("second");
  client.stop();
});
it("reconnects a broken host without replaying already sent work", async () => {
  vi.useFakeTimers();
  const first = port();
  const next = port();
  const connect = vi
    .fn()
    .mockReturnValueOnce(first.api)
    .mockReturnValue(next.api);
  const client = new NativeConnection(connect);
  try {
    const request = client.request({ kind: "translate" });
    const rejected = expect(request).rejects.toThrow("未自动重发");
    await ready(first);
    first.disconnects[0]!();
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(next.sent.map((entry) => entry.payload)).toEqual([
      {
        version: 1,
        sourceKind: "web",
        scope: "browser",
        operation: "runtime-status",
      },
    ]);
    client.stop();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});
it("checks newly authorized hosts immediately while a reconnect timer is pending", async () => {
  vi.useFakeTimers();
  const first = port();
  const next = port();
  const connect = vi
    .fn()
    .mockReturnValueOnce(first.api)
    .mockReturnValue(next.api);
  const client = new NativeConnection(connect);
  try {
    client.start();
    first.disconnects[0]!();
    const check = client.request({ operation: "provider" });
    expect(connect).toHaveBeenCalledTimes(2);
    await ready(next);
    next.messages[0]!({
      transportId: next.sent[1]!.transportId,
      payload: "connected",
    });
    expect(await check).toBe("connected");
    await vi.advanceTimersByTimeAsync(80_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});
it("allows a 55-second cold start before starting the model request timeout", async () => {
  vi.useFakeTimers();
  const native = port();
  const client = new NativeConnection(() => native.api);
  try {
    let settled = false;
    const request = client.request({ kind: "translate" }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(55_000);
    expect(settled).toBe(false);
    expect(native.sent).toHaveLength(1);
    await ready(native);
    expect(native.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(settled).toBe(false);
    native.messages[0]!({
      transportId: native.sent[1]!.transportId,
      payload: { ok: true },
    });
    expect(await request).toEqual({ ok: true });
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});
it("bounds startup waiting and never sends queued model work after a startup failure", async () => {
  vi.useFakeTimers();
  const native = port();
  const client = new NativeConnection(() => native.api);
  try {
    const request = client.request({ kind: "translate" });
    const rejected = expect(request).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(75_000);
    await rejected;
    expect(native.sent).toHaveLength(1);
    native.messages[0]!({
      transportId: native.sent[0]!.transportId,
      payload: status,
    });
    await Promise.resolve();
    expect(native.sent).toHaveLength(1);
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});

it("does not send work cancelled while the runtime is still starting", async () => {
  const native = port();
  const client = new NativeConnection(() => native.api);
  const controller = new AbortController();
  try {
    const request = client.request({ kind: "translate" }, controller.signal);
    const rejected = expect(request).rejects.toThrow();
    controller.abort();
    await ready(native);
    await rejected;
    expect(native.sent).toHaveLength(1);
  } finally {
    client.stop();
  }
});

it.each([
  { message: "Specified native messaging host not found.", installed: null },
  {
    message: "Access to the specified native messaging host is forbidden.",
    installed: true,
  },
])(
  "does not confuse missing registration with missing installation: $message",
  ({ message, installed }) => {
    const native = port();
    const client = new NativeConnection(() => native.api);
    Object.defineProperty(browser.runtime, "lastError", {
      value: { message },
      configurable: true,
    });
    try {
      client.start();
      native.disconnects[0]!();
      expect(client.installed).toBe(installed);
    } finally {
      client.stop();
      Object.defineProperty(browser.runtime, "lastError", {
        value: undefined,
        configurable: true,
      });
    }
  },
);
