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
it("multiplexes out-of-order native replies on one port", async () => {
  const native = port();
  const connect = vi.fn(() => native.api);
  const client = new NativeConnection(connect);
  const one = client.request({ request: 1 });
  const two = client.request({ request: 2 });
  expect(connect).toHaveBeenCalledTimes(1);
  native.messages[0]!({
    transportId: native.sent[1]!.transportId,
    payload: "second",
  });
  native.messages[0]!({
    transportId: native.sent[0]!.transportId,
    payload: "first",
  });
  expect(await one).toBe("first");
  expect(await two).toBe("second");
  client.stop();
});
it("reconnects after a broken host but rejects outstanding work without replaying it", async () => {
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
    first.disconnects[0]!();
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(next.sent).toEqual([]);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});

it("checks a newly authorized host immediately while a reconnect timer is pending", async () => {
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
    expect(next.sent).toHaveLength(1);
    next.messages[0]!({
      transportId: next.sent[0]!.transportId,
      payload: "connected",
    });
    expect(await check).toBe("connected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    client.stop();
    vi.useRealTimers();
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
