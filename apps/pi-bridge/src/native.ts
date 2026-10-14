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
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const raw of decoder.push(chunk)) {
        const providerOperation =
          raw && typeof raw === "object" && "operation" in raw;
        const envelope = providerOperation
          ? nativeProviderEnvelopeSchema.parse(raw)
          : bridgeEnvelopeSchema.parse(raw);
        const route =
          "operation" in envelope
            ? envelope.operation === "provider"
              ? "/v1/provider"
              : "/v1/provider/update"
            : "/v1/request";
        const body =
          "operation" in envelope
            ? envelope.operation === "provider-update"
              ? envelope.update
              : {}
            : envelope;
        void fetch(`http://127.0.0.1:${port}${route}`, {
          method: "POST",
          headers: {
            Origin: origin.replace(/\/$/, ""),
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(50_000),
        })
          .then(async (response) => {
            process.stdout.write(
              nativeFrame((await response.json()) as unknown),
            );
          })
          .catch(() => {
            process.stdout.write(
              nativeFrame({ ok: false, error: "Bridge is unavailable" }),
            );
          });
      }
    } catch {
      process.stdout.write(
        nativeFrame({ ok: false, error: "Invalid native message" }),
      );
    }
  });
}
