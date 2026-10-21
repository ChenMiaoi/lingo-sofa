import { restrictedSettings, createRestrictedSession } from "./restricted-sdk";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only an explicitly opted-in test key survives into this isolated SDK process.
const liveKey = process.env.W0_LIVE_KEY;
for (const name of Object.keys(process.env)) {
  if (/key|token|secret|password|credential/i.test(name))
    delete process.env[name];
}
const root = await mkdtemp(join(tmpdir(), "lingo-sofa-omp-w0-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
await Promise.all(
  [home, agentDir, cwd].map((dir) => mkdir(dir, { recursive: true })),
);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.chdir(cwd);
const network: { host: string; path: string; method: string }[] = [];
const realFetch = globalThis.fetch;
const guardedFetch: typeof fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    network.push({
      host: url.hostname,
      path: url.pathname,
      method: init?.method ?? "GET",
    });
    if (
      url.hostname !== "127.0.0.1" &&
      !(liveKey && url.origin === "https://api.deepseek.com")
    ) {
      throw new Error("W0_NETWORK_SCOPE_REJECTED");
    }
    return realFetch(input, init);
  },
  { preconnect: () => undefined },
);
globalThis.fetch = guardedFetch;
const sdk = await import("@oh-my-pi/pi-coding-agent");
const ai = await import("@oh-my-pi/pi-ai");
const results: { name: string; passed: boolean; detail?: unknown }[] = [];
let activeCheck = "setup";
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  activeCheck = name;
  try {
    results.push({ name, passed: true, detail: await fn() });
    process.stderr.write(`PASS ${name}\n`);
  } catch (error) {
    // Never serialize raw provider exceptions, request headers or credentials.
    process.stderr.write(`FAIL ${name}\n`);
    results.push({
      name,
      passed: false,
      detail:
        error instanceof Error
          ? error.message
              .replaceAll(liveKey ?? "\0", "[redacted]")
              .slice(0, 500)
          : "unknown",
    });
  }
}
const requests: {
  callId: string | null;
  authorization: string | null;
  messages: unknown[];
  tools: unknown;
  model: string;
}[] = [];
let mode: "normal" | "401" | "429" | "compaction-fail" | "slow" | "slow-empty" =
  "normal";
const providerReplies: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: unknown[];
      tools?: unknown;
      model: string;
      stream?: boolean;
    };
    requests.push({
      callId: request.headers.get("x-w0-call-id"),
      authorization: request.headers.get("authorization"),
      messages: body.messages,
      tools: body.tools,
      model: body.model,
    });
    if (["401", "429", "compaction-fail"].includes(mode))
      return Response.json(
        {
          error: {
            message: "W0 synthetic failure",
            type: "invalid_request_error",
          },
        },
        { status: mode === "401" ? 401 : mode === "429" ? 429 : 500 },
      );
    const text = "W0 verified summary and response.";
    const usage = {
      prompt_tokens: 80,
      completion_tokens: 8,
      total_tokens: 88,
      prompt_tokens_details: { cached_tokens: 12 },
    };
    if (!body.stream)
      return Response.json({
        id: "w0",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    const chunks = [
      {
        id: "w0",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: text },
            finish_reason: null,
          },
        ],
      },
      {
        id: "w0",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "w0",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [],
        usage,
      },
    ];
    if (mode === "slow" || mode === "slow-empty") {
      const initialChunk =
        mode === "slow-empty"
          ? ": waiting for output\n\n"
          : `data: ${JSON.stringify(chunks[0])}\n\n`;
      let timer: ReturnType<typeof setTimeout>;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(initialChunk));
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            }, 5000);
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const store = await ai.SqliteAuthCredentialStore.open(":memory:");
const auth = new sdk.AuthStorage(store, {
  usageProviderResolver: () => undefined,
});
auth.keys.setRuntime("w0", "w0-synthetic-key");
const calls: {
  callId: string;
  check: string;
  purpose: string;
  usage: unknown;
  stopReason: string;
}[] = [];
let purpose = "generation";
let callSequence = 0;
const sessions: Awaited<
  ReturnType<typeof sdk.createAgentSession>
>["session"][] = [];
const settings = () => restrictedSettings(sdk);
const registry = new sdk.ModelRegistry(auth, join(root, "models.yml"), {
  ignoreLocalModelConfig: true,
  settings: settings(),
  fetch: guardedFetch,
});
const governedTransport: NonNullable<
  Parameters<typeof registry.registerProvider>[1]["streamSimple"]
