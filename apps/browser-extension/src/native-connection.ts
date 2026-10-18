import { browser, type Browser } from "wxt/browser";
import { runtimeStatusSchema } from "@lingo-sofa/protocol";

/** One native port keeps the registered local client alive and multiplexes replies. */
export class NativeConnection {
  private port: Browser.runtime.Port | undefined;
  private enabled = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1_000;
  private hostSeen = false;
  private ready: Promise<void> | undefined;
  private healthy = false;
  get connected(): boolean {
    return this.healthy;
  }
  get installed(): true | null {
    return this.hostSeen ? true : null;
  }
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly connect = () =>
      browser.runtime.connectNative("com.lingosofa.bridge"),
  ) {}
  start() {
    this.enabled = true;
    if (this.port || this.retry) return;
    try {
      const port = (this.port = this.connect());
      port.onMessage.addListener((raw: unknown) => {
        if (this.port !== port) return;
        this.hostSeen = true;
        const message = raw as {
          transportId?: unknown;
          payload?: unknown;
        } | null;
        if (!message || typeof message.transportId !== "string") return;
        const pending = this.pending.get(message.transportId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.transportId);
        this.retryDelay = 1_000;
        pending.resolve(message.payload);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        // Read lastError to acknowledge browser-native launch failures.
        const error = browser.runtime.lastError?.message ?? "";
        if (/forbidden|exited|not allowed/i.test(error)) this.hostSeen = true;
        this.port = undefined;
        this.healthy = false;
        this.ready = undefined;
        this.rejectPending("本地助手连接中断；请求未自动重发");
        this.schedule();
      });
      // Bootstrap may take 60 seconds. Do not send paid requests until it is ready.
      const ready = this.send(
        port,
        {
          version: 1,
          sourceKind: "web",
          scope: "browser",
          operation: "runtime-status",
        },
        75_000,
      )
        .then((reply) => {
          if (!runtimeStatusSchema.safeParse(reply).success)
            throw new Error("本地助手状态无效，请更新助手后重试");
          if (this.port === port) this.healthy = true;
        })
        .catch((error: unknown) => {
          if (this.port === port) {
            this.port = undefined;
            this.healthy = false;
            this.ready = undefined;
            port.disconnect();
            this.rejectPending("本地助手尚未就绪；未发送模型请求");
            this.schedule();
          }
          throw error;
        });
      this.ready = ready;
      void ready.catch(() => undefined);
    } catch {
      this.schedule();
    }
  }
  private schedule() {
    if (!this.enabled || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.start();
    }, this.retryDelay);
    this.retryDelay = Math.min(30_000, this.retryDelay * 2);
  }
  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
  stop() {
    this.enabled = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const port = this.port;
    this.port = undefined;
    this.healthy = false;
    this.ready = undefined;
    port?.disconnect();
    this.rejectPending("本地助手连接已关闭");
  }
  async request(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.port) {
      // A new request (including connection checks after authorization) can retry now.
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.start();
    const port = this.port;
    const ready = this.ready;
    if (!port || !ready) throw new Error("请先安装 LingoSofa 本地助手");
    await ready;
    signal?.throwIfAborted();
    if (this.port !== port)
      throw new Error("本地助手连接已中断；请求未自动重发");
    return this.send(port, payload, 50_000);
  }
  private send(
    port: Browser.runtime.Port,
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const transportId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transportId);
        reject(new Error("本地助手请求超时；请求未自动重发"));
      }, timeoutMs);
      this.pending.set(transportId, { resolve, reject, timer });
      try {
        port.postMessage({ transportId, payload });
      } catch {
        clearTimeout(timer);
        this.pending.delete(transportId);
        reject(new Error("本地助手不可用；请求未自动重发"));
      }
    });
  }
}
