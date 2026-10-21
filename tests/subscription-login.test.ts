import { expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { SubscriptionLogin } from "../apps/omp-worker/src/subscription-login";

type Login = AuthStorage["oauth"]["login"];
const providers = [
  { id: "openai-codex", name: "ChatGPT", provider: "openai-codex" },
  { id: "openai-codex-device", name: "Device", provider: "openai-codex" },
];
const unusedFetch = (() => {
  throw new Error("unexpected_network");
}) as unknown as typeof fetch;
const tick = () => Bun.sleep(1);

test("subscription login exposes only authorization state, prompts once and completes after storage acknowledgement", async () => {
  const committed = Promise.withResolvers<void>();
  const values: string[] = [];
  const login: Login = async (_provider, controller) => {
    controller.onAuth({
      url: "https://auth.openai.com/oauth/authorize?state=synthetic",
    });
    const value = await controller.onPrompt({
      message: "Authorization code",
      secret: true,
    });
    values.push(value);
    await committed.promise;
    return { type: "oauth" };
  };
  const flow = new SubscriptionLogin(
    { oauth: { login } },
    providers,
    unusedFetch,
  );
  const started = flow.start("openai-codex");
  expect(started.phase).toBe("prompt");
  expect(started.prompt?.secret).toBe(true);
  expect(() => flow.start("openai-codex")).toThrow("login_in_progress");
  expect(() =>
    flow.input(started.attempt, started.prompt!.id + 1, "synthetic-code"),
  ).toThrow("invalid_login_input");
  expect(() => flow.input(started.attempt, started.prompt!.id, "")).toThrow(
    "invalid_login_input",
  );
  flow.input(started.attempt, started.prompt!.id, "synthetic-code");
  expect(() =>
    flow.input(started.attempt, started.prompt!.id, "duplicate-code"),
  ).toThrow("invalid_login_input");
  await tick();
  expect(values).toEqual(["synthetic-code"]);
  expect(flow.status(started.attempt).phase).toBe("waiting");
  expect(JSON.stringify(flow.status(started.attempt))).not.toContain(
    "synthetic-code",
  );
  committed.resolve();
  await tick();
  expect(flow.status(started.attempt).phase).toBe("complete");
  expect(flow.status(started.attempt).prompt).toBeUndefined();
});

test("cancelling authorization aborts prompts and fences late results and stale attempts", async () => {
  let commits = 0;
  const login: Login = async (_provider, controller) => {
    await controller.onPrompt({ message: "Paste code" });
    if (controller.signal?.aborted) throw new Error("cancelled");
    commits++;
    return { type: "oauth" };
  };
  const flow = new SubscriptionLogin(
    { oauth: { login } },
    providers,
    unusedFetch,
  );
  const first = flow.start("openai-codex");
  expect(flow.cancel(first.attempt).phase).toBe("cancelled");
  await tick();
  expect(commits).toBe(0);
  const second = flow.start("openai-codex-device");
  expect(second.provider).toBe("openai-codex");
  expect(() => flow.status(first.attempt)).toThrow("login_expired");
  flow.close();
  await tick();
  expect(flow.status(second.attempt).phase).toBe("cancelled");
});

test("unsupported providers, untrusted browser URLs and credential write failures fail without leaking details", async () => {
  const badUrl: Login = async (_provider, controller) => {
    controller.onAuth({ url: "file:///tmp/unauthorized" });
    return { type: "oauth" };
  };
  const flow = new SubscriptionLogin(
    { oauth: { login: badUrl } },
    providers,
    unusedFetch,
  );
  expect(() => flow.start("unknown")).toThrow("login_provider_unsupported");
  const started = flow.start("openai-codex");
  await tick();
  expect(flow.status(started.attempt).phase).toBe("error");
  expect(flow.status(started.attempt).url).toBeUndefined();
  const failed = new SubscriptionLogin(
    {
      oauth: {
        login: async () => {
          throw new Error("secret-access-token storage failed");
        },
      },
    },
    providers,
    unusedFetch,
  );
  const attempt = failed.start("openai-codex");
  await tick();
  expect(failed.status(attempt.attempt).phase).toBe("error");
  expect(JSON.stringify(failed.status(attempt.attempt))).not.toContain(
    "secret-access-token",
  );
});

test("the bundled OMP device flow exchanges an authorization code and stores a Codex OAuth grant", async () => {
  const ai = await import("@oh-my-pi/pi-ai");
  const sdk = await import("@oh-my-pi/pi-coding-agent");
  const store = await ai.SqliteAuthCredentialStore.open(":memory:");
  const auth = new sdk.AuthStorage(store, {
    usageProviderResolver: () => undefined,
  });
  const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
  const calls: string[] = [];
  const oldFetch = globalThis.fetch;
  const fakeFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/deviceauth/usercode"))
        return Response.json({
          device_auth_id: "synthetic-device",
          user_code: "TEST-CODE",
          interval: 0,
        });
      if (url.endsWith("/deviceauth/token"))
        return Response.json({
          authorization_code: "synthetic-code",
          code_verifier: "synthetic-verifier",
        });
      if (url.endsWith("/oauth/token"))
        return Response.json({
          access_token: access,
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
        });
      throw new Error("unexpected_auth_endpoint");
    },
    { preconnect: () => undefined },
  ) as typeof fetch;
  globalThis.fetch = fakeFetch;
  try {
    const flow = new SubscriptionLogin(auth, providers, fakeFetch);
    const started = flow.start("openai-codex-device");
    const deadline = Date.now() + 8000;
    while (
      !["complete", "error"].includes(flow.status(started.attempt).phase)
    ) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(30);
    }
    const result = flow.status(started.attempt);
    expect(result.phase).toBe("complete");
    expect(result.provider).toBe("openai-codex");
    expect(result.instructions).toContain("TEST-CODE");
    expect(calls).toHaveLength(3);
    const credential = store
      .listAuthCredentials()
      .find((entry) => entry.provider === "openai-codex")?.credential;
    expect(credential?.type).toBe("oauth");
    expect(JSON.stringify(credential)).toContain("synthetic-refresh");
    expect(JSON.stringify(result)).not.toContain(access);
    expect(JSON.stringify(result)).not.toContain("synthetic-refresh");
  } finally {
    globalThis.fetch = oldFetch;
    auth.close();
  }
}, 10000);

