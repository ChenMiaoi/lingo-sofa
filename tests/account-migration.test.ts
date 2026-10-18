import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  modelConfigSchema,
  type AccountImport,
  type ProviderCatalog,
} from "@lingo-sofa/protocol";
import { planAccountImport } from "@lingo-sofa/provider-pi/accounts";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.js";
import { createBridge } from "../apps/pi-bridge/src/server.js";
import { modelServer } from "./fixtures/model-server.js";

it("migrates the browser key into shared defaults, preserves existing accounts and does not replay an acknowledged import after restart", async () => {
  const upstream = await modelServer({ apiKey: "new-browser-key" });
  const home = await mkdtemp(join(tmpdir(), "lingo-account-migration-"));
  const config = () =>
    bridgeConfigSchema.parse({
      allowedExtensions: ["a".repeat(32)],
      settings: {
        persistUsage: true,
        model: {
          provider: "openai-compatible",
          model: "fixture",
          endpoint: upstream.endpoint,
        },
      },
    });
  let settings = config();
  const token = "migration-token".padEnd(48, "a");
  let bridge = createBridge(
    settings,
    "old-assistant-key",
    token,
    Date.now() + 60_000,
    home,
  );
  const start = async () => {
    await new Promise<void>((resolve) =>
      bridge.server.listen(0, "127.0.0.1", resolve),
    );
    settings.port = (bridge.server.address() as AddressInfo).port;
  };
  const stop = async () => {
    bridge.server.closeAllConnections();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  };
  const post = async (path: string, body: unknown, web = false) =>
    fetch(`http://127.0.0.1:${settings.port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: web
          ? `chrome-extension://${"a".repeat(32)}`
          : "https://discord.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const translate = (web = false) =>
    post(
      "/v1/request",
      {
        version: 1,
        sourceKind: web ? "web" : "discord",
        scope: "synthetic",
        request: {
          kind: "translate",
          requestId: crypto.randomUUID(),
          automatic: false,
          units: [
            {
              id: crypto.randomUUID(),
              revision: "1",
              sourceKind: web ? "web" : "discord",
              text: "Synthetic hello",
              targetLanguage: "中文",
              protectedParts: [],
            },
          ],
        },
      },
      web,
    );
  await start();
  try {
    const initial = (await (
      await post("/v1/provider", {})
    ).json()) as ProviderCatalog;
    const oldId = initial.accounts[0]!.id;
    const browserModel = { ...initial.model, accountId: oldId };
    const migration: AccountImport = {
      migrationId: crypto.randomUUID(),
      state: {
        accounts: [
          {
            id: oldId,
            name: "Browser",
            model: browserModel,
            apiKey: "new-browser-key",
          },
        ],
        translation: browserModel,
        ask: { ...browserModel, model: "fixture-next" },
        translationEngine: "llm",
      },
    };
    expect(await (await translate()).json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("401"),
    });
    expect(
      await (await post("/v1/accounts/import", migration, true)).json(),
    ).toEqual({ ok: true });
    const catalog = (await (
      await post("/v1/provider", {})
    ).json()) as ProviderCatalog;
    expect(catalog.accounts).toHaveLength(2);
    expect(catalog.accounts.some((account) => account.id === oldId)).toBe(true);
    expect(catalog.model.accountId).not.toBe(oldId);
    expect(catalog.askModel?.accountId).toBe(catalog.model.accountId);
    expect(catalog.askModel?.model).toBe("fixture-next");
    expect(JSON.stringify(catalog)).not.toContain("new-browser-key");
    expect(await (await translate()).json()).toMatchObject({ ok: true });
    expect(await (await translate(true)).json()).toMatchObject({ ok: true });
    expect(upstream.authorizations).toEqual([
      "Bearer old-assistant-key",
      "Bearer new-browser-key",
      "Bearer new-browser-key",
    ]);
    expect(
      await (
        await post("/v1/provider/update", {
          target: "translation",
          model: { ...catalog.model, model: "fixture-next" },
        })
      ).json(),
    ).toEqual({ ok: true });
    await stop();
    settings = config();
    bridge = createBridge(
      settings,
      "environment-key",
      token,
      Date.now() + 60_000,
      home,
    );
    await start();
    expect(
      await (await post("/v1/accounts/import", migration, true)).json(),
    ).toEqual({ ok: true });
    const restored = (await (
      await post("/v1/provider", {})
    ).json()) as ProviderCatalog;
    expect(restored.model.model).toBe("fixture-next");
    expect(restored.accounts).toHaveLength(2);
    expect(await (await translate()).json()).toMatchObject({ ok: true });
    expect(upstream.authorizations.at(-1)).toBe("Bearer new-browser-key");
    const stored = JSON.parse(
      await readFile(join(home, "accounts.json"), "utf8"),
    );
    expect(stored.completedImports).toEqual([migration.migrationId]);
  } finally {
    await stop();
    await upstream.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("deduplicates identical credentials, remaps colliding IDs and rejects invalid imports without mutating saved state", () => {
  const model = modelConfigSchema.parse({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com",
  });
  const id = crypto.randomUUID(),
    second = crypto.randomUUID();
  const state = {
    accounts: [
      {
        id,
        name: "Shared",
        model: { ...model, accountId: id },
        apiKey: "same-key",
      },
    ],
    translation: model,
    ask: model,
  };
  const migration: AccountImport = {
    migrationId: crypto.randomUUID(),
    state: {
      accounts: [
        {
          id: second,
          name: "Browser",
          model: { ...model, accountId: second },
          apiKey: "same-key",
        },
      ],
      translation: { ...model, accountId: second },
      ask: model,
    },
  };
  const imported = planAccountImport(state, migration, () => {
    throw Error("Identical credentials must reuse the existing account");
  });
  expect(imported.accounts).toHaveLength(1);
  expect(imported.translation.accountId).toBe(id);
  expect(imported.ask.accountId).toBe(id);
  const before = structuredClone(state);
  expect(() =>
    planAccountImport(
      state,
      {
        ...migration,
        state: {
          ...migration.state,
          translation: { ...model, accountId: crypto.randomUUID() },
        },
      },
      crypto.randomUUID,
    ),
  ).toThrow("default does not match");
  expect(() =>
    planAccountImport(
      state,
      {
        ...migration,
        state: {
          ...migration.state,
          accounts: [...migration.state.accounts, ...migration.state.accounts],
        },
      },
      crypto.randomUUID,
    ),
  ).toThrow("Duplicate browser account ID");
  expect(state).toEqual(before);
});