> = (model, context, options) => {
  const callPurpose = purpose;
  const callCheck = activeCheck;
  const callId = String(++callSequence);
  const stream = ai.streamSimple(
    {
      ...model,
      api: "openai-completions",
    } as import("@oh-my-pi/pi-ai").Model<"openai-completions">,
    context,
    {
      ...options,
      maxHttpAttempts: 1,
      maxTokens: 512,
      headers: { ...options?.headers, "x-w0-call-id": callId },
    },
  );
  void stream.result().then((message) => {
    calls.push({
      callId,
      check: callCheck,
      purpose: callPurpose,
      usage: message.usage,
      stopReason: message.stopReason,
    });
    providerReplies.push(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );
  });
  return stream;
};
registry.registerProvider("w0", {
  api: "lingo-w0",
  apiKey: "w0-synthetic-key",
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  streamSimple: governedTransport,
  models: [
    {
      id: "w0-model",
      name: "W0 synthetic",
      reasoning: false,
      input: ["text"],
      supportsTools: false,
      contextWindow: 8192,
      maxTokens: 1024,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    },
  ],
});
async function create(
  model = registry.find("w0", "w0-model")!,
  customAuth = auth,
  customRegistry = registry,
) {
  const result = await createRestrictedSession(sdk, {
    cwd,
    agentDir,
    model,
    authStorage: customAuth,
    modelRegistry: customRegistry,
  });
  sessions.push(result.session);
  return result.session;
}
try {
  await check("platform-sdk-native-import", () => ({
    platform: process.platform,
    architecture: process.arch,
    bun: Bun.version,
    sdk: "18.12.3",
  }));
  await check("auth-custom-store-login-refresh-logout", async () => {
    const backing = await ai.SqliteAuthCredentialStore.open(":memory:");
    let writes = 0;
    let failWrites = false;
    let refreshes = 0;
    const intercepted = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            [
              "upsertAuthCredential",
              "replaceAuthCredentials",
              "updateAuthCredential",
              "tryUpdateAuthCredentialIfMatches",
            ].includes(String(property))
          ) {
            writes++;
            if (failWrites) throw new Error("W0_PERSISTENCE_FAILURE");
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    const loginAuth = new sdk.AuthStorage(intercepted, {
      usageProviderResolver: () => undefined,
      refreshOAuthCredential: async (_provider, _id, credential) => {
        refreshes++;
        await Bun.sleep(20);
        return {
          ...credential,
          access: "w0-new-access",
          refresh: "w0-new-refresh",
          expires: Date.now() + 3600000,
        };
      },
    });
    const loginRegistry = new sdk.ModelRegistry(
      loginAuth,
      join(root, "login-models.yml"),
      {
        ignoreLocalModelConfig: true,
        settings: settings(),
        fetch: guardedFetch,
      },
    );
    loginRegistry.registerProvider("w0-oauth", {
      oauth: {
        name: "W0 synthetic OAuth",
        async login(callbacks) {
          callbacks.signal?.throwIfAborted();
          callbacks.onAuth({ url: "https://w0.invalid/authorize" });
          return {
            access: "w0-old-access",
            refresh: "w0-old-refresh",
            expires: Date.now() - 120000,
          };
        },
        getApiKey: (credential) => credential.access,
      },
    });
    try {
      let urls = 0;
      const callbacks = {
        onAuth: () => {
          urls++;
        },
        onPrompt: async () => "unused",
      };
      await loginAuth.oauth.login("w0-oauth", callbacks);
      assert.equal(urls, 1);
      const resolved = await Promise.all([
        loginAuth.keys.get("w0-oauth", "refresh-a"),
        loginAuth.keys.get("w0-oauth", "refresh-b"),
      ]);
      assert.deepEqual(resolved, ["w0-new-access", "w0-new-access"]);
      assert.equal(refreshes, 1);
      assert.ok(writes >= 2);
      await loginAuth.credentials.set("w0-oauth", {
        type: "oauth",
        access: "w0-expired",
        refresh: "w0-fail-refresh",
        expires: Date.now() - 120000,
      });
      failWrites = true;
      const failedKey = await loginAuth.keys
        .get("w0-oauth", "refresh-failure")
        .catch(() => undefined);
      assert.equal(
        failedKey,
        undefined,
        "Failed credential commit must not return a token",
      );
      failWrites = false;
      assert.equal(
        backing.listAuthCredentials("w0-oauth")[0]!.credential.type,
        "oauth",
      );
      await loginAuth.credentials.remove("w0-oauth");
      assert.equal(await loginAuth.keys.get("w0-oauth"), undefined);
      const cancelled = AbortSignal.abort();
      await assert.rejects(
        loginAuth.oauth.login("w0-oauth", { ...callbacks, signal: cancelled }),
      );
      return {
        syntheticOAuth: true,
        customStoreWrites: writes,
        singleConcurrentRefresh: true,
        failedCommitRejected: true,
        logout: true,
        cancelledLogin: true,
        realBrowserOAuth: "not-tested",
      };
    } finally {
      loginAuth.close();
    }
  });
  const first = await create();
  const second = await create();
  await check("isolated-concurrent-session-construction", () => {
    assert.deepEqual(first.getActiveToolNames(), []);
    assert.deepEqual(second.getActiveToolNames(), []);
    assert.equal(first.sessionFile, undefined);
    assert.notEqual(first.sessionId, second.sessionId);
    return { tools: [], persistentSessionFile: false };
  });
  await check("actual-sdk-stream-and-history", async () => {
    const eventTypes: string[] = [];
    const stop = first.subscribe((event) => eventTypes.push(event.type));
    await first.prompt(
      "W0 private session marker ALPHA. " +
        "This is a synthetic reading note about translation architecture. ".repeat(
          100,
        ),
    );
    await first.prompt("Remember ALPHA and answer briefly.");
    stop();
    assert.ok(eventTypes.includes("message_update"));
    assert.ok(requests.length >= 2);
    assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("ALPHA"));
    assert.equal(requests.at(-1)!.authorization, "Bearer w0-synthetic-key");
    assert.ok(
      !requests.at(-1)!.tools ||
        (requests.at(-1)!.tools as unknown[]).length === 0,
    );
    return {
      requests: requests.length,
      events: [...new Set(eventTypes)],
      stats: first.getSessionStats(),
    };
  });
  await check("second-session-does-not-inherit-history", async () => {
    await second.prompt("W0 independent session BETA");
    assert.ok(!JSON.stringify(requests.at(-1)!.messages).includes("ALPHA"));
    return { isolated: true };
  });
  await check("manual-pi-session-compaction", async () => {
    const before = requests.length;
    purpose = "compaction";
    const compact = await first.compact("Preserve ALPHA and user intent.", {
      mode: "soft",
    });
    purpose = "generation";
    assert.ok(compact.summary.length > 0);
    assert.ok(requests.length > before);
    await first.prompt("Continue after compaction.");
    return {
      modelCalls: requests.length - before,
      summaryPresent: true,
      calls: calls.filter((call) => call.purpose === "compaction"),
      stats: first.getSessionStats(),
    };
  });
  purpose = "generation";
  await check("failed-compaction-preserves-session", async () => {
    await first.prompt(
      "Failure recovery context. " +
        "Preserve these synthetic notes in the session. ".repeat(100),
    );
    const before = JSON.stringify(first.messages);
    mode = "compaction-fail";
    purpose = "failed-compaction";
    await assert.rejects(
      first.compact("Preserve the previous context.", { mode: "soft" }),
    );
    mode = "normal";
    purpose = "generation";
    assert.equal(JSON.stringify(first.messages), before);
    const settledRequests = requests.length;
    const settledCalls = calls.length;
    await Bun.sleep(1800);
    assert.equal(
      requests.length,
      settledRequests,
      "Failed compaction must not leave outbound retries",
    );
    assert.equal(
      calls.length,
      settledCalls,
      "All summary branches must settle before compact rejects",
    );
    return {
      unchangedAfterFailedSummary: true,
      noWorkAfterRejection: true,
      observationMs: 1800,
    };
  });
  mode = "normal";
  const abortSession = await create();
  await check("abort-stream-does-not-resume", async () => {
    for (const stage of ["before-output", "after-output"] as const) {
      for (let iteration = 0; iteration < 3; iteration++) {
        mode = stage === "before-output" ? "slow-empty" : "slow";
        let receivedOutput = false;
        const unsubscribe = abortSession.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          )
            receivedOutput = true;
        });
        const before = requests.length;
        const beforeCalls = calls.length;
        const pending = abortSession.prompt(`Cancel ${stage} ${iteration}.`);
        const deadline = Date.now() + 3000;
        while (
          (requests.length === before ||
            (stage === "after-output" && !receivedOutput)) &&
          Date.now() < deadline
        )
          await Bun.sleep(10);
        const reachedStage =
          requests.length > before &&
          (stage === "before-output" ? !receivedOutput : receivedOutput);
        await abortSession.abort();
        await pending;
        unsubscribe();
        assert.ok(reachedStage, `Must reach ${stage} before cancelling`);
        await Bun.sleep(150);
        assert.equal(abortSession.isStreaming, false);
        assert.equal(requests.length - before, 1);
        assert.equal(calls.length - beforeCalls, 1);
        const last = abortSession.messages.at(-1);
        assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
      }
    }
    mode = "normal";
    return {
      aborted: true,
      cycles: 6,
      stages: ["before-output", "after-output"],
      attemptsPerCycle: 1,
    };
  });
  mode = "normal";
  await check("cancelled-session-401-and-manual-recovery", async () => {
    mode = "401";
    const before = requests.length;
    const beforeCalls = calls.length;
    await abortSession
      .prompt("Fail once after cancellation.")
      .catch(() => undefined);
    await Bun.sleep(150);
    assert.equal(requests.length - before, 1);
    assert.equal(calls.length - beforeCalls, 1);
    assert.equal(calls.at(-1)?.stopReason, "error");
    mode = "normal";
    await abortSession.prompt(
      "Explicit new user request after authentication is fixed.",
    );
    assert.equal(requests.length - before, 2);
    assert.equal(calls.at(-1)?.stopReason, "stop");
    return {
      authFailureAttempts: 1,
      explicitRecoveryAttempts: 1,
      sessionReused: true,
    };
  });
  mode = "normal";
  for (const status of ["401", "429"] as const) {
    await check(`no-automatic-retry-${status}`, async () => {
      mode = status;
      const before = requests.length;
      try {
        await second.prompt(`W0 synthetic ${status}`);
      } catch {
        /* SDK may throw or retain an error message. */
      }
      await Bun.sleep(150);
      assert.equal(requests.length - before, 1);
      mode = "normal";
      return { attempts: 1 };
    });
    mode = "normal";
  }
  await check("no-unexpected-external-network", () => {
    assert.ok(network.every((item) => item.host === "127.0.0.1"));
    return { destinations: [...new Set(network.map((item) => item.host))] };
  });
  if (liveKey) {
    await check("live-deepseek-flash-sdk-session-compaction", async () => {
      const response = await guardedFetch("https://api.deepseek.com/models", {
        headers: { authorization: `Bearer ${liveKey}` },
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const catalog = (await response.json()) as {
        data: {
          id: string;
          name?: string;
          context_window: number;
          max_output_tokens: number;
        }[];
      };
      const entry = catalog.data.find((item) => item.id === "deepseek-flash");
      assert.ok(
        entry,
        "Requested V4.1 Flash must be listed by the official endpoint",
      );
      auth.keys.setRuntime("deepseek", liveKey);
      registry.registerProvider("deepseek", {
        api: "lingo-w0",
        apiKey: "W0_EXPLICIT_RUNTIME_KEY",
        baseUrl: "https://api.deepseek.com",
        streamSimple: governedTransport,
        models: [
          {
            id: entry.id,
            name: entry.name ?? entry.id,
            reasoning: false,
            input: ["text"],
            supportsTools: false,
            contextWindow: entry.context_window,
            maxTokens: Math.min(entry.max_output_tokens, 512),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      const live = await create(registry.find("deepseek", "deepseek-flash")!);
      const before = calls.length;
      purpose = "live-generation";
      await live.prompt(
        "Translate 'The sofa is green.' into simplified Chinese. Reply with the translation only. Remember the project code W0-ALPHA. " +
          "Reading note: this application translates selected text and keeps the original text visible. ".repeat(
            55,
          ),
      );
      const translated = providerReplies.at(-1)!;
      assert.ok(translated.includes("沙发"));
      await live.prompt(
        "What is the project code I gave you? Reply with that code only.",
      );
      assert.ok(
        providerReplies.at(-1)!.includes("W0-ALPHA"),
        "Session must recall the project code",
      );
      purpose = "live-compaction";
      const compacted = await live.compact(
        "Preserve project code W0-ALPHA and translation intent.",
        { mode: "soft" },
      );
      assert.ok(
        compacted.summary.length > 0,
        "Compaction must commit a nonempty summary",
      );
      purpose = "live-generation-after-compaction";
      await live.prompt("What is the project code? Reply with that code only.");
      assert.ok(
        providerReplies.at(-1)!.includes("W0-ALPHA"),
        "Session must recall the project code",
      );
      const liveCalls = calls.slice(before);
      assert.ok(liveCalls.every((call) => call.stopReason === "stop"));
      assert.ok(liveCalls.some((call) => call.purpose === "live-compaction"));
      return {
        requestedModel: entry.id,
        catalogName: entry.name,
        realProvider: true,
        authenticated: true,
        translation: true,
        continuityBeforeAndAfterCompaction: true,
        callCount: liveCalls.length,
        calls: liveCalls,
        pricing:
          "not asserted; zero SDK prices in this probe are placeholders, not a free-usage claim",
      };
    });
  }
} finally {
  for (const session of sessions) await session.dispose();
  auth.close();
  server.stop(true);
}
process.stdout.write(
  JSON.stringify(
    {
      mode: liveKey ? "offline-and-live" : "offline",
      results,
      passed: results.every((r) => r.passed),
      network,
      syntheticRequestCallIds: requests.map((request) => request.callId),
      calls,
    },
    null,
    2,
  ) + "\n",
);
process.exit(results.every((r) => r.passed) ? 0 : 1);
