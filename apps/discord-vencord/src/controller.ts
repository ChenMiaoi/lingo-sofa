import type {
  Reply,
  TranslationUnit,
  TranslationBilling,
} from "@lingo-sofa/protocol";
import { TaskQueue, withoutCode } from "@lingo-sofa/translation-core";
import type { DiscordBridgeClient } from "./client.js";
export function messageTranslationText(content: string): string {
  return withoutCode(content, true);
}
export interface MessageRef {
  account: string;
  channel: string;
  id: string;
  content: string;
  sourceContent?: string;
  deliveryState?: string;
}
export function messageContextMatches(
  selected: MessageRef,
  current: {
    account: string | undefined;
    channel: string | undefined;
    content: string | undefined;
  },
): boolean {
  return (
    current.account === selected.account &&
    current.channel === selected.channel &&
    current.content === (selected.sourceContent ?? selected.content)
  );
}
export interface MessageState {
  content: string;
  language: string;
  status: "queued" | "running" | "success" | "failed";
  text?: string;
  billing?: TranslationBilling | undefined;
  error?: string;
  requestId: string;
  scope: string;
}
export class MessageTranslations {
  private enabled = true;
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }
  private states = new Map<string, MessageState>();
  private listeners = new Map<string, Set<() => void>>();
  private queue = new TaskQueue<Reply>(2, 100);
  private scopeListeners = new Map<string, Set<() => void>>();
  private originalOnlyScopes = new Set<string>();
  subscribeScope(scope: string, listener: () => void): () => void {
    const listeners = this.scopeListeners.get(scope) ?? new Set();
    listeners.add(listener);
    this.scopeListeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.scopeListeners.delete(scope);
    };
  }
  isOriginalOnly(scope: string): boolean {
    return this.originalOnlyScopes.has(scope);
  }
  setOriginalOnly(scope: string, value: boolean): void {
    if (value) {
      this.originalOnlyScopes.add(scope);
      this.pause(scope);
    } else this.originalOnlyScopes.delete(scope);
    for (const key of this.listeners.keys())
      if (key.startsWith(`${scope.slice("discord:".length)}:`)) this.emit(key);
    this.scopeListeners.get(scope)?.forEach((listener) => listener());
  }
  pause(scope: string): void {
    for (const [key, state] of this.states)
      if (
        state.scope === scope &&
        (state.status === "queued" || state.status === "running")
      ) {
        this.queue.cancel(state.requestId);
        void this.client
          .request(scope, { kind: "cancel", requestId: state.requestId })
          .catch(() => undefined);
        this.states.delete(key);
        this.emit(key);
      }
  }
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
    return [...this.listeners.values(), ...this.scopeListeners.values()].reduce(
      (sum, listeners) => sum + listeners.size,
      0,
    );
  }
  translate(message: MessageRef, language: string, automatic = false): void {
    if (!this.enabled) return;
    if (message.deliveryState && message.deliveryState !== "SENT") return;
    const text = messageTranslationText(message.content);
    if (!text || !withoutCode(text)) return;
    const key = this.key(message);
    const messageScope = `discord:${message.account}:${message.channel}`;
    if (automatic && this.originalOnlyScopes.has(messageScope)) return;
    if (!automatic && this.originalOnlyScopes.has(messageScope))
      this.setOriginalOnly(messageScope, false);
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
      text,
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
        state.billing = result.billing;
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
  update(
    message: Pick<MessageRef, "account" | "channel" | "id"> & {
      content?: string;
    },
  ): void {
    if (typeof message.content !== "string") return;
    const key = `${message.account}:${message.channel}:${message.id}`;
    const state = this.states.get(key);
    if (state && state.content !== message.content) this.remove(message);
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
    this.originalOnlyScopes.clear();
    for (const scope of this.scopeListeners.keys())
      this.scopeListeners.get(scope)?.forEach((listener) => listener());
    for (const key of this.listeners.keys()) this.emit(key);
  }
  private emit(key: string): void {
    this.listeners.get(key)?.forEach((listener) => listener());
    const [account, channel] = key.split(":");
    this.scopeListeners
      .get(`discord:${account}:${channel}`)
      ?.forEach((listener) => listener());
  }
  private prune(): void {
    for (const [key, state] of this.states) {
      if (this.states.size <= 500) break;
      if (state.status === "success" || state.status === "failed")
        this.states.delete(key);
    }
  }
}
