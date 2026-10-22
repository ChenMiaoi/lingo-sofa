import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFrames, sendFrame, type Frame } from "./ipc";
import {
  restrictedSettings,
  createRestrictedSession,
  type Thinking,
} from "./restricted-sdk";
import {
  SubscriptionLogin,
  safeAuthorizationUrl,
  subscriptionProviders,
} from "./subscription-login";
import { WorkerModels } from "./models";
import {
  SessionHistory,
  sessionSnapshot,
  displayMetadata,
} from "./session-history";
import { ToolApprovals } from "./tool-approval";
import { activityChunk } from "./session-activity";
import type {
  OAuthProvider as AIProvider,
  AuthCredential,
} from "@oh-my-pi/pi-ai";

function toolResultText(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content)
  ) {
    return value.content
      .map((part: unknown) =>
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
          ? part.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(value) ?? "";
}

export interface WorkerOptions {
  provider: string;
  modelId: string;
  accounts: string[];
  origin: string;
  outputCap: number;
  nativeApi?: import("@oh-my-pi/pi-ai").Api;
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
// Durable host acknowledgements may include OS credential-store and disk work.
// Match the host request budget while retaining a finite failure deadline.
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

export async function runWorker(options: WorkerOptions) {
  const { provider, modelId, outputCap, nativeApi } = options;
  let selection = { provider, modelId };
  let catalog: WorkerModels | undefined;
  let verifiedModel: string | undefined;
  const authorization = new AsyncLocalStorage<{
    provider: string;
    signal?: AbortSignal;
  }>();
  const allowedOrigins = new Set([options.origin]);
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
  process.env.PI_AUTH_NO_BORROW = "1";
  process.env.PI_CODEX_WEBSOCKET = "0";
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const login = authorization.getStore();
      if (login?.signal?.aborted) throw new Error("login_cancelled");
      if (login && !safeAuthorizationUrl(url.href))
        throw new Error("worker_auth_network_scope");
      if (
        !login &&
        (new URL(options.origin).protocol === "http:"
          ? url.hostname !== "127.0.0.1"
          : !allowedOrigins.has(url.origin))
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
  const history = new SessionHistory(sdk, cwd);
  const approvals = new ToolApprovals();
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
      CONTROL_REQUEST_TIMEOUT_MS,
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
      pricingKnown:
        snapshots.get(model.provider)?.credential?.type === "api_key" &&
        Object.values((catalog ? catalog.native(model) : model).cost).some(
          (cost) => cost > 0,
        ),
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
        const native = catalog
          ? catalog.native(model)
          : { ...model, api: nativeApi ?? model.api };
        const stream = ai.streamSimple(native, context, {
          ...options,
          maxHttpAttempts: 1,
          codexSseMaxAttempts: 1,
          maxTokens: Math.min(outputCap, native.maxTokens ?? outputCap),
        });
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
      const { input, output, cacheRead, cacheWrite, totalTokens, cost } =
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
          ? {
              usage: { input, output, cacheRead, cacheWrite, totalTokens },
              estimatedCost: metadata.pricingKnown ? cost.total : null,
            }
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
    const timer = setTimeout(
      () => deferred.reject(new Error("credential_timeout")),
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    try {
      await sendFrame({
        v: 1,
        instance,
        kind: "credential_request",
        id,
        method,
        payload,
      });
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
      pendingCredentials.delete(id);
    }
  }

  async function persist(
    account: string,
    credential: AuthCredential | null,
    expectedRevision = snapshots.get(account)?.revision,
  ) {
    const login = authorization.getStore();
    if (login?.signal?.aborted) throw new Error("login_cancelled");
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
    async refreshOAuthCredential(account, _id, current, signal) {
      const expected = snapshots.get(account)?.revision;
      if (expected === undefined || !ai.getProviderDefinition(account)?.login)
        throw new Error("unknown_account");
      const refreshed = await authorization.run(
        { provider: account, signal },
        () => ai.refreshOAuthToken(account as AIProvider, current, signal),
      );
      if (signal?.aborted) throw new Error("refresh_cancelled");
      const credential = { ...current, ...refreshed, type: "oauth" as const };
      await persist(account, credential, expected);
      return credential;
    },
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

  if (!extension)
    catalog = new WorkerModels(
      registry,
      ai,
      transport,
      (origin) => allowedOrigins.add(origin),
      outputCap,
    );

  const login = new SubscriptionLogin(
    {
      oauth: {
        login: (provider, controller) =>
          authorization.run({ provider, signal: controller.signal }, () =>
            auth.oauth.login(provider, controller),
          ),
      },
    },
    subscriptionProviders(
      ai,
      new Set(registry.getAll().map((model) => model.provider)),
    ),
    globalThis.fetch,
  );

  function sessionEntry(payload: Record<string, unknown>) {
    const entry = sessions.get(String(payload.sessionId));
    if (!entry) throw new Error("session_lost");
    return entry;
  }

  async function handle(frame: Frame): Promise<Record<string, unknown>> {
    switch (frame.method) {
      case "hello": {
        if (frame.payload.sdk !== "18.12.3") throw new Error("sdk_mismatch");
        const accounts = frame.payload.accounts ?? options.accounts;
        if (
          !Array.isArray(accounts) ||
          accounts.length > 128 ||
          accounts.some(
            (account) =>
              typeof account !== "string" ||
              !/^[a-zA-Z0-9_-]{1,64}$/.test(account),
          )
        )
          throw new Error("invalid_accounts");
        for (const account of accounts as string[]) {
          const snapshot = await credentialRequest("read", { account });
          snapshots.set(
            account,
            snapshot as { revision: number; credential: AuthCredential | null },
          );
          if (snapshot.credential && options.setup)
            await backing.replaceAuthCredentials(account, [
              snapshot.credential as AuthCredential,
            ]);
          if (
            options.setup &&
            (snapshot.credential as AuthCredential | null)?.type === "api_key"
          ) {
            auth.keys.setRuntime(
              account,
              (snapshot.credential as { key: string }).key,
            );
          }
        }
        await auth.credentials.reload();
        return { sdk: "18.12.3", pid: process.pid, protocol: 1 };
      }
      case "auth.providers":
        if (extension) return extension.handle(frame);
        return {
          providers: login.providers.map((entry) => ({
            ...entry,
            modelsSupported: catalog?.list(entry.provider).supported ?? true,
          })),
        };
      case "auth.start":
        if (extension) return extension.handle(frame);
        return { ...login.start(String(frame.payload.provider)) };
      case "auth.status":
        if (extension) return extension.handle(frame);
        return { ...login.status(String(frame.payload.attempt)) };
      case "auth.input":
        if (extension) return extension.handle(frame);
        return {
          ...login.input(
            String(frame.payload.attempt),
            Number(frame.payload.prompt),
            String(frame.payload.value),
          ),
        };
      case "auth.cancel":
        if (extension) return extension.handle(frame);
        return { ...login.cancel(String(frame.payload.attempt)) };
      case "ping":
        return { pong: true };
      case "model.catalog": {
        if (extension) return extension.handle(frame);
        return catalog!.list(
          typeof frame.payload.provider === "string"
            ? frame.payload.provider
            : undefined,
          typeof frame.payload.offset === "number" ? frame.payload.offset : 0,
        );
      }
      case "model.resolve": {
        if (extension) return extension.handle(frame);
        const selected = catalog!.resolve(
          String(frame.payload.provider),
          String(frame.payload.modelId),
        );
        return { provider: selected.provider, modelId: selected.id };
      }
      case "model.verify": {
        if (extension) {
          const response = await extension.handle(frame);
          if (
            typeof response.provider === "string" &&
            typeof response.modelId === "string"
          ) {
            selection = {
              provider: response.provider,
              modelId: response.modelId,
            };
          }
          return response;
        }
        const next = {
          provider:
            typeof frame.payload.provider === "string"
              ? frame.payload.provider
              : provider,
          modelId:
            typeof frame.payload.modelId === "string"
              ? frame.payload.modelId
              : modelId,
        };
        if (!snapshots.get(next.provider)?.credential)
          throw new Error("account_missing");
        const identity = `${next.provider}/${next.modelId}`;
        if (verifiedModel && verifiedModel !== identity)
          throw new Error("model_switch_requires_restart");
        catalog!.resolve(next.provider, next.modelId);
        const credential = snapshots.get(next.provider)!.credential!;
        if (credential.type === "oauth") {
          for (const endpoint of [
            credential.apiEndpoint,
            credential.enterpriseUrl,
          ]) {
            if (endpoint && safeAuthorizationUrl(endpoint))
              allowedOrigins.add(new URL(endpoint).origin);
          }
        }
        // Only the selected provider is available to SDK maintenance/fallback
        // paths. Other configured keys stay in the vault snapshot, not SDK auth.
        await backing.replaceAuthCredentials(next.provider, [credential]);
        if (credential.type === "api_key")
          auth.keys.setRuntime(next.provider, credential.key);
        await auth.credentials.reload();
        const result = catalog!.activate(next.provider, next.modelId);
        verifiedModel = identity;
        selection = next;
        return result;
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
      case "session.list": {
        const offset = Number(frame.payload.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("invalid_page");
        const all = await history.list();
        return {
          sessions: all.slice(offset, offset + 50).map((item) => ({
            id: item.id,
            title: (item.title || item.firstMessage || "空白会话").slice(
              0,
              100,
            ),
            modified: item.modified.toISOString(),
            messageCount: item.messageCount,
          })),
          total: all.length,
        };
      }
      case "session.latest":
        return { id: await history.current() };
      case "session.reset":
        await Promise.all(
          [...sessions.values()].map((entry) => entry.session.abort()),
        );
        await Promise.allSettled([...tasks.values()]);
        for (const entry of sessions.values()) {
          await entry.session.sessionManager.flush();
          await entry.session.dispose();
        }
        sessions.clear();
        await history.select(null);
        return {};
      case "session.decision": {
        if (typeof frame.payload.approved !== "boolean")
          throw new Error("invalid_approval");
        approvals.decide(
          String(frame.payload.sessionId),
          String(frame.payload.id),
          frame.payload.approved,
        );
        return {};
      }
      case "session.activity": {
        const entry = sessionEntry(frame.payload);
        if (entry.busy) throw new Error("session_busy");
        return activityChunk(
          entry.session.sessionManager,
          Number(frame.payload.offset ?? 0),
          typeof frame.payload.version === "string"
            ? frame.payload.version
            : undefined,
        );
      }
      case "session.snapshot": {
        const entry = sessionEntry(frame.payload);
        return {
          ...sessionSnapshot(entry.session),
          metadata: displayMetadata(
            history.metadata(entry.session.sessionManager),
          ),
        };
      }
      case "session.configure": {
        const entry = sessionEntry(frame.payload);
        if (entry.busy) throw new Error("session_busy");
        const thinking = String(frame.payload.thinking ?? "off");
        if (
          !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
            thinking,
          )
        )
          throw new Error("invalid_thinking");
        entry.session.setThinkingLevel(thinking as Thinking, true);
        await entry.session.setActiveToolsByName(
          frame.payload.tools === true
            ? ["read", "bash", "edit", "write", "grep", "find"]
            : [],
        );
        return { thinking: entry.session.thinkingLevel };
      }
      case "session.open":
      case "session.create": {
        if (sessions.size >= 4) throw new Error("session_limit");
        if (frame.method === "session.create") {
          const model = registry.find(selection.provider, selection.modelId);
          if (!model || !snapshots.get(selection.provider)?.credential)
            throw new Error("account_missing");
          if (catalog) catalog.native(model);
        }
        const manager =
          frame.method === "session.open"
            ? await history.open(String(frame.payload.id))
            : await history.create({
                ...selection,
                operation: String(frame.payload.operation ?? "ask"),
                context: frame.payload.context,
              });
        try {
          if (
            frame.method === "session.create" &&
            typeof frame.payload.title === "string"
          )
            await manager.setSessionName(
              frame.payload.title.slice(0, 80),
              "user",
            );
          const metadata = history.metadata(manager);
          if (!snapshots.get(metadata.provider)?.credential)
            throw new Error("account_missing");
          if (frame.method === "session.open")
            await handle({
              ...frame,
              method: "model.verify",
              payload: {
                provider: metadata.provider,
                modelId: metadata.modelId,
              },
            });
          const selectedModel = registry.find(
            metadata.provider,
            metadata.modelId,
          );
          if (!selectedModel) throw new Error("model_not_verified");
          const { session } = await createRestrictedSession(
            sdk,
            {
              cwd,
              agentDir,
              authStorage: auth,
              modelRegistry: registry,
              model: selectedModel,
            },
            options.compaction,
            {
              manager,
              thinking: frame.payload.thinking as Thinking | undefined,
              tools: frame.payload.tools === true,
            },
          );
          if (frame.payload.tools !== true)
            await session.setActiveToolsByName([]);
          const sessionId = manager.getSessionId();
          const beforeToolCall = session.agent.beforeToolCall;
          session.agent.beforeToolCall = async (context, signal) => {
            const original = await beforeToolCall?.(context, signal);
            if (original?.block) return original;
            const requestId = operations.getStore()?.requestId;
            if (!requestId)
              return { block: true, reason: "tool_without_request" };
            const args = JSON.stringify(original?.args ?? context.args);
            if (Buffer.byteLength(args) > 12_000)
              return {
                block: true,
                reason:
                  "Tool arguments exceed the review limit. Use a smaller request.",
              };
            const id = randomUUID();
            const approved = await approvals.request(
              sessionId,
              id,
              signal,
              () =>
                emitEvent(requestId, {
                  type: "tool_approval",
                  sessionId,
                  id,
                  name: context.tool.name,
                  args,
                  cwd,
                }),
            );
            await emitEvent(requestId, {
              type: "tool_approval_closed",
              sessionId,
              id,
            });
            return approved
              ? original
              : {
                  block: true,
                  reason: "User denied or cancelled tool execution.",
                };
          };
          sessions.set(sessionId, { session, busy: false });
          await history.select(sessionId);
          return {
            sessionId,
            tools: session.getActiveToolNames(),
            metadata: displayMetadata(metadata),
            ...sessionSnapshot(session),
          };
        } catch (error) {
          await manager.close();
          throw error;
        }
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
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            if (
              update.type === "text_delta" ||
              update.type === "thinking_delta"
            )
              void emitEvent(frame.id, {
                sessionId: frame.payload.sessionId,
                type: update.type,
                text: update.delta,
              }).catch(() => process.exit(2));
          } else if (
            event.type === "tool_execution_start" ||
            event.type === "tool_execution_end"
          ) {
            const text =
              event.type === "tool_execution_start"
                ? JSON.stringify(event.args)
                : toolResultText(event.result);
            void emitEvent(frame.id, {
              sessionId: frame.payload.sessionId,
              type: event.type,
              id: event.toolCallId,
              name: event.toolName,
              text:
                text.length > 4000
                  ? text.slice(0, 4000) + "\n…（显示内容已截断）"
                  : text,
              isError: event.type === "tool_execution_end" && event.isError,
            }).catch(() => process.exit(2));
          }
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
          await entry.session.sessionManager.flush();
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
        await entry.session.sessionManager.flush();
        await entry.session.dispose();
        sessions.delete(String(frame.payload.sessionId));
        return { closed: true };
      }
      case "shutdown":
        login.close();
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
