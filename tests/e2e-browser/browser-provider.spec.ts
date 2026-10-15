import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";
type ExtensionApi = typeof import("wxt/browser").browser;

test("unifies browser provider settings and the three floating reading controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-inline-"));
  const model = await modelServer({ delay: 1500 });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<style>article{max-width:600px;margin:40px auto;font:18px/1.7 Georgia}p{margin:12px 0}</style><article><p id="first">Hello <code>fetch()</code></p><p id="second">Second paragraph remains unchanged.</p><p id="third">Third paragraph.</p><pre><code>const untouched = 1;</code></pre><input value="draft"></article>`,
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  ) as { host_permissions: string[] };
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    join(directory, "profile"),
    {
      channel: "chromium",
      headless: true,
      viewport: { width: 1200, height: 900 },
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
    await worker.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);

    await expect(
      options.getByRole("heading", { name: "连接你的 AI" }),
    ).toBeVisible();
    await options
      .getByLabel("供应商", { exact: true })
      .selectOption("openai-compatible");
    await options.getByLabel("模型", { exact: true }).fill("fixture");
    await options.getByLabel("API 地址", { exact: true }).fill(model.endpoint);
    await options
      .getByLabel("API Key", { exact: true })
      .fill("fixture-browser-provider");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("已保存");
    await expect(options.getByLabel("API Key", { exact: true })).toHaveValue(
      "",
    );
    await expect(options.getByLabel("目标语言", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      options.getByLabel("自动翻译网站", { exact: true }),
    ).toHaveCount(0);
    const state = await options.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({ action: "state" }),
    );
    expect(state.settings.model.provider).toBe("openai-compatible");
    expect(JSON.stringify(state)).not.toContain("fixture-browser-provider");
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const current = await api.runtime.sendMessage({ action: "state" });
      await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-browser-provider",
        settings: {
          ...current.settings,
          model: {
            ...current.settings.model,
            provider: "deepseek",
            model: "deepseek-flash",
            endpoint,
          },
        },
      });
    }, model.endpoint);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
    await options.evaluate(async () => {
      await (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({ action: "page", command: "controls" });
    });
    await expect(page.getByRole("combobox")).toHaveCount(2);
    await expect(
      page.getByRole("switch", { name: "自动翻译此网站" }),
    ).toHaveCount(1);
    await expect(page.getByText("更多操作", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("模型", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
      "deepseek-flash",
    );
    await page.getByLabel("模型", { exact: true }).focus();
    await page.keyboard.press("d");
    await expect(page.getByRole("status")).toContainText("模型已切换");
    expect(
      (
        await options.evaluate(async () =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "state" }),
        )
      ).settings.model.model,
    ).toBe("deepseek-v4-pro");
    await page.getByLabel("目标语言", { exact: true }).focus();
    await page.keyboard.press("e");
    await expect(page.getByLabel("目标语言", { exact: true })).toHaveValue(
      "English",
    );
    const tabsBeforeAutomatic = context.pages().length;
    await page.getByRole("switch", { name: "自动翻译此网站" }).check();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    expect(context.pages().length).toBe(tabsBeforeAutomatic);
    await page.getByRole("switch", { name: "自动翻译此网站" }).uncheck();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    await page.evaluate(() => {
      const host = document.querySelector("[data-lingo-sofa=controls]")!;
      const select =
        host.shadowRoot!.querySelector<HTMLSelectElement>(".model")!;
      select.value = "deepseek-flash";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      (
        await options.evaluate(async () =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "state" }),
        )
      ).settings.model.model,
    ).toBe("deepseek-v4-pro");
    const denied = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const results = await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        func: async () =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "provider-catalog" }),
      });
      return results[0]?.result;
    });
    expect(denied).toMatchObject({ ok: false });
    const deniedOAuth = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const results = await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        func: async () =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({
            action: "provider-oauth",
            oauth: { action: "start" },
          }),
      });
      return results[0]?.result;
    });
    expect(deniedOAuth).toMatchObject({ ok: false });

    await page.getByRole("button", { name: "收起页面控制" }).click();
    await page
      .getByRole("button", { name: "LingoSofa 页面控制，可拖动或用方向键移动" })
      .click();
    await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
      "deepseek-v4-pro",
    );
    await options.reload();
    await expect(
      options.getByRole("heading", { name: "连接你的 AI" }),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await options.emulateMedia({ colorScheme: theme });
      await options.setViewportSize({ width: 400, height: 800 });
      expect(
        await options.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(400);
      await expect
        .poll(() =>
          options
            .getByRole("button", { name: "模型直连", exact: true })
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe(theme === "dark" ? "rgb(30, 31, 34)" : "rgb(255, 255, 255)");
      await options.screenshot({
        path: `.cache/ui/browser-provider-${theme}.png`,
        animations: "disabled",
      });
    }
    await page.screenshot({ path: ".cache/ui/browser-three-controls.png" });
  } finally {
    await context.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
