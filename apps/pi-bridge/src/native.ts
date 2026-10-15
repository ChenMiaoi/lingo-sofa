import {
  bridgeEnvelopeSchema,
  nativeProviderEnvelopeSchema,
} from "./config.js";
export function nativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > 1_000_000)
    throw new Error("Native response is too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}
export class NativeDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32LE(0);
      if (size === 0 || size > 1_000_000)
        throw new Error("Invalid native message length");
      if (this.pending.length < size + 4) break;
      messages.push(
        JSON.parse(
          this.pending.subarray(4, size + 4).toString("utf8"),
        ) as unknown,
      );
      this.pending = this.pending.subarray(size + 4);
    }
    return messages;
  }
}
export function startNative(
  origin: string,
  extensions: readonly string[],
  port: number,
  token: string,
  managed?: {
    connection: () => Promise<{ port: number; token: string }>;
    stop: () => Promise<void>;
  },
): void {
  if (
    !extensions.some(
      (id) =>
        origin === `chrome-extension://${id}/` ||
        origin === `chrome-extension://${id}`,
    )
  )
    throw new Error("Native caller is not an allowed extension");
  const decoder = new NativeDecoder();
  const stop = () => {
    // The relay is disposable; paid work continues in the independent service.
    void (managed?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.stdin.once("end", stop);
  process.once("SIGTERM", stop);
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        const wrapped = message as {
          transportId?: unknown;
          payload?: unknown;
        } | null;
        const transportId =
          wrapped &&
          typeof wrapped.transportId === "string" &&
          /^[\da-f-]{36}$/.test(wrapped.transportId)
            ? wrapped.transportId
            : undefined;
        const raw = transportId ? wrapped!.payload : message;
        const send = (value: unknown) => {
          return process.stdout.write(
            nativeFrame(transportId ? { transportId, payload: value } : value),
          );
        };
        void (async () => {
          try {
            const providerOperation =
              raw && typeof raw === "object" && "operation" in raw;
            const envelope = providerOperation
              ? nativeProviderEnvelopeSchema.parse(raw)
              : bridgeEnvelopeSchema.parse(raw);
            const route =
              "operation" in envelope
                ? envelope.operation === "oauth"
                  ? "/v1/oauth"
                  : envelope.operation === "provider"
                    ? "/v1/provider"
                    : "/v1/provider/update"
                : "/v1/request";
            const body =
              "operation" in envelope
                ? envelope.operation === "oauth"
                  ? envelope.request
                  : envelope.operation === "provider-update"
                    ? envelope.update
                    : {}
                : envelope;
            const connection = managed
              ? await managed.connection()
              : { port, token };
            const response = await fetch(
              `http://127.0.0.1:${connection.port}${route}`,
              {
                method: "POST",
                headers: {
                  Origin: origin.replace(/\/$/, ""),
                  Authorization: `Bearer ${connection.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(50_000),
              },
            );
            send((await response.json()) as unknown);
          } catch {
            send({
              ok: false,
              error: "本地助手不可用；请求未自动重发，请检查连接",
            });
          }
        })();
      }
    } catch {
      process.stdout.write(
        nativeFrame({ ok: false, error: "Invalid native message" }),
      );
    }
  });
}
