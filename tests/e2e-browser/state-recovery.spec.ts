import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import {
  test,
  expect,
  chromium,
  type Page,
  type Worker,
} from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Settings, UsageRecord } from "@lingo-sofa/protocol";
import { modelServer } from "../fixtures/model-server.js";

type ExtensionApi = typeof import("wxt/browser").browser;
async function fixture(
  run: (environment: {
    options: Page;
    worker: Worker;
    urls: string[];
    open: (url: string) => Promise<Page>;
    restart: () => Promise<Page>;
    model: Awaited<ReturnType<typeof modelServer>>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "lingo-state-recovery-"));
  if (resolve(dirname(directory)) !== resolve(tmpdir()))
    throw Error("Unexpected test directory");
  const model = await modelServer();
  const sites = [0, 1].map((index) =>
    createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<article><p>State recovery ${index}</p></article>`);
    }),
  );
  for (const site of sites)
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const urls = sites.map(
    (site) => `http://127.0.0.1:${(site.address() as AddressInfo).port}/`,
  );
  const extension = join(directory, "extension");
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
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
        viewport: { width: 1200, height: 900 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      });
    context = await launch();
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const assistant = await connectTestAssistant(worker, context);
    const id = new URL(worker.url()).host;
    const open = async (url: string) => {
      const page = await context!.newPage();
      await page.goto(url);
      return page;
    };
    const options = await open(`chrome-extension://${id}/options.html`);
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      const saved = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-state-recovery",
        settings: {
          ...state.settings,
          mode: "direct",
          model: {
            ...state.settings.model,
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      });
      if (!saved.ok) throw Error(saved.error);
      await api.storage.local.set({ readingEnabled: false });
    }, model.endpoint);
    await run({
      options,
      worker,
      urls,
      open,
      model,
      restart: async () => {
        await context!.close();
        context = await launch();
        const restoredWorker =
          context.serviceWorkers()[0] ??
          (await context.waitForEvent("serviceworker"));
        await assistant.attach(restoredWorker);
        return open(`chrome-extension://${id}/options.html`);
      },
    });
  } finally {
    await context?.close();
    await model.close();
    for (const site of sites) {
      site.closeAllConnections();
      await new Promise<void>((done) => site.close(() => done()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("retains independent website rules and floating preferences saved at the same time", async () => {
  await fixture(async ({ options, worker, urls, open, model }) => {
    for (const url of urls) {
      const page = await open(url);
      await expect(page.locator("[data-lingo-sofa=controls]")).toHaveCount(1);
    }
    const state = await worker.evaluate(async (urls) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const original = api.storage.local.get.bind(api.storage.local);
      // Return deliberately stale snapshots to make overlapping read/modify/write reproducible.
      api.storage.local.get = (async (key: string | string[]) => {
        const result = await original(key);
        if (key === "settings" || key === "floatingDock")
          await new Promise((resolve) => setTimeout(resolve, 30));
        return result;
      }) as typeof api.storage.local.get;
      const tabs = await api.tabs.query({});
      const ids = urls.map((url) => tabs.find((tab) => tab.url === url)!.id!);
      await Promise.all(
        ids.map((tabId) =>
          api.scripting.executeScript({
            target: { tabId },
            func: async () =>
              (
                globalThis as typeof globalThis & { chrome: ExtensionApi }
              ).chrome.runtime.sendMessage({
                action: "page-auto",
                enabled: true,
              }),
          }),
        ),
      );
      await api.storage.local.set({
        floatingDock: { side: "left", y: 0.25, autoHide: false },
      });
      await Promise.all(
        ids.map((tabId, index) =>
          api.scripting.executeScript({
            target: { tabId },
            args: [index],
            func: async (index) =>
              (
                globalThis as typeof globalThis & { chrome: ExtensionApi }
              ).chrome.runtime.sendMessage({
                action: "floating-preferences-update",
                preferences: index
                  ? { autoHide: true }
                  : { side: "right", y: 0.4 },
              }),
          }),
        ),
      );
      return {
        ...(await api.storage.local.get(["settings", "floatingDock"])),
      } as { settings: Settings; floatingDock: unknown };
    }, urls);
    expect
      .soft(state.settings.autoOrigins.sort())
      .toEqual(urls.map((url) => new URL(url).origin).sort());
    expect
      .soft(state.floatingDock)
      .toEqual({ side: "right", y: 0.4, autoHide: true });
    await options.reload();
    await expect(
      options.getByRole("button", { name: "关闭自动翻译", exact: true }),
    ).toHaveCount(2);
    await options
      .getByRole("button", { name: "关闭自动翻译", exact: true })
      .first()
      .click();
    await expect(
      options.getByRole("button", { name: "关闭自动翻译", exact: true }),
    ).toHaveCount(1);
    expect(model.requests).toHaveLength(0);
  });
});

test("restores a persistent unfinished usage record after the whole browser closes without replaying it", async () => {
  await fixture(async ({ options, restart, model }) => {
    const id = crypto.randomUUID();
    await options.evaluate(async (requestId) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      const saved = await api.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, persistUsage: true },
      });
      if (!saved.ok) throw Error(saved.error);
      const pending: UsageRecord = {
        requestId,
        scope: "web:fixture-recovery",
        provider: "openai-compatible",
        model: "fixture",
        sourceKind: "web",
        mode: "direct",
        status: "unknown",
        timestamp: Date.now(),
        usage: null,
        costKnown: false,
        durationMs: 0,
        firstOutputMs: null,
        firstTextMs: null,
        generationMs: null,
        tps: null,
      };
      await api.storage.local.set({ inFlight: [pending] });
    }, id);
    const reopened = await restart();
    const restored = await reopened.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      })) as { usage: UsageRecord[]; settings: Settings };
    });
    expect(restored.settings.persistUsage).toBe(true);
    expect(
      restored.usage.find((record) => record.requestId === id)?.status,
    ).toBe("unknown");
    expect(model.requests).toHaveLength(0);
  });
});

