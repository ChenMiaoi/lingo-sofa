import type { TranslationUnit, TranslationResult } from "@lingo-sofa/protocol";
import { translationParts } from "./translation-parts.js";
interface Pending {
  isolated: boolean;
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
  private sequence = 0;
  constructor(
    private readonly send: (
      units: TranslationUnit[],
      signal: AbortSignal,
    ) => Promise<TranslationResult[]>,
    private readonly capacity = 1_000,
    private readonly maxBytes = 4_000,
    private readonly maxOutputTokens: number | (() => number) = 4_096,
  ) {}
  translate(unit: TranslationUnit, signal: AbortSignal): Promise<string> {
    return this.translateResult(unit, signal).then((result) => result.text);
  }
  translateResult(
    unit: TranslationUnit,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const metadata = new TextEncoder().encode(
      JSON.stringify({ ...unit, text: "", protectedParts: [] }),
    ).length;
    const parts = translationParts(
      unit,
      Math.max(64, this.byteLimit() - metadata - 64),
    );
    if (parts) {
      if (this.pending.length + parts.chunks.length > this.capacity)
        return Promise.reject(
          new Error(
            "Page queue is full; retry after visible paragraphs finish",
          ),
        );
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      return Promise.all(
        parts.chunks.map((chunk) =>
          this.enqueue(
            {
              ...unit,
              id: `ls-part-${++this.sequence}`,
              text: chunk.text,
              protectedParts: parts.markers.filter((marker) =>
                chunk.text.includes(marker),
              ),
            },
            controller.signal,
            true,
          ).catch((error) => {
            controller.abort(error);
            throw error;
          }),
        ),
      )
        .then((results) => parts.combine(results))
        .catch((error) => {
          controller.abort(error);
          throw error;
        })
        .finally(() => signal.removeEventListener("abort", abort));
    }
    return this.enqueue(unit, signal, false);
  }
  private byteLimit(): number {
    const tokens =
      typeof this.maxOutputTokens === "function"
        ? this.maxOutputTokens()
        : this.maxOutputTokens;
    return Math.min(
      this.maxBytes,
      Math.max(128, Math.floor(tokens * 1.3) - 128),
    );
  }
  private enqueue(
    unit: TranslationUnit,
    signal: AbortSignal,
    isolated: boolean,
  ): Promise<TranslationResult> {
    if (this.pending.length >= this.capacity)
      return Promise.reject(
        new Error("Page queue is full; retry after visible paragraphs finish"),
      );
    return new Promise((resolve, reject) => {
      const item: Pending = {
        isolated,
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
        if (
          batch.length &&
          (next.isolated ||
            batch[0]!.isolated ||
            size + bytes > this.byteLimit())
        )
          break;
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
