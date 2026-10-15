import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for (const colorScheme of ["light", "dark"] as const) {
  test(`supports keyboard navigation and narrow/full layouts in ${colorScheme} theme`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "lingo-layout-"));
    const extension = resolve("apps/browser-extension/.output/chrome-mv3");
    const context = await chromium.launchPersistentContext(directory, {
      channel: "chromium",
      headless: true,
      colorScheme,
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
        await (
          globalThis as typeof globalThis & {
            chrome: typeof import("wxt/browser").browser;
          }
        ).chrome.storage.local.set({ settings: { mode: "direct" } });
      });
      const page = await context.newPage();
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.goto(`chrome-extension://${id}/options.html?view=activity`);
      await expect(
        page.getByRole("heading", { name: "用量与费用", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(/options.html#usage$/);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: /LingoSofa/ })).toBeFocused();

      await page.getByText("直连模型的自定义计价", { exact: true }).click();
      await page.getByLabel("输入单价", { exact: true }).fill("0.2,");
      await page.getByRole("button", { name: "保存计价", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("请填写四个非负数");
      for (const [label, value] of [
        ["输入单价", "0.2"],
        ["输出单价", "0.8"],
        ["缓存读取单价", "0.01"],
        ["缓存写入单价", "0"],
      ]) {
        await page.getByLabel(label!, { exact: true }).fill(value!);
      }
      await page.getByRole("button", { name: "保存计价", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("计价已保存");
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "用量与费用", exact: true }),
      ).toBeVisible();
      await page.getByText("直连模型的自定义计价", { exact: true }).click();
      await expect(page.getByLabel("输入单价", { exact: true })).toHaveValue(
        "0.2",
      );
      await expect(
        page.getByLabel("缓存写入单价", { exact: true }),
      ).toHaveValue("0");
      const nav = page.getByRole("navigation", { name: "设置导航" });
      await nav.getByRole("button", { name: "术语表", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "术语表", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "＋ 添加术语" }).click();
      await page.getByLabel("原词 1", { exact: true }).fill("kernel");
      await page.getByLabel("译词 1", { exact: true }).fill("内核");
      await page.getByRole("button", { name: "保存术语表" }).click();
      await expect(page.getByRole("status")).toContainText("术语表已保存");
      await nav.getByRole("button", { name: "请求历史", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "还没有请求记录" }),
      ).toBeVisible();
      await mkdir(".cache/ui", { recursive: true });
      for (const width of [1200, 760, 392]) {
        await page.setViewportSize({ width, height: 900 });
        for (const section of [
          "用量与费用",
          "请求历史",
          "术语表",
          "隐私与数据",
        ]) {
          await nav.getByRole("button", { name: section, exact: true }).click();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: `.cache/ui/settings-${section}-${colorScheme}-${width}.png`,
          });
        }
      }
      await page.goto(`chrome-extension://${id}/popup.html`);
      await page.setViewportSize({ width: 392, height: 700 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole("button", { name: "翻译页面", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `.cache/ui/popup-${colorScheme}.png` });
    } finally {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
