import { expect, it } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelConfigSchema,
  type ModelConfig,
  type ProviderCatalog,
} from "@lingo-sofa/protocol";
import { ProviderAccounts } from "../apps/pi-bridge/src/accounts.js";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { DiscordBridgeClient } from "../apps/discord-vencord/src/client.js";
import type { AddressInfo } from "node:net";
import { modelServer } from "./fixtures/model-server.js";

it("persists multiple named accounts, binds endpoints and keeps independent defaults across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-accounts-"));
  const model = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
  });
  try {
    const store = new ProviderAccounts(directory, model, "legacy-key");
    await store.ready;
    expect(store.list()).toHaveLength(1);
    await store.commit(
      store.plan({
        target: "account",
        model,
        apiKey: "work-key",
        accountName: "Work",
        newAccount: true,
      }),
    );
    const work = store.list().find((item) => item.name === "Work")!;
    await store.commit(
      store.plan({ target: "ask-default", model: work.model }),
    );
    expect(store.key(work.model)).toBe("work-key");
    expect(store.key(store.translation)).toBe("legacy-key");
    expect(() =>
      store.key({ ...work.model, endpoint: "https://attacker.test/v1" }),
    ).toThrow("Account does not match");
    expect(() =>
      store.plan({
        model: { ...work.model, provider: "openai" },
        target: "translation",
      }),
    ).toThrow("Account does not match");
    expect(() =>
      store.plan({ target: "remove-account", model: work.model }),
    ).toThrow("default account");
    const restored = new ProviderAccounts(
      directory,
      model,
      "replacement-env-key",
    );
    await restored.ready;
    expect(restored.ask.accountId).toBe(work.id);
    expect(restored.key(restored.ask)).toBe("work-key");
    expect(restored.key(restored.translation)).toBe("legacy-key");
    expect(JSON.stringify(restored.list())).not.toContain("work-key");
    // NTFS exposes synthetic POSIX mode bits; this assertion applies to POSIX hosts.
    if (process.platform !== "win32")
      expect((await stat(join(directory, "accounts.json"))).mode & 0o777).toBe(
        0o600,
      );
    expect(await readFile(join(directory, "accounts.json"), "utf8")).toContain(
      "work-key",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("switches an Ask session's account, model and effort with history while isolating translation and concurrent conversations", async () => {
  const first = await modelServer({ delay: 80 });
  const second = await modelServer({ delay: 80 });
  const directory = await mkdtemp(join(tmpdir(), "lingo-routing-"));
  const config = bridgeConfigSchema.parse({
    settings: {
      model: {
        provider: "deepseek",
        model: "deepseek-flash",
        endpoint: first.endpoint,
        thinkingLevel: "low",
      },
    },
  });
  const token = "accounts-fixture-".padEnd(48, "a");
  const bridge = createBridge(
    config,
    "first-key",
    token,
    Date.now() + 60000,
    directory,
  );
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  config.port = (bridge.server.address() as AddressInfo).port;
  const client = new DiscordBridgeClient({
    port: () => config.port,
    token: () => token,
    origin: "https://discord.com",
  });
  const ask = (id: string, question: string, model?: ModelConfig) =>
    client.request("account:channel", {
      kind: "ask",
      requestId: crypto.randomUUID(),
      sessionId: id,
      question,
      context: "SELECTED_CONTEXT",
      ...(model ? { model } : {}),
    });
  try {
    const initial = await client.providers();
    const a = {
      ...initial.accounts[0]!.model,
      accountId: initial.accounts[0]!.id,
    };
    const b = modelConfigSchema.parse({
      ...a,
      accountId: undefined,
      model: "deepseek-v4-pro",
      endpoint: second.endpoint,
      thinkingLevel: "high",
    });
    expect(
      await client.configureProvider({
        target: "account",
        newAccount: true,
        accountName: "Second",
        model: b,
        apiKey: "second-key",
      }),
    ).toMatchObject({ ok: true });
    const catalog: ProviderCatalog = await client.providers();
    const accountB = catalog.accounts.find((item) => item.name === "Second")!;
    const selected = { ...accountB.model, accountId: accountB.id };
    expect((await ask("one", "FIRST_TURN", a)).ok).toBe(true);
    const parallel = ask("two", "OTHER_CONVERSATION", a);
    const switched = await ask("one", "SECOND_TURN", selected);
    expect((await parallel).ok).toBe(true);
    expect(switched).toMatchObject({ ok: true, sessionStats: { tokens: 88 } });
    expect(second.requests[0]).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning_effort: "high",
    });
    const sent = JSON.stringify(second.requests[0]);
    expect(sent).toContain("FIRST_TURN");
    expect(sent).toContain("SECOND_TURN");
    expect(sent).not.toContain("OTHER_CONVERSATION");
    expect(JSON.stringify(first.requests[1])).not.toContain("FIRST_TURN");
    expect(
      await client.configureProvider({
        target: "account",
        newAccount: true,
        accountName: "Temporary",
        model: b,
        apiKey: "temporary-key",
      }),
    ).toMatchObject({ ok: true });
    const temporary = (await client.providers()).accounts.find(
      (item) => item.name === "Temporary",
    )!;
    expect(
      await client.configureProvider({
        target: "remove-account",
        model: { ...temporary.model, accountId: temporary.id },
      }),
    ).toMatchObject({ ok: true });
    expect((await client.providers()).accounts).toHaveLength(2);
    expect((await client.providers()).model).toEqual(initial.model);
    expect(
      await client.configureProvider({
        target: "ask-default",
        model: selected,
      }),
    ).toMatchObject({ ok: true });
    expect((await client.providers()).model).toEqual(initial.model);
    expect((await ask("default", "NEW_DEFAULT")).ok).toBe(true);
    expect(JSON.stringify(second.requests.at(-1))).toContain("NEW_DEFAULT");
    const bad = await ask("stolen", "Do not send", {
      ...selected,
      endpoint: first.endpoint,
    });
    expect(bad.ok).toBe(false);
    const translation = await client.request("account:channel", {
      kind: "translate",
      requestId: crypto.randomUUID(),
      units: [
        {
          id: "t",
          protectedParts: [],
          revision: "1",
          sourceKind: "discord",
          text: "TRANSLATION_ONLY",
          targetLanguage: "中文",
        },
      ],
      automatic: false,
    });
    expect(translation.ok).toBe(true);
    expect(JSON.stringify(first.requests.at(-1))).toContain("TRANSLATION_ONLY");
    expect(JSON.stringify(first.requests.at(-1))).not.toContain("FIRST_TURN");
    const groq = catalog.providers
      .find((item) => item.id === "groq")!
      .models.find((item) => item.api === "openai-completions")!;
    const otherProvider = modelConfigSchema.parse({
      ...b,
      provider: "groq",
      model: groq.id,
      thinkingLevel: undefined,
      accountId: undefined,
    });
    expect(
      await client.configureProvider({
        target: "account",
        newAccount: true,
        model: otherProvider,
        apiKey: "groq-fixture-key",
        accountName: "Groq",
      }),
    ).toMatchObject({ ok: true });
    const groqAccount = (await client.providers()).accounts.find(
      (item) => item.name === "Groq",
    )!;
    const third = await ask("one", "THIRD_TURN", {
      ...groqAccount.model,
      accountId: groqAccount.id,
    });
    expect(third).toMatchObject({ ok: true, sessionStats: { tokens: 132 } });
    expect(JSON.stringify(second.requests.at(-1))).toContain("FIRST_TURN");
    expect(JSON.stringify(second.requests.at(-1))).toContain("SECOND_TURN");
    expect(JSON.stringify(second.requests.at(-1))).toContain("THIRD_TURN");
    expect(JSON.stringify(second.requests.at(-1))).not.toContain(
      "OTHER_CONVERSATION",
    );
    expect(second.authorizations.at(-1)).toBe("Bearer groq-fixture-key");
    expect((await client.providers()).model).toEqual(initial.model);
    const usage = await client.usage("account:channel");
    expect(
      usage.filter(
        (item) => item.purpose === "ask" && item.model === "deepseek-v4-pro",
      ),
    ).toHaveLength(2);
    expect(
      first.authorizations.every((value) => value === "Bearer first-key"),
    ).toBe(true);
    expect(
      second.authorizations
        .slice(0, 2)
        .every((value) => value === "Bearer second-key"),
    ).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("first-key");
    expect(JSON.stringify(catalog)).not.toContain("second-key");
  } finally {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
