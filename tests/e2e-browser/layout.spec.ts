import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
      const page = await context.newPage();
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.goto(`chrome-extension://${id}/options.html`);
      await expect(
        page.getByRole("heading", { name: "LingoSofa", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        const fixture = globalThis as typeof globalThis & {
          uiFeedback: number[];
        };
        fixture.uiFeedback = [];
        document.addEventListener(
          "click",
          (event) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest(".page-nav a")
            )
              return;
            const started = performance.now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                fixture.uiFeedback.push(performance.now() - started),
              ),
            );
          },
          true,
        );
      });
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "跳到翻译操作" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "在页面中打开控制", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "翻译页面", exact: true }),
      ).toBeFocused();
      await page.getByRole("link", { name: "设置", exact: true }).click();
      await expect(page.getByLabel("目标语言", { exact: true })).toBeVisible();
      await page.getByLabel("目标语言", { exact: true }).fill("English");
      await expect(page.getByLabel("目标语言", { exact: true })).toHaveValue(
        "English",
      );
      const price = page.getByLabel(
        "单价（每百万 tokens，USD；留空使用官方或目录价格）",
        { exact: true },
      );
      await price.fill("0.2,");
      await expect(price).toHaveValue("0.2,");
      await page
        .getByRole("button", { name: "授权并保存设置", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "单价请填写四个非负数",
      );
      await price.fill("0.2,0.8,0.01,0");
      await expect(price).toHaveValue("0.2,0.8,0.01,0");
      await page.getByRole("link", { name: "用量", exact: true }).click();
      await expect(page.getByLabel("用量摘要", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("link", { name: "翻译与问答", exact: true }).click();
      await page.waitForFunction(
        () =>
          (globalThis as typeof globalThis & { uiFeedback: number[] })
            .uiFeedback.length === 3,
      );
      const samples = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { uiFeedback: number[] })
            .uiFeedback,
      );
      await mkdir(".cache/ui", { recursive: true });
      await writeFile(
        `.cache/ui/feedback-${colorScheme}.json`,
        JSON.stringify(
          {
            samplesMs: samples,
            method:
              "Native navigation click capture to second requestAnimationFrame, includes settings expansion/anchor layout; approximates local paint readiness and excludes model/network",
          },
          null,
          2,
        ),
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `.cache/ui/options-${colorScheme}.png` });
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
