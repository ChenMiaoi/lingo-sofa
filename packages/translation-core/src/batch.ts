import type { TranslationUnit, TranslationResult } from "@lingo-sofa/protocol";
interface Pending {
  unit: TranslationUnit;
  signal: AbortSignal;
  resolve: (result: TranslationResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
/** Coalesces same-host paragraph requests without sending DOM references. */
export class TranslationBatcher {
  private pending: Pending[] = [];
  private running = 0;
  private scheduled = false;
  constructor(
    private readonly send: (
      units: TranslationUnit[],
      signal: AbortSignal,
    ) => Promise<TranslationResult[]>,
    private readonly capacity = 1_000,
    private readonly maxBytes = 4_000,
  ) {}
  translate(unit: TranslationUnit, signal: AbortSignal): Promise<string> {
    return this.translateResult(unit, signal).then((result) => result.text);
  }
  translateResult(
    unit: TranslationUnit,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.pending.length >= this.capacity)
      return Promise.reject(
        new Error("Page queue is full; retry after visible paragraphs finish"),
      );
    return new Promise((resolve, reject) => {
      const item: Pending = {
        unit,
        signal,
        resolve,
        reject,
        abort: () => {
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.pending.push(item);
      this.schedule();
    });
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private drain(): void {
    this.pending = this.pending.filter((item) => !item.signal.aborted);
    while (this.running < 2 && this.pending.length) {
      const batch: Pending[] = [];
      let size = 0;
      while (this.pending.length && batch.length < 16) {
        const next = this.pending[0]!;
        const bytes = new TextEncoder().encode(
          JSON.stringify(next.unit),
        ).length;
        if (batch.length && size + bytes > this.maxBytes) break;
        batch.push(this.pending.shift()!);
        size += bytes;
      }
      this.running++;
      void this.run(batch).finally(() => {
        this.running--;
        this.schedule();
      });
    }
  }
  private async run(batch: Pending[]): Promise<void> {
    const controller = new AbortController();
    const abort = () => {
      if (batch.every((item) => item.signal.aborted))
        controller.abort(new Error("Request cancelled"));
    };
    for (const item of batch)
      item.signal.addEventListener("abort", abort, { once: true });
    try {
      abort();
      controller.signal.throwIfAborted();
      const results = await this.send(
        batch.map((item) => item.unit),
        controller.signal,
      );
      const aligned = batch.map((item) =>
        results.filter(
          (result) =>
            result.id === item.unit.id &&
            result.revision === item.unit.revision,
        ),
      );
      if (
        results.length !== batch.length ||
        aligned.some((matches) => matches.length !== 1)
      )
        throw new Error(
          "Batch returned missing, duplicate or stale paragraph results",
        );
      batch.forEach((item, index) => {
        if (!item.signal.aborted) item.resolve(aligned[index]![0]!);
      });
    } catch (error) {
      for (const item of batch) item.reject(error);
    } finally {
      for (const item of batch) {
        item.signal.removeEventListener("abort", abort);
        item.signal.removeEventListener("abort", item.abort);
      }
    }
  }
}
