import { browser, type Browser } from "wxt/browser";

/** One native port keeps the registered local client alive and multiplexes replies. */
export class NativeConnection {
  private port: Browser.runtime.Port | undefined;
  private enabled = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1_000;
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
        void browser.runtime.lastError;
        this.port = undefined;
        this.rejectPending("本地助手连接中断；请求未自动重发");
        this.schedule();
      });
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
    port?.disconnect();
    this.rejectPending("本地助手连接已关闭");
  }
  request(payload: unknown): Promise<unknown> {
    this.start();
    const port = this.port;
    if (!port) return Promise.reject(new Error("请先安装 LingoSofa 本地助手"));
    const transportId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transportId);
        reject(new Error("本地助手请求超时；请求未自动重发"));
      }, 50_000);
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
