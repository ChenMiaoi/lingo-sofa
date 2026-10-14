interface Job<T> {
  id: string;
  priority: number;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
export class TaskQueue<T> {
  private pending: Job<T>[] = [];
  private active = new Map<string, Job<T>>();
  constructor(
    private readonly concurrency = 2,
    private readonly capacity = 100,
  ) {
    if (concurrency < 1 || capacity < 1)
      throw new Error("Invalid queue limits");
  }
  get runningCount(): number {
    return this.active.size;
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  get size(): number {
    return this.pending.length + this.active.size;
  }
  submit(id: string, run: Job<T>["run"], priority = 0): Promise<T> {
    if (this.size >= this.capacity)
      return Promise.reject(new Error("Queue is full"));
    if (this.active.has(id) || this.pending.some((job) => job.id === id))
      return Promise.reject(new Error("Duplicate request ID"));
    return new Promise((resolve, reject) => {
      this.pending.push({
        id,
        run,
        priority,
        resolve,
        reject,
        controller: new AbortController(),
      });
      this.pending.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }
  cancel(id: string): void {
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error("Request cancelled"));
    }
    const index = this.pending.findIndex((job) => job.id === id);
    if (index >= 0)
      this.pending.splice(index, 1)[0]!.reject(new Error("Request cancelled"));
  }
  clear(): void {
    for (const id of [
      ...this.active.keys(),
      ...this.pending.map((job) => job.id),
    ])
      this.cancel(id);
  }
  private drain(): void {
    while (this.active.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.active.set(job.id, job);
      void Promise.resolve()
        .then(() => {
          job.controller.signal.throwIfAborted();
          return job.run(job.controller.signal);
        })
        .then((value) => {
          job.controller.signal.throwIfAborted();
          job.resolve(value);
        }, job.reject)
        .catch(job.reject)
        .finally(() => {
          this.active.delete(job.id);
          this.drain();
        });
    }
  }
}
export class LruCache<T> {
  private values = new Map<string, T>();
  constructor(private readonly capacity = 500) {}
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }
  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > this.capacity)
      this.values.delete(this.values.keys().next().value!);
  }
  clear(): void {
    this.values.clear();
  }
}