test("merges preference edits from two settings pages and restores both after reload", async () => {
  await fixture(async ({ options, open }) => {
    const privacy = await open(`${options.url()}#privacy`);
    await expect(options.getByLabel("目标语言", { exact: true })).toBeEnabled();
    await expect(privacy.getByLabel("统计时区")).toBeEnabled();
    await Promise.all([
      options.getByLabel("目标语言", { exact: true }).selectOption("English"),
      privacy.getByLabel("统计时区").selectOption("UTC"),
    ]);
    await expect(options.getByRole("status")).toHaveText("所有更改已保存");
    await expect(privacy.getByRole("status")).toHaveText("所有更改已保存");
    await Promise.all([options.reload(), privacy.reload()]);
    await expect(options.getByLabel("目标语言", { exact: true })).toHaveValue(
      "English",
    );
    await expect(privacy.getByLabel("统计时区")).toHaveValue("UTC");
    await options.goto(`${options.url()}#privacy`);
    await expect(options.getByLabel("跨页面复用译文")).toBeEnabled();
    const changed = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return Promise.all([
        api.runtime.sendMessage({
          action: "translation-cache-update",
          preferences: { enabled: false },
        }),
        api.runtime.sendMessage({
          action: "translation-cache-update",
          preferences: { days: 30 },
        }),
      ]);
    });
    expect(changed.every((reply) => reply.ok)).toBe(true);
    for (const page of [options, privacy]) {
      await expect(page.getByLabel("跨页面复用译文")).toHaveValue("false");
      await expect(page.getByLabel("译文保留时长")).toHaveValue("30");
    }
    await privacy.reload();
    await expect(privacy.getByLabel("跨页面复用译文")).toHaveValue("false");
    await expect(privacy.getByLabel("译文保留时长")).toHaveValue("30");
  });
});

