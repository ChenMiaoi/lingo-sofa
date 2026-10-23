import type { Writable } from "node:stream";

export async function forwardRuntimeOutput(
  source: ReadableStream<Uint8Array>,
  destination: Writable,
  path: string,
): Promise<void> {
  const log = Bun.file(path).writer();
  const reader = source.getReader();
  const failure = Promise.withResolvers<never>();
  destination.on("error", failure.reject);
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), failure.promise]);
      if (chunk.done) break;
      log.write(chunk.value);
      // Keep diagnostics on disk even if the test runner is terminated.
      await log.flush();
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          destination.write(chunk.value, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
        failure.promise,
      ]);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    destination.off("error", failure.reject);
    reader.releaseLock();
    await log.end();
  }
}

export async function collectRuntimeOutput(
  child: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): void;
  },
  stdout: Writable,
  stderr: Writable,
  stdoutPath: string,
  stderrPath: string,
): Promise<number> {
  const copies = [
    forwardRuntimeOutput(child.stdout, stdout, stdoutPath),
    forwardRuntimeOutput(child.stderr, stderr, stderrPath),
  ];
  try {
    const [, , code] = await Promise.all([
      copies[0]!,
      copies[1]!,
      child.exited,
    ]);
    return code;
  } catch (error) {
    child.kill();
    await Promise.allSettled([...copies, child.exited]);
    throw error;
  }
}
