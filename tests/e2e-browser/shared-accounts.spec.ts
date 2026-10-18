import { test, expect, chromium } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelConfigSchema, type ProviderCatalog } from "@lingo-sofa/protocol";
import { modelServer } from "../fixtures/model-server.js";
import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";

type ExtensionApi = typeof import("wxt/browser").browser;
test("migrates browser credentials once and uses the same current account as Discord after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-shared-accounts-"));
  const authorization: { apiKey: string; responseGate?: Promise<void> } = {
    apiKey: "browser-valid-fixture-key",
  };
  const model = await modelServer(authorization);
  const site = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<article><p>${request.url?.includes("second") ? "Second synthetic paragraph" : "First synthetic paragraph"}</p></article>`,
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  await prepareTestExtension(extension);
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const launch = () =>
    chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
  let context = await launch();
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const assistant = await connectTestAssistant(worker, context);
    const config = modelConfigSchema.parse({
      provider: "openai-compatible",
      model: "fixture",
      endpoint: model.endpoint,
    });
    expect(
      await (
        await assistant.post("/v1/provider/update", {
          model: config,
          apiKey: "assistant-old-fixture-key",
        })
      ).json(),
    ).toEqual({ ok: true });
    const id = new URL(worker.url()).host;
    await worker.evaluate(
      async ({ config, key }) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const accountId = crypto.randomUUID();
        const selected = { ...config, accountId };
        await api.storage.local.set({
          settings: {
            mode: "direct",
            translationEngine: "llm",
            model: selected,
          },
          providerAccounts: {
            accounts: [
              {
                id: accountId,
                name: "浏览器旧账户",
                model: selected,
                apiKey: key,
              },
            ],
            translation: selected,
            ask: selected,
            translationEngine: "llm",
          },
        });
      },
      { config, key: authorization.apiKey },
    );
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html#connection`);
    const migration = options.getByRole("region", { name: "浏览器账户迁移" });
    await expect(migration).toContainText("浏览器旧账户");
    await expect(
      options.getByRole("button", { name: "模型直连", exact: true }),
    ).toHaveCount(0);
    assistant.failNextImport();
    await migration
      .getByRole("button", { name: "迁移浏览器账户并共用" })
      .click();
    await expect(migration.getByRole("alert")).toContainText("旧 Key 已保留");
    expect(
      await worker.evaluate(async () =>
        Boolean(
          (
            (
              await (
                globalThis as typeof globalThis & { chrome: ExtensionApi }
              ).chrome.storage.local.get("providerAccounts")
            ).providerAccounts as { accounts: { apiKey?: string }[] }
          ).accounts[0]?.apiKey,
        ),
      ),
    ).toBe(true);
    expect(model.requests).toHaveLength(0);
    await migration
      .getByRole("button", { name: "迁移浏览器账户并共用" })
      .click();
    await expect(migration.getByRole("status")).toContainText("现已共用");
    await expect(options.locator(".ls-active-connection")).toHaveText(
      "当前使用：共享本地助手",
    );
    const storage = await worker.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.local.get(["providerAccounts", "accountMigrationId"]),
    );
    expect(storage).toEqual({});
    const shared = (await (
      await assistant.post("/v1/provider", {})
    ).json()) as ProviderCatalog;
    expect(shared.accounts).toHaveLength(2);
    expect(
      shared.accounts.find((account) => account.id === shared.model.accountId)
        ?.name,
    ).toBe("浏览器旧账户");
    expect(JSON.stringify(shared)).not.toContain("fixture-key");
    const page = await context.newPage();
    const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    await page.goto(base);
    const translate = () =>
      options.evaluate(async () =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.runtime.sendMessage({ action: "page", command: "page" }),
      );
    await translate();
    await expect(page.locator("[data-lingo-sofa=translation]")).toContainText(
      "译文 First",
    );
    expect(model.authorizations.at(-1)).toBe(`Bearer ${authorization.apiKey}`);
    authorization.apiKey = "discord-updated-fixture-key";
    expect(
      await (
        await assistant.post(
          "/v1/provider/update",
          {
            target: "account",
            model: shared.model,
            apiKey: authorization.apiKey,
          },
          "https://discord.com",
        )
      ).json(),
    ).toEqual({ ok: true });
    await page.goto(`${base}?second`);
    await translate();
    await expect(page.locator("[data-lingo-sofa=translation]")).toContainText(
      "译文 Second",
    );
    expect(model.authorizations.at(-1)).toBe(
      "Bearer discord-updated-fixture-key",
    );
    let releaseAsk!: () => void;
    authorization.responseGate = new Promise<void>((done) => {
      releaseAsk = done;
    });
    const beforeAsk = model.requests.length;
    const asking = options
      .evaluate(async () => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const saved = await api.runtime.sendMessage({
          action: "save",
          patch: { mode: "direct", translationEngine: "bing" },
        });
        if (!saved.ok) throw Error(saved.error);
        const preview = await api.runtime.sendMessage({
          action: "page",
          command: "context",
        });
        const tab = (await api.tabs.query({})).find((tab) =>
          tab.url?.includes("?second"),
        )!;
        const sessionId = "shared-keyless-ask";
        const ask = (question: string) =>
          api.runtime.sendMessage({
            action: "ask",
            tabId: tab.id,
            request: {
              kind: "ask",
              requestId: crypto.randomUUID(),
              sessionId,
              question,
              context: preview.text,
            },
          });
        if (!(await ask("FIRST_SHARED_ASK")).ok)
          throw Error("Shared Ask failed");
        const cleared = await api.runtime.sendMessage({
          action: "clear-session",
          tabId: tab.id,
          request: { kind: "clear-session", sessionId },
        });
        if (!cleared.ok || !(await ask("SECOND_SHARED_ASK")).ok)
          throw Error("Shared Ask clearing failed");
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
    try {
      await expect.poll(() => model.requests.length).toBe(beforeAsk + 1);
      expect(
        await options.evaluate(async () => {
          const api = (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome;
          return api.runtime.sendMessage({
            action: "save",
            patch: { persistUsage: true },
          });
        }),
      ).toMatchObject({ ok: true });
    } finally {
      delete authorization.responseGate;
      releaseAsk();
    }
    expect(await asking).toEqual({ ok: true });
    expect(JSON.stringify(model.requests.at(-1))).not.toContain(
      "FIRST_SHARED_ASK",
    );
    expect(JSON.stringify(model.requests.at(-1))).toContain(
      "SECOND_SHARED_ASK",
    );
    await context.close();
    context = await launch();
    const restoredWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await assistant.attach(restoredWorker);
    const restored = await context.newPage();
    await restored.goto(`chrome-extension://${id}/options.html#accounts`);
    await expect(
      restored.getByRole("region", { name: "浏览器账户迁移" }),
    ).toHaveCount(0);
    await expect(
      restored.getByRole("region", { name: "连接服务商" }),
    ).toContainText("浏览器旧账户");
    expect(
      await restored.evaluate(async () =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.runtime.sendMessage({
          action: "provider-catalog",
          mode: "direct",
        }),
      ),
    ).toMatchObject({ model: shared.model, accounts: shared.accounts });
    await mkdir(".cache/ui", { recursive: true });
    await restored.screenshot({
      path: ".cache/ui/shared-accounts.png",
      fullPage: true,
    });
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
