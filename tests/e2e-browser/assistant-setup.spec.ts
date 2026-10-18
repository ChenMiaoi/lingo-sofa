import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  modelConfigSchema,
  providerCatalogSchema,
  BROWSER_EXTENSION_ID,
} from "@lingo-sofa/protocol";
type ExtensionApi = typeof import("wxt/browser").browser;

test("guides shared-assistant installation and activates one shared account source", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lingo-setup-ui-"));
  const extension = join(profile, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const context = await chromium.launchPersistentContext(
    join(profile, "browser"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    expect(id).toBe(BROWSER_EXTENSION_ID);
    // Isolate this UI test from any installed native host in the user's profile.
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    const version = JSON.parse(
      await readFile(join(extension, "manifest.json"), "utf8"),
    ).version as string;
    const page = await context.newPage();
    const fixtureCatalog = providerCatalogSchema.parse({
      model: modelConfigSchema.parse({
        provider: "deepseek",
        model: "deepseek-flash",
        endpoint: "https://api.deepseek.com",
      }),
      keyConfigured: false,
      piAuth: false,
      providers: [],
    });
    await page.addInitScript(
      ({ catalog }) => {
        const state = globalThis as typeof globalThis & {
          chrome: ExtensionApi;
          assistantFixture: {
            connected: boolean;
            installed: boolean | null;
            version?: string;
          };
          connectionFixture: { fail: boolean; updates: unknown[] };
        };
        state.assistantFixture = { connected: false, installed: null };
        state.connectionFixture = { fail: true, updates: [] };
        const original = state.chrome.runtime.sendMessage.bind(
          state.chrome.runtime,
        );
        state.chrome.runtime.sendMessage = ((message: {
          action?: string;
          mode?: string;
          update?: unknown;
        }) => {
          if (message.action === "assistant-status")
            return Promise.resolve(state.assistantFixture);
          if (message.action === "provider-catalog")
            return Promise.resolve(catalog);
          if (message.action === "account-use-shared") {
            state.connectionFixture.updates.push(message.update);
            if (state.connectionFixture.fail)
              return Promise.resolve({
                ok: false,
                error: "fixture switch failure",
              });
            return original({ action: "state", localOnly: true }).then(
              (current) =>
                original({
                  action: "save",
                  settings: { ...current.settings, mode: "bridge" },
                }),
            );
          }
          return original(message);
        }) as typeof original;
      },
      { catalog: fixtureCatalog },
    );
    await page.goto(`chrome-extension://${id}/options.html#intelligence`);
    await expect(page.getByRole("heading", { name: "问答设置" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "本地助手安装" }),
    ).toHaveCount(0);
    // Connecting exposes onboarding without creating another account store.
    await page
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "连接方式", exact: true })
      .click();
    const setup = page.getByRole("region", { name: "本地助手安装" });
    await expect(setup).toBeVisible();
    await setup
      .getByRole("button", { name: "已安装助手", exact: false })
      .click();
    await expect(setup.locator("ol").first()).toContainText(
      "无需关闭浏览器或 Discord",
    );
    const command = setup.getByLabel("浏览器授权命令");
    await expect(command).toHaveText(new RegExp(id));
    await setup.getByRole("combobox", { name: "终端平台" }).selectOption("win");
    await expect(command).toHaveText(/ConvertFrom-Json/);
    await setup.getByRole("combobox", { name: "终端平台" }).selectOption("mac");
    await expect(command).toHaveText(/Authorize\.command/);
    await setup
      .getByRole("combobox", { name: "终端平台" })
      .selectOption("linux");
    await expect(command).toHaveText(new RegExp(id));
    await expect(
      setup.getByRole("link", { name: /下载本地助手/ }),
    ).toBeHidden();
    await setup.getByText("运行命令遇到问题？", { exact: true }).click();
    await setup
      .getByRole("button", { name: "这台电脑尚未安装助手", exact: true })
      .click();
    await expect(setup.locator(".assistant-id code")).toHaveCount(0);
    await expect(setup).toContainText("新版助手会自动授权，无需输入扩展 ID。");
    await expect(
      setup.getByRole("link", { name: /下载本地助手/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/ChenMiaoi/lingo-sofa/releases",
    );
    await expect(setup.getByRole("button", { name: "检测连接" })).toBeVisible();
    await page.screenshot({
      path: ".cache/ui/assistant-installation.png",
      fullPage: true,
    });
    await setup
      .getByRole("button", { name: "已经安装了？直接授权连接" })
      .click();
    await setup.getByRole("combobox").selectOption("win");
    await page.screenshot({
      path: ".cache/ui/assistant-connection-light.png",
      fullPage: true,
    });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await page.screenshot({
      path: ".cache/ui/assistant-connection-dark.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({
      path: ".cache/ui/assistant-connection-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        assistantFixture: {
          connected: boolean;
          installed: boolean;
          version: string;
        };
      };
      state.assistantFixture = {
        connected: true,
        installed: true,
        version: "0.2.3",
      };
    });
    await setup.getByRole("button", { name: "检测连接", exact: true }).click();
    await expect(setup).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "本地助手状态" }),
    ).toContainText("助手 v0.2.3");
    await expect(
      page.getByRole("link", {
        name: `LingoSofa 设置 · v${version}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: ".cache/ui/assistant-connected.png",
      fullPage: true,
    });
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        assistantFixture: { connected: boolean; installed: boolean };
      };
      state.assistantFixture = { connected: false, installed: true };
    });
    await page
      .getByRole("region", { name: "本地助手状态" })
      .getByRole("button", { name: "重新检测" })
      .click();
    await expect(
      page.getByRole("heading", { name: "连接已有助手" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /下载本地助手/ })).toHaveCount(
      0,
    );
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        assistantFixture: {
          connected: boolean;
          installed: boolean;
          version: string;
        };
      };
      state.assistantFixture = {
        connected: true,
        installed: true,
        version: "0.2.3",
      };
    });
    await expect(
      page.getByRole("region", { name: "本地助手状态" }),
    ).toContainText("本地助手已连接", { timeout: 6_000 });
    const connection = page.getByRole("region", { name: "共享模型账户" });
    await expect(connection.getByRole("status")).toHaveText(
      "免 Key 翻译可独立使用；大模型需要共享助手",
    );
    await expect(connection).toContainText("不会读取旧 Key");
    const originalSettings = await page.evaluate(
      async () =>
        (
          await (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "state", localOnly: true })
        ).settings,
    );
    await connection
      .getByRole("button", { name: "使用共享账户", exact: true })
      .click();
    await expect(connection.getByRole("alert")).toContainText(
      "fixture switch failure",
    );
    await expect(connection.getByRole("status")).toHaveText(
      "免 Key 翻译可独立使用；大模型需要共享助手",
    );
    await page.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          connectionFixture: { fail: boolean };
        }
      ).connectionFixture.fail = false;
    });
    await connection
      .getByRole("button", { name: "使用共享账户", exact: true })
      .click();
    await expect(connection.getByRole("status")).toHaveText(
      "当前使用：共享本地助手",
    );
    await expect(
      connection.getByRole("button", { name: "使用共享账户", exact: true }),
    ).toHaveCount(0);
    const activated = await page.evaluate(
      async () =>
        (
          await (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "state", localOnly: true })
        ).settings,
    );
    expect(activated).toEqual({ ...originalSettings, mode: "bridge" });
    await expect(
      connection.getByRole("button", { name: "模型直连", exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