test("keeps one shared account source even when a legacy caller requests direct mode", async () => {
  await fixture(async ({ options, restart, model }) => {
    const shared = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const catalog = await api.runtime.sendMessage({
        action: "provider-catalog",
      });
      await api.storage.local.set({
        providerAccounts: {
          accounts: catalog.accounts.map(
            (account: { id: string; name: string; model: unknown }) => ({
              ...account,
              apiKey: "stale-browser-fixture-key",
            }),
          ),
          translation: catalog.model,
          ask: catalog.askModel,
          translationEngine: "llm",
        },
      });
      return catalog;
    });
    await options.goto(options.url() + "#connection");
    await options.reload();
    await expect(
      options.getByRole("button", { name: "模型直连", exact: true }),
    ).toHaveCount(0);
    const reopened = await restart();
    const restored = await reopened.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return {
        state: await api.runtime.sendMessage({
          action: "state",
          localOnly: true,
        }),
        catalog: await api.runtime.sendMessage({
          action: "provider-catalog",
          mode: "direct",
        }),
      };
    });
    expect(restored.state.settings.mode).toBe("bridge");
    expect(restored.catalog).toEqual(shared);
    expect(model.requests).toHaveLength(0);
  });
});

test("removes an unused retired supplier without requesting access to its old endpoint", async () => {
  await fixture(async ({ options, restart, model }) => {
    await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const current = await api.runtime.sendMessage({
        action: "provider-catalog",
        mode: "direct",
      });
      const reply = await api.runtime.sendMessage({
        action: "provider-update",
        mode: "direct",
        update: {
          target: "account",
          newAccount: true,
          accountName: "待移除账户",
          apiKey: "fixture-retired-key",
          model: {
            ...current.model,
            accountId: undefined,
            endpoint: "https://retired-provider.test/v1",
          },
        },
      });
      if (!reply.ok) throw Error(reply.error);
    });
    await options.addInitScript(() => {
      const host = globalThis as typeof globalThis & {
        chrome: ExtensionApi;
        permissionRequests: number;
      };
      host.permissionRequests = 0;
      host.chrome.permissions.request = (async () => {
        host.permissionRequests++;
        return false;
      }) as typeof host.chrome.permissions.request;
    });
    await options.goto(`${options.url()}#accounts`);
    await options.reload();
    const account = options
      .locator(".ls-account")
      .filter({ hasText: "待移除账户" });
    await account.click();
    await options
      .getByRole("button", { name: "移除供应商", exact: true })
      .click();
    await expect(account).toHaveCount(0);
    expect(
      await options.evaluate(
        () =>
          (globalThis as typeof globalThis & { permissionRequests: number })
            .permissionRequests,
      ),
    ).toBe(0);
    const reopened = await restart();
    const restored = await reopened.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({
        action: "provider-catalog",
        mode: "direct",
      }),
    );
    expect(restored.accounts).toHaveLength(1);
    expect(restored.keyConfigured).toBe(true);
    expect(restored.translationEngine).toBe("llm");
    expect(model.requests).toHaveLength(0);
  });
});

test("refreshes a clean glossary in another page and preserves a conflicting draft", async () => {
  await fixture(async ({ options, open }) => {
    await options.goto(`${options.url()}#glossary`);
    const second = await open(options.url());
    await options
      .getByRole("button", { name: "添加术语", exact: false })
      .click();
    await options.getByLabel("原词 1", { exact: true }).fill("kernel");
    await options.getByLabel("译词 1", { exact: true }).fill("内核");
    await options
      .getByRole("button", { name: "保存术语表", exact: true })
      .click();
    await expect(options.getByRole("status")).toContainText("术语表已保存");
    await expect(second.getByLabel("译词 1", { exact: true })).toHaveValue(
      "内核",
    );
    await second.getByLabel("译词 1", { exact: true }).fill("我的草稿");
    await options.getByLabel("译词 1", { exact: true }).fill("核心");
    await options
      .getByRole("button", { name: "保存术语表", exact: true })
      .click();
    await expect(options.getByRole("status")).toContainText("术语表已保存");
    await expect(second.getByLabel("译词 1", { exact: true })).toHaveValue(
      "我的草稿",
    );
    await second
      .getByRole("button", { name: "保存术语表", exact: true })
      .click();
    await expect(second.getByRole("alert")).toContainText(
      "术语表已在其他页面更新",
    );
    await expect(second.getByLabel("译词 1", { exact: true })).toHaveValue(
      "我的草稿",
    );
    const saved = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (
        await api.runtime.sendMessage({ action: "state", localOnly: true })
      ).settings.glossary;
    });
    expect(saved).toEqual([{ source: "kernel", target: "核心" }]);
  });
});
