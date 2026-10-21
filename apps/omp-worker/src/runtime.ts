import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFrames, sendFrame, type Frame } from "./ipc";
import { restrictedSettings, createRestrictedSession } from "./restricted-sdk";
import type { AuthCredential } from "@oh-my-pi/pi-ai";

export interface WorkerOptions {
  provider: string;
  modelId: string;
  accounts: string[];
  origin: string;
  outputCap: number;
  compaction?: { keepRecentTokens: number; reserveTokens: number };
  authOptions?: (context: {
    snapshots: Map<
      string,
      { revision: number; credential: AuthCredential | null }
    >;
    persist: (
      account: string,
      credential: AuthCredential | null,
      expected?: number,
    ) => Promise<void>;
  }) => ConstructorParameters<
    typeof import("@oh-my-pi/pi-coding-agent").AuthStorage
  >[1];
  setup?: (context: {
    sdk: typeof import("@oh-my-pi/pi-coding-agent");
    ai: typeof import("@oh-my-pi/pi-ai");
    auth: InstanceType<typeof import("@oh-my-pi/pi-coding-agent").AuthStorage>;
    registry: InstanceType<
      typeof import("@oh-my-pi/pi-coding-agent").ModelRegistry
    >;
    transport: NonNullable<
      Parameters<
        InstanceType<
          typeof import("@oh-my-pi/pi-coding-agent").ModelRegistry
        >["registerProvider"]
      >[1]["streamSimple"]
    >;
    snapshots: Map<
      string,
      { revision: number; credential: AuthCredential | null }
    >;
    cwd: string;
  }) => Promise<{
    close(): void;
    stats(): Record<string, unknown>;
    handle(frame: Frame): Promise<Record<string, unknown>>;
  }>;
}
export async function runWorker(options: WorkerOptions) {
  const { provider, modelId, outputCap } = options;
  const credentialEnvironmentPresent = Object.keys(process.env).some((name) =>
    /key|token|secret|password|credential/i.test(name),
  );

  for (const name of Object.keys(process.env)) {
    if (/key|token|secret|password|credential/i.test(name))
      delete process.env[name];
  }
  const cwd = process.cwd();
  const agentDir = join(cwd, "agent");
  await Promise.all(
    [agentDir, join(cwd, "home")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        new URL(options.origin).protocol === "http:"
          ? url.hostname !== "127.0.0.1"
          : url.origin !== options.origin
      )
        throw new Error("worker_network_scope");
      if (init?.redirect && init.redirect !== "error")
        throw new Error("worker_redirect_scope");
      return realFetch(input, { ...init, redirect: "error" });
    },
    { preconnect: () => undefined },
  );
  const sdk = await import("@oh-my-pi/pi-coding-agent");
  const ai = await import("@oh-my-pi/pi-ai");
  let instance = "";
  let nextCredentialId = 0;
  let lastRequestId = 0;
  let inFlight = 0;
  let sequence = 0;
  let closing = false;
  let providerCalls = 0;
  const activeProviderCalls = new Set<string>();
  let peakProviderCalls = 0;
  const pendingCredentials = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  const snapshots = new Map<
    string,
    { revision: number; credential: AuthCredential | null }
  >();
  const tasks = new Map<string, Promise<unknown>>();
  const sessions = new Map<
    string,
    {
      session: Awaited<ReturnType<typeof sdk.createAgentSession>>["session"];
      busy: boolean;
    }
  >();
  interface CallScope {
    requestId: number;
    sessionId: string;
    purpose: "generation" | "compaction";
    recordings: Promise<void>[];
    closed: boolean;
  }
  const operations = new AsyncLocalStorage<CallScope>();
  async function emitEvent(id: number, payload: Record<string, unknown>) {
    await sendFrame({
      v: 1,
      instance,
      kind: "event",
      id,
      payload: { ...payload, requestId: id, sequence: ++sequence },
    });
  }
  async function operation<T>(
    frame: Frame,
    purpose: CallScope["purpose"],
    run: () => Promise<T>,
  ): Promise<T> {
    const scope: CallScope = {
      requestId: frame.id,
      sessionId: String(frame.payload.sessionId),
      purpose,
      recordings: [],
      closed: false,
    };
    return operations.run(scope, async () => {
      try {
        return await run();
      } finally {
        scope.closed = true;
        await Promise.all(scope.recordings);
      }
    });
  }
  let nextAdmissionId = 0;
  const pendingAdmissions = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
  >();
  async function admissionRequest(
    method: string,
    payload: Record<string, unknown>,
  ) {
    if (pendingAdmissions.size >= 8) throw new Error("admission_limit");
    const id = ++nextAdmissionId;
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    pendingAdmissions.set(id, deferred);
    const timer = setTimeout(
      () => deferred.reject(new Error("admission_timeout")),
      3000,
    );
    try {
      await sendFrame({
        v: 1,
        instance,
        kind: "admission_request",
        id,
        method,
        payload,
      });
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
      pendingAdmissions.delete(id);
    }
  }
  const transport: NonNullable<
    Parameters<typeof registry.registerProvider>[1]["streamSimple"]
  > = (model, context, options) => {
    const scope = operations.getStore();
    if (!scope || scope.closed) throw new Error("unattributed_model_call");
    const metadata = {
      requestId: scope.requestId,
      callId: randomUUID(),
      sessionId: scope.sessionId,
      purpose: scope.purpose,
      provider: model.provider,
      model: model.id,
      pricingKnown: false,
    };
    const outer = ai.createAssistantMessageEventStream();
    const localError = (
      reason: "error" | "aborted",
      code: string,
    ): import("@oh-my-pi/pi-ai").AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      errorMessage: code,
      timestamp: Date.now(),
    });
    const recording = (async () => {
      await emitEvent(scope.requestId, { ...metadata, type: "call_requested" });
      const permit = await admissionRequest("acquire", metadata);
      if (typeof permit.admitted !== "boolean")
        throw new Error("invalid_admission_ack");
      if (!permit.admitted) {
        const error = localError("error", "admission_busy");
        outer.push({ type: "error", reason: "error", error });
        outer.end();
        return;
      }
      await emitEvent(scope.requestId, {
        ...metadata,
        type: "call_started",
        usageState: "pending",
      });
      if (options?.signal?.aborted) {
        await admissionRequest("complete", {
          ...metadata,
          usageState: "not_dispatched",
          stopReason: "cancelled_before_dispatch",
        });
        const error = localError("aborted", "cancelled_before_dispatch");
        outer.push({ type: "error", reason: "aborted", error });
        outer.end();
        return;
      }
      providerCalls++;
      activeProviderCalls.add(metadata.callId);
      peakProviderCalls = Math.max(peakProviderCalls, activeProviderCalls.size);
      let message: import("@oh-my-pi/pi-ai").AssistantMessage;
      let terminal: import("@oh-my-pi/pi-ai").AssistantMessageEvent | undefined;
      let observedUsage:
        import("@oh-my-pi/pi-ai").AssistantMessage["usage"] | undefined;
      try {
        const stream = ai.streamSimple(
          {
            ...model,
            api: "openai-completions",
          } as import("@oh-my-pi/pi-ai").Model<"openai-completions">,
          context,
          { ...options, maxHttpAttempts: 1, maxTokens: outputCap },
        );
        for await (const event of stream) {
          if ("partial" in event && event.partial.usage.totalTokens > 0)
            observedUsage = structuredClone(event.partial.usage);
          if (event.type === "done" || event.type === "error") terminal = event;
          else outer.push(event);
        }
        message = await stream.result();
      } catch {
        message = localError(
          options?.signal?.aborted ? "aborted" : "error",
          "provider_stream_failed",
        );
        terminal = {
          type: "error",
          reason: message.stopReason as "error" | "aborted",
          error: message,
        };
      } finally {
        activeProviderCalls.delete(metadata.callId);
      }
      const { input, output, cacheRead, cacheWrite, totalTokens } =
        message.usage.totalTokens > 0
          ? message.usage
          : (observedUsage ?? message.usage);
      const usageState =
        totalTokens > 0
          ? message.usage.totalTokens > 0 &&
            ["stop", "length", "toolUse"].includes(message.stopReason)
            ? "reported"
            : "partial"
          : "unknown";
      const completed = {
        ...metadata,
        type: "call_completed",
        stopReason: message.stopReason,
        usageState,
        ...(totalTokens > 0
          ? { usage: { input, output, cacheRead, cacheWrite, totalTokens } }
          : {}),
      };
      const ack = await admissionRequest("complete", completed);
      if (ack.committed !== true) throw new Error("invalid_terminal_ack");
      await emitEvent(scope.requestId, completed);
      // The SDK cannot complete the operation before Rust commits the terminal.
      if (terminal) outer.push(terminal);
      outer.end(message);
    })();
    scope.recordings.push(recording);
    void recording.catch(() => process.exit(2));
    return outer;
  };

  async function credentialRequest(
    method: string,
    payload: Record<string, unknown>,
  ) {
    if (pendingCredentials.size >= 8) throw new Error("credential_busy");
    const id = ++nextCredentialId;
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    pendingCredentials.set(id, deferred);
    try {
      await sendFrame({
        v: 1,
        instance,
        kind: "credential_request",
        id,
        method,
        payload,
      });
      return await Promise.race([
        deferred.promise,
        Bun.sleep(3000).then(() => {
          throw new Error("credential_timeout");
        }),
      ]);
    } finally {
      pendingCredentials.delete(id);
    }
  }

  async function persist(
    account: string,
    credential: AuthCredential | null,
    expectedRevision = snapshots.get(account)?.revision,
  ) {
    const current = snapshots.get(account);
    if (!current || expectedRevision === undefined)
      throw new Error("unknown_account");
    const response = await credentialRequest("commit", {
      account,
      expected: expectedRevision,
      credential,
    });
    if (
      !Number.isSafeInteger(response.revision) ||
      (response.revision as number) !== expectedRevision + 1
    )
      throw new Error("invalid_commit_ack");
    snapshots.set(account, {
      revision: response.revision as number,
      credential,
    });
  }

  const backing = await ai.SqliteAuthCredentialStore.open(":memory:");
  // Synchronous SDK CAS writes can only mirror tokens already committed by Rust.
  const mirrored = new Proxy(backing, {
    get(target, property) {
      if (
        property === "upsertAuthCredential" ||
        property === "replaceAuthCredentials"
      )
        return async (
          account: string,
          credentials: AuthCredential | AuthCredential[],
        ) => {
          const credential = Array.isArray(credentials)
            ? credentials[0]
            : credentials;
          if (
            !credential ||
            (Array.isArray(credentials) && credentials.length !== 1)
          )
            throw new Error("single_account_required");
          await persist(account, credential);
          return target.replaceAuthCredentials(account, [credential]);
        };
      if (property === "deleteAuthCredentials")
        return async (account: string, cause: string) => {
          await persist(account, null);
          return target.deleteAuthCredentials(account, cause);
        };
      if (property === "tryUpdateAuthCredentialIfMatches")
        return (id: number, expected: string, credential: AuthCredential) => {
          const row = target.listAuthCredentials().find((row) => row.id === id);
          const committed = row && snapshots.get(row.provider)?.credential;
          if (
            !committed ||
            committed.type !== "oauth" ||
            credential.type !== "oauth" ||
            committed.access !== credential.access ||
            committed.refresh !== credential.refresh ||
            committed.expires !== credential.expires
          )
            throw new Error("uncommitted_credential");
          return target.tryUpdateAuthCredentialIfMatches(
            id,
            expected,
            credential,
          );
        };
      if (
        [
          "updateAuthCredential",
          "deleteAuthCredential",
          "tryDisableAuthCredentialIfMatches",
        ].includes(String(property))
      )
        return () => {
          throw new Error("unsupported_persistent_mutation");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const auth = new sdk.AuthStorage(mirrored, {
    usageProviderResolver: () => undefined,
    ...options.authOptions?.({ snapshots, persist }),
  });
  const registry = new sdk.ModelRegistry(auth, join(agentDir, "models.yml"), {
    settings: restrictedSettings(sdk),
    ignoreLocalModelConfig: true,
    fetch: globalThis.fetch,
  });

  const extension = await options.setup?.({
    sdk,
    ai,
    auth,
    registry,
    transport,
    snapshots,
    cwd,
  });

  function sessionEntry(payload: Record<string, unknown>) {
    const entry = sessions.get(String(payload.sessionId));
    if (!entry) throw new Error("session_lost");
    return entry;
  }

  async function handle(frame: Frame): Promise<Record<string, unknown>> {
    switch (frame.method) {
      case "hello": {
        if (frame.payload.sdk !== "18.12.3") throw new Error("sdk_mismatch");
        for (const account of options.accounts) {
          const snapshot = await credentialRequest("read", { account });
          snapshots.set(
            account,
            snapshot as { revision: number; credential: AuthCredential | null },
          );
          if (snapshot.credential)
            await backing.replaceAuthCredentials(account, [
              snapshot.credential as AuthCredential,
            ]);
          if (
            account === "deepseek" &&
            (snapshot.credential as AuthCredential | null)?.type === "api_key"
          ) {
            auth.keys.setRuntime(
              provider,
              (snapshot.credential as { key: string }).key,
            );
          }
        }
        await auth.credentials.reload();
        return { sdk: "18.12.3", pid: process.pid, protocol: 1 };
      }
      case "ping":
        return { pong: true };
      case "model.verify": {
        if (extension) return extension.handle(frame);
        const credential = snapshots.get("deepseek")?.credential;
        if (credential?.type !== "api_key") throw new Error("account_missing");
        const response = await fetch("https://api.deepseek.com/models", {
          headers: { authorization: `Bearer ${credential.key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("catalog_failed");
        const catalog = (await response.json()) as {
          data: {
            id: string;
            name: string;
            context_window: number;
            max_output_tokens: number;
          }[];
        };
        const selected = catalog.data.find(
          (entry) => entry.id === "deepseek-flash",
        );
        if (
          !selected ||
          !selected.name.includes("V4.1") ||
          !Number.isSafeInteger(selected.context_window) ||
          !Number.isSafeInteger(selected.max_output_tokens) ||
          selected.context_window < 8192 ||
          selected.max_output_tokens < options.outputCap
        )
          throw new Error("model_not_verified");
        registry.registerProvider("deepseek", {
          api: "lingo-worker",
          apiKey: "LINGO_RUNTIME_ACCOUNT",
          baseUrl: "https://api.deepseek.com",
          streamSimple: transport,
          models: [
            {
              id: selected.id,
              name: selected.name,
              input: ["text"],
              reasoning: false,
              supportsTools: false,
              contextWindow: selected.context_window,
              maxTokens: outputCap,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        });
        return {
          id: selected.id,
          name: selected.name,
          contextWindow: selected.context_window,
          requestOutputCap: options.outputCap,
          credentialSource: "rust-vault",
        };
      }
      case "stats":
        return {
          providerCalls,
          activeProviderCalls: activeProviderCalls.size,
          activeCallIds: [...activeProviderCalls],
          peakProviderCalls,
          credentialEnvironmentPresent,
          ...extension?.stats(),
          sessions: sessions.size,
          tasks: tasks.size,
        };
      case "session.create": {
        if (snapshots.get("deepseek")?.credential?.type !== "api_key")
          throw new Error("account_missing");
        if (sessions.size >= 4) throw new Error("session_limit");
        const { session } = await createRestrictedSession(
          sdk,
          {
            cwd,
            agentDir,
            authStorage: auth,
            modelRegistry: registry,
            model:
              registry.find(provider, modelId) ??
              (() => {
                throw new Error("model_not_verified");
              })(),
          },
          options.compaction,
        );
        const sessionId = randomUUID();
        sessions.set(sessionId, { session, busy: false });
        return { sessionId, tools: session.getActiveToolNames() };
      }
      case "prompt": {
        const entry = sessionEntry(frame.payload);
        if (
          entry.busy ||
          typeof frame.payload.text !== "string" ||
          Buffer.byteLength(frame.payload.text) > 16000
        )
          throw new Error("invalid_prompt");
        entry.busy = true;
        const unsubscribe = entry.session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          )
            void emitEvent(frame.id, {
              sessionId: frame.payload.sessionId,
              type: "text_delta",
              text: event.assistantMessageEvent.delta,
            }).catch(() => process.exit(2));
        });
        const prompt = operation(frame, "generation", () =>
          entry.session.prompt(frame.payload.text as string),
        );
        tasks.set(String(frame.payload.sessionId), prompt);
        try {
          await prompt;
          const last = entry.session.messages.at(-1);
          return {
            status: last?.role === "assistant" ? last.stopReason : "unknown",
            sessionId: frame.payload.sessionId,
          };
        } finally {
          unsubscribe();
          tasks.delete(String(frame.payload.sessionId));
          entry.busy = false;
        }
      }
      case "session.compact": {
        const entry = sessionEntry(frame.payload);
        if (entry.busy) throw new Error("session_busy");
        entry.busy = true;
        const compact = operation(frame, "compaction", () =>
          entry.session.compact(
            "Preserve original text, names, terminology, intent, and unanswered questions.",
            { mode: "soft" },
          ),
        );
        tasks.set(String(frame.payload.sessionId), compact);
        try {
          const result = await compact;
          return {
            summaryCommitted: result.summary.length > 0,
            sessionId: frame.payload.sessionId,
          };
        } catch (error) {
          if (
            error instanceof Error &&
            error.name === "ManualCompactionNoOpError"
          )
            return {
              summaryCommitted: false,
              reason: "nothing_to_compact",
              sessionId: frame.payload.sessionId,
            };
          throw error;
        } finally {
          tasks.delete(String(frame.payload.sessionId));
          entry.busy = false;
        }
      }
      case "cancel":
        await sessionEntry(frame.payload).session.abort();
        return { accepted: true };
      case "session.close": {
        const entry = sessionEntry(frame.payload);
        if (entry.busy) throw new Error("session_busy");
        await entry.session.dispose();
        sessions.delete(String(frame.payload.sessionId));
        return { closed: true };
      }
      case "shutdown":
        if (
          sessions.size ||
          tasks.size ||
          inFlight > 1 ||
          pendingCredentials.size ||
          pendingAdmissions.size
        )
          throw new Error("worker_busy");
        closing = true;
        return { stopped: true };
      default:
        if (extension) return extension.handle(frame);
        throw new Error("method_not_allowed");
    }
  }

  try {
    for await (const frame of readFrames()) {
      if (frame.kind === "admission_response") {
        const pending = pendingAdmissions.get(frame.id);
        if (
          frame.instance !== instance ||
          !pending ||
          frame.ok !== true ||
          frame.method !== undefined
        )
          throw new Error("unexpected_admission_response");
        pending.resolve(frame.payload);
        continue;
      }
      if (frame.kind === "credential_response") {
        const pending = pendingCredentials.get(frame.id);
        if (
          frame.instance !== instance ||
          !pending ||
          typeof frame.ok !== "boolean"
        )
          throw new Error("unexpected_credential_response");
        if (frame.ok) pending.resolve(frame.payload);
        else pending.reject(new Error("credential_commit_rejected"));
        continue;
      }
      if (
        frame.kind !== "request" ||
        frame.id <= lastRequestId ||
        closing ||
        (instance && instance !== frame.instance) ||
        (!instance && frame.method !== "hello") ||
        (instance && frame.method === "hello")
      )
        throw new Error("invalid_request");
      instance ||= frame.instance;
      lastRequestId = frame.id;
      if (inFlight >= 8) throw new Error("request_limit");
      inFlight++;
      void handle(frame)
        .then(
          (payload) =>
            sendFrame({
              v: 1,
              instance,
              kind: "response",
              id: frame.id,
              ok: true,
              payload,
            }),
          () =>
            sendFrame({
              v: 1,
              instance,
              kind: "response",
              id: frame.id,
              ok: false,
              payload: { code: "operation_failed" },
            }),
        )
        .then(async () => {
          inFlight--;
          if (closing) {
            extension?.close();
            auth.close();
            process.exit(0);
          }
        })
        .catch(() => process.exit(2));
    }
  } catch {
    process.stderr.write("WORKER_PROTOCOL_FAILURE\n");
  }
  for (const entry of sessions.values()) await entry.session.dispose();
  extension?.close();
  auth.close();
  process.exit(2);
}
