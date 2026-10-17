import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
type ExtensionApi = typeof import("wxt/browser").browser;

test("keeps the popup compact, saves language and opens full settings in a separate tab", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-popup-"));
  const extension = resolve("apps/browser-extension/.output/chrome-mv3");
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  expect(manifest.options_ui.open_in_tab).toBe(true);
  const context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    headless: true,
    viewport: { width: 340, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(
      popup.getByRole("button", { name: "翻译页面", exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByRole("heading", { name: "用量与费用" }),
    ).toHaveCount(0);
    await expect(popup.getByLabel("目标语言")).toBeEnabled();
    await popup.getByLabel("目标语言").selectOption("English");
    await expect(popup.getByRole("status")).toHaveText("目标语言已保存");
    await popup.reload();
    await expect(popup.getByLabel("目标语言")).toHaveValue("English");
    expect(
      await popup.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await popup
        .locator("main")
        .evaluate((node) => node.getBoundingClientRect().height),
    ).toBeLessThan(500);
    await mkdir(".cache/ui", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await popup.emulateMedia({ colorScheme });
      await popup
        .locator("main")
        .screenshot({ path: `.cache/ui/quick-popup-${colorScheme}.png` });
    }
    const setupOpened = context.waitForEvent("page");
    await popup.getByRole("link", { name: "让悬浮球自动显示 ↗" }).click();
    const setup = await setupOpened;
    await setup.waitForURL(
      `chrome-extension://${id}/options.html?setup=reading`,
    );
    await expect(
      setup.getByRole("button", { name: "启用网页悬浮球" }),
    ).toBeVisible();
    await expect(
      setup.getByRole("region", { name: "网页悬浮入口授权" }),
    ).toHaveCount(1);
    await setup
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "供应商", exact: true })
      .click();
    await expect(
      setup.getByRole("heading", { name: "供应商", exact: true }),
    ).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "添加供应商" }),
    ).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "启用网页悬浮球" }),
    ).toBeVisible();
    expect(
      await worker.evaluate(async () => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        return api.permissions.contains({
          origins: ["https://*/*", "http://*/*"],
        });
      }),
    ).toBe(false);
    await setup.close();
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "设置 ↗", exact: true }).click();
    const settings = await opened;
    await settings.waitForURL(`chrome-extension://${id}/options.html`);
    await expect(
      settings.getByRole("heading", { name: "翻译偏好", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "稍后", exact: true }),
    ).toBeVisible();
    await settings.getByRole("button", { name: "稍后", exact: true }).click();
    await expect(
      settings.getByRole("region", { name: "网页悬浮入口授权" }),
    ).toHaveCount(0);
    await settings
      .getByRole("button", { name: "设置网页悬浮球", exact: true })
      .click();
    await expect(
      settings.getByRole("button", { name: "启用网页悬浮球" }),
    ).toBeVisible();
    await settings.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      settings.getByRole("navigation", { name: "设置导航" }),
    ).toBeVisible();
    await settings
      .getByRole("button", { name: "翻译偏好", exact: true })
      .click();
    await expect(settings.getByLabel("目标语言")).toHaveValue("English");
    await settings.getByLabel("目标语言").selectOption("日本語");
    await expect(settings.getByRole("status")).toHaveText("所有更改已保存");
    await settings.reload();
    await expect(settings.getByLabel("目标语言")).toHaveValue("日本語");
    for (const colorScheme of ["light", "dark"] as const) {
      await settings.emulateMedia({ colorScheme });
      const layout = await settings.locator("main").evaluate((node) => ({
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      }));
      expect(layout.width).toBe(1440);
      expect(layout.height).toBe(1000);
      await settings.screenshot({
        path: `.cache/ui/settings-web-${colorScheme}.png`,
      });
    }
    await settings.getByRole("button", { name: "外观", exact: true }).click();
    for (const [theme, scheme, canvas] of [
      ["light", "dark", "#fafafa"],
      ["dark", "light", "#1e1f22"],
      ["system", "dark", "#1e1f22"],
    ] as const) {
      await settings.emulateMedia({ colorScheme: scheme });
      await popup.emulateMedia({ colorScheme: scheme });
      await settings.getByLabel("颜色主题").selectOption(theme);
      for (const target of [settings, popup]) {
        await expect
          .poll(() =>
            target.evaluate(() =>
              getComputedStyle(document.documentElement)
                .getPropertyValue("--ls-canvas")
                .trim(),
            ),
          )
          .toBe(canvas);
      }
      await expect
        .poll(() =>
          settings
            .locator("main")
            .evaluate((node) =>
              getComputedStyle(node).getPropertyValue("--ls-canvas").trim(),
            ),
        )
        .toBe(canvas);
    }
    await popup.reload();
    await expect(popup.getByLabel("目标语言")).toHaveValue("日本語");
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
