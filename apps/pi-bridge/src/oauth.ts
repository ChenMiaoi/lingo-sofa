import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ModelRuntime,
  CredentialSynchronizationError,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, LoginOptions } from "@earendil-works/pi-ai";
import type { OAuthStatus } from "@lingo-sofa/protocol";

type AuthRuntime = Pick<ModelRuntime, "login" | "logout">;
/** One Bridge owns interactive login; Pi owns PKCE, callback, storage and token refresh. */
export class BridgeOAuth {
  readonly authPath: string;
  private runtimePromise?: Promise<AuthRuntime>;
  private attempt:
    { controller: AbortController; task: Promise<void> } | undefined;
  private state: OAuthStatus = { connected: false, phase: "idle" };
  constructor(
    private readonly directory: string,
    private readonly factory?: () => Promise<AuthRuntime>,
    private readonly onConnected?: () => void,
  ) {
    this.authPath = join(directory, "oauth-auth.json");
  }
  private runtime() {
    return (this.runtimePromise ??=
      this.factory?.() ??
      ModelRuntime.create({
        authPath: this.authPath,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
        modelsStorePath: join(this.directory, "oauth-model-cache.json"),
      }));
  }
  status(): OAuthStatus {
    const credential = readStoredCredential("openai", this.authPath);
    return {
      ...this.state,
      connected: credential?.type === "oauth" && Boolean(credential.refresh),
    };
  }
  get busy() {
    return Boolean(this.attempt);
  }
  async start(): Promise<OAuthStatus> {
    if (this.attempt) return this.status();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    this.state = { connected: false, phase: "pending" };
    let ready!: () => void;
    const announced = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const attempt = { controller, task: Promise.resolve() };
    this.attempt = attempt;
    attempt.task = (async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = join(this.directory, "oauth-device-id");
        try {
          await writeFile(path, randomUUID(), { mode: 0o600, flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const deviceId = (await readFile(path, "utf8")).trim();
        const runtime = await this.runtime();
        const interaction: AuthInteraction = {
          signal,
          notify: (event) => {
            if (event.type !== "auth_url" || signal.aborted) return;
            const url = new URL(event.url);
            if (
              url.origin !== "https://auth.openai.com" ||
              url.pathname !== "/api/accounts/authorize"
            ) {
              controller.abort();
              return;
            }
            this.state = {
              connected: false,
              phase: "pending",
              authorizationUrl: url.href,
            };
            ready();
          },
          prompt: (prompt) =>
            new Promise<string>((_resolve, reject) => {
              const pendingSignal = prompt.signal
                ? AbortSignal.any([signal, prompt.signal])
                : signal;
              const cancel = () => reject(new Error("Login cancelled"));
              if (pendingSignal.aborted) cancel();
              else
                pendingSignal.addEventListener("abort", cancel, { once: true });
            }),
        };
        await runtime.login("openai", "oauth", interaction, {
          agentName: "LingoSofa",
          getDeviceId: () => deviceId,
        } satisfies LoginOptions);
        this.onConnected?.();
        this.state = { connected: true, phase: "idle" };
      } catch (error) {
        // Pi may have persisted a new account before its model snapshot refresh failed.
        if (
          error instanceof CredentialSynchronizationError &&
          error.providerId === "openai" &&
          error.operation === "login" &&
          error.credential?.type === "oauth"
        )
          this.onConnected?.();
        this.state = {
          connected: false,
          phase: signal.aborted ? "idle" : "failed",
          ...(signal.aborted
            ? {}
            : {
                error:
                  "ChatGPT 登录未完成。请检查浏览器授权或本机 1455 端口，再重试。",
              }),
        };
      } finally {
        if (this.attempt === attempt) this.attempt = undefined;
        ready();
      }
    })();
    await announced;
    return this.status();
  }
  async cancel() {
    this.attempt?.controller.abort();
    await this.attempt?.task;
    return this.status();
  }
  async logout() {
    await this.cancel();
    await (await this.runtime()).logout("openai");
    this.state = { connected: false, phase: "idle" };
    return this.status();
  }
}
