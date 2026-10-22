import {
  httpErrorCode,
  ProviderErrors,
  safeErrorCode,
} from "../../apps/omp-worker/src/errors";
import { expect, test } from "bun:test";
import { MAX_FRAME, readFrames } from "../../apps/omp-worker/src/ipc";

function encode(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function decode(chunks: Uint8Array[]) {
  async function* input() {
    yield* chunks;
  }
  const frames = [];
  for await (const frame of readFrames(input())) frames.push(frame);
  return frames;
}
const frame = {
  v: 1,
  instance: "test-instance",
  kind: "request" as const,
  id: 1,
  method: "ping",
  payload: { text: "划词翻译 🛋️" },
};

test("worker decodes one-byte UTF-8 fragments and coalesced frames", async () => {
  const encoded = encode(frame);
  expect(await decode([...encoded].map((byte) => Uint8Array.of(byte)))).toEqual(
    [frame],
  );
  expect(
    await decode([Buffer.concat([encoded, encode({ ...frame, id: 2 })])]),
  ).toEqual([frame, { ...frame, id: 2 }]);
});

test("worker rejects invalid frame lengths, truncated bodies and invalid UTF-8", async () => {
  for (const size of [0, MAX_FRAME + 1]) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(size);
    await expect(decode([header])).rejects.toThrow("invalid_frame_length");
  }
  await expect(decode([encode(frame).subarray(0, -1)])).rejects.toThrow(
    "truncated_frame",
  );
  await expect(decode([Buffer.from([1, 0, 0, 0, 255])])).rejects.toThrow();
});

test("worker rejects incompatible versions, unsafe IDs and extra envelope fields", async () => {
  for (const invalid of [
    { ...frame, v: 2 },
    { ...frame, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...frame, secret: "unexpected" },
  ]) {
    await expect(decode([encode(invalid)])).rejects.toThrow("invalid_envelope");
  }
});

test("IPC errors admit only explicit codes and structured status without response text", () => {
  expect(safeErrorCode({ status: 401, message: "PRIVATE key" })).toBe("auth");
  expect(safeErrorCode({ status: 429 })).toBe("rate_limit");
  expect(safeErrorCode({ code: "ECONNRESET" })).toBe("network");
  expect(safeErrorCode(new Error("auth"))).toBe("auth");
  expect(safeErrorCode(new Error("401 auth PRIVATE"))).toBe("operation_failed");
  expect(safeErrorCode("auth")).toBe("operation_failed");
});

test("HTTP classification uses numeric status and bounded structured context codes, and clears success", async () => {
  expect(
    await httpErrorCode(
      Response.json(
        { error: { code: "context_length_exceeded", message: "PRIVATE" } },
        { status: 400 },
      ),
    ),
  ).toBe("context_limit");
  expect(
    await httpErrorCode(
      Response.json(
        { error: { message: "context_length_exceeded PRIVATE" } },
        { status: 400 },
      ),
    ),
  ).toBe("operation_failed");
  expect(
    await httpErrorCode(new Response("x".repeat(20_000), { status: 400 })),
  ).toBe("operation_failed");
  expect(await httpErrorCode(new Response("PRIVATE", { status: 429 }))).toBe(
    "rate_limit",
  );
  expect(await httpErrorCode(new Response("success"))).toBeUndefined();
});

test("an error body that stalls cannot indefinitely delay the SDK response", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }),
    { status: 400 },
  );
  expect(await httpErrorCode(response)).toBe("operation_failed");
});

test("provider HTTP failures stay isolated across sibling calls, successful retries and cancellation", async () => {
  const errors = new ProviderErrors();
  let release!: () => void;
  const siblingFinished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failed = errors.run(async (failure) => {
    await errors.fetch(async () => new Response("private", { status: 429 }));
    await siblingFinished;
    return errors.terminal(failure, "error", "PRIVATE");
  });
  const success = errors.run(async (failure) => {
    await errors.fetch(async () => new Response("ok"));
    release();
    return errors.terminal(failure, "stop");
  });
  expect(await Promise.all([failed, success])).toEqual([
    "rate_limit",
    undefined,
  ]);
  await errors.run(async (failure) => {
    await errors.fetch(async () => new Response("private", { status: 429 }));
    await errors.fetch(async () => new Response("ok"));
    expect(errors.terminal(failure, "error", "PRIVATE")).toBe(
      "operation_failed",
    );
  });
  await errors.run(async (failure) => {
    await expect(
      errors.fetch(async () => {
        throw new DOMException("cancel", "AbortError");
      }),
    ).rejects.toThrow("cancel");
    expect(errors.terminal(failure, "aborted", "PRIVATE")).toBeUndefined();
    expect(errors.terminal(failure, "error", "PRIVATE")).toBe("network");
  });
});
