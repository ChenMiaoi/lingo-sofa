/** Approvals are one-shot, session-scoped and never survive cancellation/restart. */
export class ToolApprovals {
  private pending = new Map<
    string,
    { sessionId: string; resolve: (approved: boolean) => void }
  >();
  async request(
    sessionId: string,
    id: string,
    signal: AbortSignal | undefined,
    publish: () => Promise<void>,
  ) {
    if (signal?.aborted) return false;
    if (this.pending.has(id) || this.pending.size >= 8)
      throw new Error("approval_limit");
    const deferred = Promise.withResolvers<boolean>();
    this.pending.set(id, { sessionId, resolve: deferred.resolve });
    const abort = () => deferred.resolve(false);
    const timer = setTimeout(abort, 5 * 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await publish();
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.pending.delete(id);
    }
  }
  decide(sessionId: string, id: string, approved: boolean) {
    const pending = this.pending.get(id);
    if (!pending || pending.sessionId !== sessionId)
      throw new Error("approval_expired");
    this.pending.delete(id);
    pending.resolve(approved);
  }
}
