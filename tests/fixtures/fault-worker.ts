// Separate W0 fault fixture; none of these operations are exposed by worker.ts.
import {
  readFrames,
  sendFrame,
  type Frame,
} from "../../apps/omp-worker/src/ipc";

const mode = process.argv.at(-1);
let ledgerRequest: Frame | undefined;
let ledgerCall: Record<string, unknown> | undefined;
for await (const frame of readFrames()) {
  if (frame.kind === "admission_response") {
    if (!ledgerRequest || !ledgerCall || frame.ok !== true)
      throw new Error("fixture_admission_failed");
    if (frame.id === 3) {
      await sendFrame({
        v: 1,
        instance: frame.instance,
        kind: "response",
        id: ledgerRequest.id,
        ok: true,
        payload: { done: true },
      });
    } else {
      await sendFrame({
        v: 1,
        instance: frame.instance,
        kind: "admission_request",
        id: frame.id + 1,
        method: "complete",
        payload: {
          ...ledgerCall,
          usageState: "reported",
          stopReason: "stop",
          usage: {
            input: 80,
            output: mode === "ledger-conflict" && frame.id === 2 ? 9 : 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 88,
          },
        },
      });
    }
    continue;
  }
  const response = {
    v: frame.v,
    instance: frame.instance,
    id: frame.id,
    kind: "response" as const,
    ok: true,
    payload: { pong: true },
  };
  if (frame.method === "hello") {
    await sendFrame({
      ...response,
      payload: {
        sdk: mode === "bad-handshake" ? "other-version" : "18.12.3",
        protocol: 1,
        pid: process.pid,
      },
    });
    continue;
  }
  if (mode?.startsWith("ledger-")) {
    ledgerRequest = frame;
    ledgerCall = {
      requestId: frame.id,
      callId: "fixture-call",
      sessionId: "fixture-session",
      purpose: "generation",
      provider: "fixture",
      model: "fixture",
    };
    await sendFrame({
      v: 1,
      instance: frame.instance,
      kind: "admission_request",
      id: 1,
      method: "acquire",
      payload: ledgerCall,
    });
    continue;
  }
  if (mode === "exit") process.exit(9);
  if (mode === "hang") continue;
  if (mode === "wrong-version") await sendFrame({ ...response, v: 2 });
  else if (mode === "wrong-instance")
    await sendFrame({ ...response, instance: "other-instance" });
  else if (mode === "unknown-id")
    await sendFrame({ ...response, id: frame.id + 100 });
  else if (mode === "duplicate") {
    await sendFrame(response);
    await sendFrame(response);
  } else if (mode === "oversize") {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(65537);
    process.stdout.write(header);
  } else if (mode === "truncated") {
    process.stdout.write(Buffer.from([5, 0, 0, 0, 123]));
    process.exit(9);
  } else if (mode === "bad-json")
    process.stdout.write(Buffer.from([1, 0, 0, 0, 255]));
  else if (mode === "stderr-flood") {
    process.stderr.write("W0 synthetic diagnostic\n".repeat(100000));
    await sendFrame(response);
  } else if (mode === "descendant") {
    const child = Bun.spawn(
      process.platform === "win32"
        ? [process.env.COMSPEC!, "/d", "/c", "ping -n 60 127.0.0.1 >nul"]
        : ["/bin/sleep", "60"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      },
    );
    await sendFrame({ ...response, payload: { pid: child.pid } });
  }
}
