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