test("the login catalog follows OMP model providers instead of a fixed vendor allowlist", async () => {
  const ai = await import("@oh-my-pi/pi-ai");
  const { subscriptionProviders, safeAuthorizationUrl } =
    await import("../apps/omp-worker/src/subscription-login");
  const ids = new Set([
    "openai-codex",
    "anthropic",
    "kimi-code",
    "github-copilot",
    "google-gemini-cli",
    "zai",
    "perplexity",
  ]);
  const catalog = subscriptionProviders(ai, ids);
  for (const id of ids)
    expect(catalog.some((entry) => entry.provider === id)).toBe(true);
  expect(
    catalog.find((entry) => entry.id === "openai-codex-device")?.provider,
  ).toBe("openai-codex");
  expect(catalog.some((entry) => entry.provider === "tavily")).toBe(false);
  expect(safeAuthorizationUrl("https://auth.kimi.com/device")).toBe(true);
  expect(safeAuthorizationUrl("https://user:secret@example.com/")).toBe(false);
  expect(safeAuthorizationUrl("http://localhost:1455/")).toBe(false);
});

test("browser-session login only exposes a private-window request, never its returned cookie", async () => {
  const login: Login = async (_provider, controller) => {
    const cookie = await controller.onBrowserSession!({
      url: "https://www.perplexity.ai/auth/signin",
      cookieNames: ["__Secure-session"],
    });
    expect(cookie).toBe("synthetic-private-cookie");
    return { type: "oauth" };
  };
  const flow = new SubscriptionLogin(
    { oauth: { login } },
    [{ id: "perplexity", provider: "perplexity", name: "Perplexity" }],
    unusedFetch,
  );
  const active = flow.start("perplexity");
  expect(active.prompt?.browser?.cookieNames).toEqual(["__Secure-session"]);
  flow.input(active.attempt, active.prompt!.id, "synthetic-private-cookie");
  await tick();
  expect(flow.status(active.attempt).phase).toBe("complete");
  expect(JSON.stringify(flow.status(active.attempt))).not.toContain(
    "synthetic-private-cookie",
  );
});

test("automatic callbacks dismiss manual-code prompts before the next SDK prompt", async () => {
  const login: Login = async (_provider, controller) => {
    const manual = new AbortController();
    const pending = controller.onManualCodeInput!(manual.signal).catch(
      () => "cancelled",
    );
    manual.abort();
    expect(await pending).toBe("cancelled");
    const next = await controller.onPrompt({ message: "Choose workspace" });
    expect(next).toBe("workspace");
    return { type: "oauth" };
  };
  const flow = new SubscriptionLogin(
    { oauth: { login } },
    providers,
    unusedFetch,
  );
  const started = flow.start("openai-codex");
  await tick();
  const prompt = flow.status(started.attempt).prompt!;
  expect(prompt.message).toBe("Choose workspace");
  flow.input(started.attempt, prompt.id, "workspace");
  await tick();
  expect(flow.status(started.attempt).phase).toBe("complete");
});
