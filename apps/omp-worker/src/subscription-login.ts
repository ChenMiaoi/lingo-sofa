import { randomUUID } from "node:crypto";
import type * as AI from "@oh-my-pi/pi-ai";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";

import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";

/** Authorization addresses come from the selected SDK flow, never from a UI URL parameter. */
export function safeAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function subscriptionProviders(
  ai: typeof AI,
  modelProviders?: ReadonlySet<string>,
) {
  return ai
    .getOAuthProviders()
    .filter(
      (entry) =>
        entry.available &&
        (!modelProviders ||
          modelProviders.has(entry.storeCredentialsAs ?? entry.id)),
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      provider: entry.storeCredentialsAs ?? entry.id,
      method: authPolicyFor(entry.id)?.login?.kind ?? "custom",
    }));
}
export type LoginProvider = Omit<
  ReturnType<typeof subscriptionProviders>[number],
  "method"
> & { method?: string };
export interface LoginState {
  attempt: string;
  provider: string;
  phase: "waiting" | "prompt" | "complete" | "error" | "cancelled";
  url?: string;
  instructions?: string;
  prompt?: {
    id: number;
    message: string;
    secret: boolean;
    allowEmpty: boolean;
    browser?: { url: string; cookieNames: readonly string[] };
  };
}

export class SubscriptionLogin {
  private active?: {
    state: LoginState;
    abort: AbortController;
    resolve?: (value: string) => void;
    reject?: (reason: Error) => void;
  };
  private promptId = 0;
  constructor(
    private readonly auth: { oauth: Pick<AuthStorage["oauth"], "login"> },
    readonly providers: LoginProvider[],
    private readonly fetch: typeof globalThis.fetch,
  ) {}
  start(providerId: string) {
    const provider = this.providers.find((entry) => entry.id === providerId);
    if (!provider) throw new Error("login_provider_unsupported");
    if (this.active && ["waiting", "prompt"].includes(this.active.state.phase))
      throw new Error("login_in_progress");
    const active = {
      state: {
        attempt: randomUUID(),
        provider: provider.provider,
        phase: "waiting",
      } as LoginState,
      abort: new AbortController(),
      resolve: undefined as ((value: string) => void) | undefined,
      reject: undefined as ((reason: Error) => void) | undefined,
    };
    this.active = active;
    const requestInput = (
      prompt: AI.OAuthPrompt,
      browser?: { url: string; cookieNames: readonly string[] },
      signal: AbortSignal | undefined = active.abort.signal,
    ) =>
      new Promise<string>((resolve, reject) => {
        if (active.abort.signal.aborted) {
          reject(new Error("login_cancelled"));
          return;
        }
        if (active.reject) {
          reject(new Error("login_prompt_in_progress"));
          return;
        }
        active.state.phase = "prompt";
        active.state.prompt = {
          id: ++this.promptId,
          message: prompt.message,
          secret: prompt.secret ?? false,
          allowEmpty: prompt.allowEmpty ?? false,
          browser,
        };
        const id = active.state.prompt.id;
        let finished = false;
        const finish = (value?: string, reason?: Error) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", aborted);
          if (active.state.prompt?.id === id) {
            delete active.state.prompt;
            if (active.state.phase === "prompt") active.state.phase = "waiting";
          }
          active.resolve = undefined;
          active.reject = undefined;
          if (reason) reject(reason);
          else resolve(value ?? "");
        };
        const aborted = () =>
          finish(undefined, new Error("login_prompt_cancelled"));
        active.resolve = (value) => finish(value);
        active.reject = (reason) => finish(undefined, reason);
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    const timeout = setTimeout(() => {
      if (this.active === active) this.cancel(active.state.attempt);
      else active.abort.abort();
    }, 10 * 60_000);
    timeout.unref();
    void this.auth.oauth
      .login(provider.id, {
        signal: active.abort.signal,
        fetch: this.fetch,
        onAuth: ({ url, instructions }) => {
          if (active.abort.signal.aborted) return;
          if (!safeAuthorizationUrl(url))
            throw new Error("login_url_not_allowed");
          active.state.url = url;
          active.state.instructions = instructions;
        },
        onPrompt: (prompt) => requestInput(prompt),
        onManualCodeInput: (signal) =>
          requestInput(
            {
              message: "粘贴授权码或完整回调 URL（浏览器自动返回时可等待）",
              secret: true,
            },
            undefined,
            signal,
          ),
        onBrowserSession: (request, signal) => {
          if (
            !safeAuthorizationUrl(request.url) ||
            !request.cookieNames.length ||
            request.cookieNames.length > 8
          )
            return Promise.reject(new Error("login_url_not_allowed"));
          return requestInput(
            { message: "请在独立登录窗口完成订阅账户授权", secret: true },
            request,
            signal,
          );
        },
      })
      .then(
        (identity) => {
          if (!active.abort.signal.aborted)
            active.state.phase = identity ? "complete" : "error";
        },
        () => {
          if (!active.abort.signal.aborted) active.state.phase = "error";
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        delete active.state.prompt;
        active.resolve = undefined;
        active.reject = undefined;
      });
    return this.status(active.state.attempt);
  }
  status(attempt: string) {
    if (!this.active || this.active.state.attempt !== attempt)
      throw new Error("login_expired");
    return structuredClone(this.active.state);
  }
  input(attempt: string, prompt: number, value: string) {
    const state = this.status(attempt);
    const active = this.active!;
    if (
      state.phase !== "prompt" ||
      state.prompt?.id !== prompt ||
      !active.resolve ||
      value.length > 8192 ||
      (!state.prompt.allowEmpty && !value.trim())
    )
      throw new Error("invalid_login_input");
    const resolve = active.resolve;
    active.resolve = undefined;
    active.reject = undefined;
    active.state.phase = "waiting";
    delete active.state.prompt;
    resolve(value);
    return this.status(attempt);
  }
  cancel(attempt: string) {
    const state = this.status(attempt);
    if (["waiting", "prompt"].includes(state.phase)) {
      this.active!.state.phase = "cancelled";
      this.active!.abort.abort();
      this.active!.reject?.(new Error("login_cancelled"));
      delete this.active!.state.prompt;
    }
    return this.status(attempt);
  }
  close() {
    if (this.active) this.cancel(this.active.state.attempt);
  }
}
