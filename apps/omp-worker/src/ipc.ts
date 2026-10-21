import { once } from "node:events";

export const MAX_FRAME = 64 * 1024;
export interface Frame {
  v: number;
  instance: string;
  kind:
    | "request"
    | "response"
    | "event"
    | "credential_request"
    | "credential_response"
    | "admission_request"
    | "admission_response";
  id: number;
  method?: string;
  ok?: boolean;
  payload: Record<string, unknown>;
}

export async function* readFrames(
  input: AsyncIterable<Uint8Array> = process.stdin,
): AsyncGenerator<Frame> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      if (!length || length > MAX_FRAME)
        throw new Error("invalid_frame_length");
      if (buffer.length < 4 + length) break;
      const frame = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          buffer.subarray(4, 4 + length),
        ),
      ) as Frame;
      buffer = buffer.subarray(4 + length);
      if (
        !frame ||
        typeof frame !== "object" ||
        Object.keys(frame).some(
          (key) =>
            ![
              "v",
              "instance",
              "kind",
              "id",
              "method",
              "ok",
              "payload",
            ].includes(key),
        ) ||
        frame.v !== 1 ||
        ![
          "request",
          "response",
          "event",
          "credential_request",
          "credential_response",
          "admission_request",
          "admission_response",
        ].includes(frame.kind) ||
        (frame.method !== undefined && typeof frame.method !== "string") ||
        (frame.ok !== undefined && typeof frame.ok !== "boolean") ||
        typeof frame.instance !== "string" ||
        !frame.instance.length ||
        frame.instance.length > 64 ||
        !Number.isSafeInteger(frame.id) ||
        frame.id <= 0 ||
        !frame.payload ||
        typeof frame.payload !== "object" ||
        Array.isArray(frame.payload)
      )
        throw new Error("invalid_envelope");
      yield frame;
    }
  }
  if (buffer.length) throw new Error("truncated_frame");
}

let output = Promise.resolve();
let queued = 0;
export function sendFrame(frame: Frame): Promise<void> {
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length > MAX_FRAME || ++queued > 32) throw new Error("output_limit");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  output = output
    .then(async () => {
      if (!process.stdout.write(Buffer.concat([length, body])))
        await once(process.stdout, "drain");
    })
    .finally(() => {
      queued--;
    });
  return output;
}
