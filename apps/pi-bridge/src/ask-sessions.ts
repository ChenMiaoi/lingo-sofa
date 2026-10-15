import type { ModelConfig, Metrics } from "@lingo-sofa/protocol";
import type { ModelCallContext } from "@lingo-sofa/translation-core";
import { SafePiSessions } from "./sdk.js";

/** Each conversation has its own runtime, credential and native Pi history. */
export class AskSessions {
  private entries = new Map<
    string,
    { fingerprint: string; sessions: SafePiSessions; used: number }
  >();
  constructor(
    private create: (model: ModelConfig, key: string) => SafePiSessions,
  ) {}
  async ask(
    id: string,
    model: ModelConfig,
    key: string,
    question: string,
    context: string,
    signal: AbortSignal,
    onMetrics: (value: Metrics) => void,
    call?: ModelCallContext,
  ) {
    for (const [sessionId, entry] of this.entries)
      if (Date.now() - entry.used > 30 * 60_000) this.clear(sessionId);
    const fingerprint = JSON.stringify([model, key]);
    let entry = this.entries.get(id);
    if (!entry || entry.fingerprint !== fingerprint) {
      if (!entry && this.entries.size >= 50)
        throw new Error("Session limit reached; clear old sessions");
      const sessions = this.create(model, key);
      try {
        await sessions.get(id, undefined, entry?.sessions.snapshot(id));
      } catch (error) {
        sessions.dispose();
        throw error;
      }
      entry?.sessions.dispose();
      entry = { fingerprint, sessions, used: Date.now() };
      this.entries.set(id, entry);
    }
    entry.used = Date.now();
    try {
      return await entry.sessions.ask(
        id,
        question,
        context,
        signal,
        onMetrics,
        call,
      );
    } finally {
      entry.used = Date.now();
    }
  }
  async get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Ask session unavailable");
    return entry.sessions.get(id);
  }
  stats(id: string) {
    return this.entries.get(id)?.sessions.stats(id);
  }
  clear(id: string) {
    this.entries.get(id)?.sessions.dispose();
    this.entries.delete(id);
  }
  dispose() {
    for (const id of this.entries.keys()) this.clear(id);
  }
}
