import { afterEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "../apps/browser-extension/src/visible-polling.js";
class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
afterEach(() => vi.useRealTimers());
describe("visible polling", () => {
  it("serializes slow requests, discards hidden responses and refreshes on return", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    let resolve!: (value: number) => void;
    const read = vi.fn(
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    const receive = vi.fn();
    const fail = vi.fn();
    const stop = pollWhileVisible(read, receive, fail, visibility);
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(1);
    visibility.change(true);
    visibility.change(false);
    resolve(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    resolve(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).toHaveBeenCalledWith(2);
    visibility.change(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(2);
    visibility.change(false);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    resolve(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("retries failed reads without polling an initially hidden page", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    visibility.hidden = true;
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(4);
    const receive = vi.fn();
    const fail = vi.fn();
    const stop = pollWhileVisible(read, receive, fail, visibility);
    expect(read).not.toHaveBeenCalled();
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(receive).toHaveBeenCalledWith(4);
    stop();
  });
});
