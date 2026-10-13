import type { Reply, TranslationUnit } from "@lingo-sofa/protocol";
import { TaskQueue } from "@lingo-sofa/translation-core";
import type { DiscordBridgeClient } from "./client.js";
export interface MessageRef {
  account: string;
  channel: string;
  id: string;
  content: string;
}
export interface MessageState {
  content: string;
  language: string;
  status: "queued" | "running" | "success" | "failed";
  text?: string;
  error?: string;
  requestId: string;
  scope: string;
}
export class MessageTranslations {
  private states = new Map<string, MessageState>();
  private listeners = new Map<string, Set<() => void>>();
  private queue = new TaskQueue<Reply>(2, 100);
  constructor(private readonly client: Pick<DiscordBridgeClient, "request">) {}
  key(message: MessageRef): string {
    return `${message.account}:${message.channel}:${message.id}`;
  }
  get(message: MessageRef): MessageState | undefined {
    const state = this.states.get(this.key(message));
    return state?.content === message.content ? state : undefined;
  }
  subscribe(message: MessageRef, listener: () => void): () => void {
    const key = this.key(message);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  get subscriberCount(): number {
    return [...this.listeners.values()].reduce(
      (sum, listeners) => sum + listeners.size,
      0,
    );
  }
  translate(message: MessageRef, language: string, automatic = false): void {
    const key = this.key(message);
    const previous = this.states.get(key);
    if (
      previous?.content === message.content &&
      previous.language === language &&
      previous.status !== "failed"
    )
      return;
    this.remove(message);
    const requestId = crypto.randomUUID();
    const scope = `discord:${message.account}:${message.channel}`;
    const state: MessageState = {
      content: message.content,
      language,
      status: "queued",
      requestId,
      scope,
    };
    this.states.set(key, state);
    this.emit(key);
    const unit: TranslationUnit = {
      id: message.id,
      revision: requestId,
      sourceKind: "discord",
      text: message.content,
      targetLanguage: language,
      protectedParts: [],
    };
    void this.queue
      .submit(
        requestId,
        async (signal) => {
          state.status = "running";
          this.emit(key);
          return this.client.request(
            scope,
            { kind: "translate", requestId, units: [unit], automatic },
            signal,
          );
        },
        automatic ? 0 : 10,
      )
      .then((reply) => {
        if (this.states.get(key) !== state) return;
        if (!reply.ok) throw new Error(reply.error);
        const result = reply.results?.find(
          (result) => result.id === message.id && result.revision === requestId,
        );
        if (!result) throw new Error("Bridge 返回了不匹配的消息版本");
        state.status = "success";
        state.text = result.text;
        this.emit(key);
      })
      .catch((error: unknown) => {
        if (this.states.get(key) !== state) return;
        state.status = "failed";
        state.error = error instanceof Error ? error.message : "翻译失败";
        this.emit(key);
      })
      .finally(() => this.prune());
  }
  remove(message: Pick<MessageRef, "account" | "channel" | "id">): void {
    const key = `${message.account}:${message.channel}:${message.id}`;
    const state = this.states.get(key);
    if (state && (state.status === "queued" || state.status === "running")) {
      this.queue.cancel(state.requestId);
      void this.client
        .request(state.scope, { kind: "cancel", requestId: state.requestId })
        .catch(() => undefined);
    }
    this.states.delete(key);
    this.emit(key);
  }
  clear(): void {
    for (const [key, state] of this.states) {
      if (state.status === "queued" || state.status === "running")
        void this.client
          .request(state.scope, { kind: "cancel", requestId: state.requestId })
          .catch(() => undefined);
      this.emit(key);
    }
    this.queue.clear();
    this.states.clear();
    for (const key of this.listeners.keys()) this.emit(key);
  }
  private emit(key: string): void {
    this.listeners.get(key)?.forEach((listener) => listener());
  }
  private prune(): void {
    for (const [key, state] of this.states) {
      if (this.states.size <= 500) break;
      if (state.status === "success" || state.status === "failed")
        this.states.delete(key);
    }
  }
}
