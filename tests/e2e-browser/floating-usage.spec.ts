import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";
import type { FloatingPreferences } from "../../apps/browser-extension/src/floating-preferences.js";

type ExtensionApi = typeof import("wxt/browser").browser;
async function fixture(
  modelOptions: Parameters<typeof modelServer>[0],
  run: (environment: {
    page: Page;
    context: BrowserContext;
    id: string;
    model: Awaited<ReturnType<typeof modelServer>>;
    url: string;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "lingo-floating-usage-"));
  const model = await modelServer(modelOptions);
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      '<style>article{max-width:600px;margin:40px auto;font:18px/1.7 Georgia}p{margin:12px 0}</style><article><p>Hello world.</p><p>Another paragraph.</p><p>Read together.</p><p id="later" style="margin-top:1400px">Further down the page.</p></article>',
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
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
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/options.html`);
    await setup.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const current = await api.runtime.sendMessage({ action: "state" });
      const reply = await api.runtime.sendMessage({
        action: "save",
        settings: {
          ...current.settings,
          mode: "direct",
          model: {
            ...current.settings.model,
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
          },
        },
        apiKey: "fixture-floating-secret",
      });
      if (!reply.ok) throw new Error(reply.error);
    }, model.endpoint);
    await setup.close();
    const page = await context.newPage();
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    await page.goto(url);
    await run({ page, context, id, model, url });
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
const launcherName = "LingoSofa 页面控制，可拖动或用方向键移动";

test("stops without removing translations, resumes remaining content and reuses a persisted cache after refresh", async () => {
  await fixture({}, async ({ page, model, context, id }) => {
    const launcher = page.getByRole("button", {
      name: launcherName,
      exact: true,
    });
    const translations = page.locator("[data-lingo-sofa=translation]");
    await launcher.click();
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    await expect(translations).toHaveCount(3);
    expect(model.requests.length).toBe(1);
    await page.getByRole("button", { name: "停止翻译", exact: true }).click();
    const progress = page.getByRole("region", { name: "整页翻译进度" });
    await expect(progress).toContainText("已有 3 段译文保留");
    await page.locator("#later").scrollIntoViewIfNeeded();
    await expect(translations).toHaveCount(3);
    expect(model.requests.length).toBe(1);
    await page.getByRole("button", { name: "继续翻译", exact: true }).click();
    await expect(translations).toHaveCount(4);
    expect(model.requests.length).toBe(2);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(translations).toHaveCount(0);
    await page.reload();
    await page.locator("article p").first().scrollIntoViewIfNeeded();
    await launcher.click();
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    await expect(translations).toHaveCount(3);
    expect(model.requests.length).toBe(2);
    await page.getByRole("button", { name: "用量与费用", exact: true }).click();
    const usage = page.getByRole("region", { name: "全部用量与费用" });
    await expect(
      usage.getByText("请求次数", { exact: true }).locator(".."),
    ).toContainText("2");
    await expect(usage.getByLabel("分模型用量")).toContainText("fixture");
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html#privacy`);
    await settings
      .getByLabel("跨页面复用译文", { exact: true })
      .selectOption("false");
    await expect(
      settings
        .getByRole("region", { name: "本地译文缓存" })
        .getByRole("status"),
    ).toContainText("缓存设置已保存");
    await settings.close();
    await page.reload();
    await launcher.click();
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    await expect(translations).toHaveCount(3);
    expect(model.requests.length).toBe(3);
  });
});

test("drags freely before snapping, remembers position, clamps on resize and supports keyboard placement", async () => {
  await fixture({}, async ({ page, context, id }) => {
    const launcher = page.getByRole("button", {
      name: launcherName,
      exact: true,
    });
    const dock = page.locator("[data-lingo-sofa=controls]").locator(".dock");
    await launcher.hover();
    const before = (await launcher.boundingBox())!;
    await page.mouse.move(before.x + 24, before.y + 24);
    await page.mouse.down();
    await page.mouse.move(550, 240, { steps: 8 });
    const during = (await launcher.boundingBox())!;
    expect(during.x).toBeGreaterThan(100);
    expect(during.x).toBeLessThan(1100);
    await page.mouse.up();
    await expect(dock).toHaveAttribute("data-side", "left");
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    const after = (await launcher.boundingBox())!;
    expect(after.x).toBe(16);
    expect(after.y).toBeGreaterThan(100);
    expect(after.y).toBeLessThan(350);
    await page.reload();
    await expect(dock).toHaveAttribute("data-side", "left");
    await launcher.hover();
    await expect
      .poll(async () => Math.abs((await launcher.boundingBox())!.y - after.y))
      .toBeLessThan(1);
    await launcher.focus();
    await page.keyboard.press("ArrowRight");
    await expect(dock).toHaveAttribute("data-side", "right");
    const keyboardBefore = (await launcher.boundingBox())!;
    await page.keyboard.press("ArrowDown");
    expect((await launcher.boundingBox())!.y).toBeCloseTo(
      keyboardBefore.y + 24,
      0,
    );
    await page.setViewportSize({ width: 392, height: 400 });
    const narrow = (await launcher.boundingBox())!;
    expect(narrow.y).toBeGreaterThanOrEqual(16);
    expect(narrow.y + narrow.height).toBeLessThanOrEqual(384);
    await launcher.click();
    await expect(
      page.getByRole("region", { name: "LingoSofa 快捷菜单" }),
    ).toBeVisible();
    await page.mouse.click(160, 50);
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html`);
    const preferences = await settings.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.local.get("floatingDock"),
    );
    const saved = preferences.floatingDock as FloatingPreferences;
    expect(saved.side).toBe("right");
    expect(saved.y).toBeGreaterThanOrEqual(0);
    expect(saved.y).toBeLessThanOrEqual(1);
  });
});

test("tucks away when idle, wakes on hover or focus, lets users opt out and restores a hidden entry", async () => {
  test.setTimeout(60_000);
  await fixture({}, async ({ page }) => {
    await page.clock.install();
    await page.reload();
    const launcher = page.getByRole("button", {
      name: launcherName,
      exact: true,
    });
    const dock = page.locator("[data-lingo-sofa=controls]").locator(".dock");
    await expect(launcher).toBeVisible();
    await page.mouse.move(200, 200);
    await page.clock.fastForward(3_000);
    await expect(dock).toHaveAttribute("data-idle", "true");
    await page.mouse.move(1192, (await launcher.boundingBox())!.y + 24);
    await expect(dock).toHaveAttribute("data-idle", "false");
    await page.clock.fastForward(3_000);
    await expect(dock).toHaveAttribute("data-idle", "false");
    await launcher.focus();
    await page.mouse.move(200, 200);
    await page.clock.fastForward(3_000);
    await expect(dock).toHaveAttribute("data-idle", "false");
    await launcher.click();
    await page.clock.fastForward(3_000);
    await expect(dock).toHaveAttribute("data-idle", "false");
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await page
      .getByRole("switch", { name: "空闲自动收起", exact: true })
      .uncheck();
    await expect(page.getByRole("status")).toContainText("悬浮入口偏好已保存");
    await page.reload();
    await page.mouse.move(200, 200);
    await page.clock.fastForward(3_000);
    await expect(dock).toHaveAttribute("data-idle", "false");
    await launcher.click();
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "空闲自动收起", exact: true }),
    ).not.toBeChecked();
    await page
      .getByRole("button", { name: "隐藏本页悬浮球", exact: true })
      .click();
    await expect(launcher).toBeHidden();
    await page.keyboard.press("Alt+l");
    await expect(launcher).toBeVisible();
    await expect(
      page.getByRole("region", { name: "LingoSofa 快捷菜单" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
  });
});
test("can restore an in-progress page and explains when there is no translatable content", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await fixture(
    { responseGate: gate },
    async ({ page, context, id, model }) => {
      await page
        .getByRole("button", { name: launcherName, exact: true })
        .click();
      await page.getByRole("button", { name: "翻译整页", exact: true }).click();
      const progress = page.getByRole("region", { name: "整页翻译进度" });
      await expect(progress).toContainText("正在翻译");
      await expect.poll(() => model.requests.length).toBe(1);
      await page.evaluate(() => history.pushState(null, "", "?next-page"));
      await progress.getByRole("button", { name: "恢复原文" }).click();
      await expect(progress).toContainText("已恢复原文");
      const statePage = await context.newPage();
      await statePage.goto(`chrome-extension://${id}/options.html#usage`);
      await expect
        .poll(() =>
          statePage.evaluate(async () => {
            const state = await (
              globalThis as typeof globalThis & { chrome: ExtensionApi }
            ).chrome.runtime.sendMessage({ action: "state" });
            return state.queue.running;
          }),
        )
        .toBe(0);
      await statePage.close();
      finish();
      await page.evaluate(() =>
        document.querySelector("article")!.replaceChildren(),
      );
      await page.getByRole("button", { name: "翻译整页", exact: true }).click();
      await expect(progress).toContainText("未找到可翻译正文");
      await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: "翻译整页", exact: true }),
      ).toBeEnabled();
    },
  );
});
test("reports whole-page progress, bills batches once and opens cumulative per-model usage from the floating menu", async () => {
  test.setTimeout(60_000);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await fixture(
    { responseGate: gate },
    async ({ page, context, model, url, id }) => {
      await page.clock.install();
      await page.reload();
      const launcher = page.getByRole("button", {
        name: launcherName,
        exact: true,
      });
      await launcher.click();
      await page.getByRole("button", { name: "翻译整页", exact: true }).click();
      const progress = page.getByRole("region", { name: "整页翻译进度" });
      await expect(progress).toBeVisible();
      await expect(progress).toContainText("正在翻译");
      await expect(
        page.getByRole("button", { name: "翻译整页", exact: true }),
      ).toBeDisabled();
      await expect(launcher).toHaveAttribute("data-translation", "running");
      await mkdir(".cache/ui", { recursive: true });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page
          .getByRole("region", { name: "LingoSofa 快捷菜单" })
          .screenshot({ path: `.cache/ui/floating-progress-${scheme}.png` });
      }
      await page.keyboard.press("Escape");
      await expect(launcher).toHaveAttribute("data-translation", "running");
      await page.mouse.click(200, 20);
      await page.clock.fastForward(3_000);
      await expect(
        page.locator("[data-lingo-sofa=controls]").locator(".dock"),
      ).toHaveAttribute("data-idle", "false");
      await launcher.click();
      await expect(progress).toContainText("处理中");
      finish();
      await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(
        3,
      );
      await expect(progress).toContainText("可见内容已翻译");
      await expect(progress).toContainText("滚动页面后继续翻译");
      await expect(progress).toContainText("已完成 3 / 4 段");
      const calls = model.requests.length;
      expect(calls).toBe(1);
      await page
        .getByRole("button", { name: "用量与费用", exact: true })
        .click();
      const usage = page.getByRole("region", { name: "全部用量与费用" });
      await expect(usage).toBeVisible();
      await expect(
        usage.getByText("总 Tokens", { exact: true }).locator(".."),
      ).toContainText("44");
      await expect(
        usage.getByText("请求次数", { exact: true }).locator(".."),
      ).toContainText("1");
      await expect(usage.locator(".usage-total strong")).toHaveText(
        "¥0.000256",
      );
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await usage.screenshot({
          path: `.cache/ui/floating-usage-${scheme}.png`,
        });
      }
      await usage.getByRole("button", { name: "刷新", exact: true }).click();
      expect(model.requests.length).toBe(calls);
      const opened = context.waitForEvent("page");
      await usage
        .getByRole("button", { name: "查看详细用量与历史 ↗", exact: true })
        .click();
      const settings = await opened;
      await settings.waitForURL(`chrome-extension://${id}/options.html#usage`);
      await expect(
        settings.getByRole("heading", { name: "用量与费用", exact: true }),
      ).toBeVisible();
      await settings.close();
      await usage.getByRole("button", { name: "返回快捷菜单" }).click();
      await expect(
        page.getByRole("button", { name: "用量与费用", exact: true }),
      ).toBeFocused();
      await page.locator("#later").scrollIntoViewIfNeeded();
      await expect(progress).toContainText("翻译完成");
      await expect(progress).toContainText("已完成 4 / 4 段");
      await page
        .getByRole("button", { name: "用量与费用", exact: true })
        .click();
      await expect(
        usage.getByText("请求次数", { exact: true }).locator(".."),
      ).toContainText("2");
      const otherPage = await context.newPage();
      await otherPage.goto(url);
      await otherPage
        .getByRole("button", { name: launcherName, exact: true })
        .click();
      await otherPage
        .getByRole("button", { name: "用量与费用", exact: true })
        .click();
      await expect(
        otherPage.getByRole("region", { name: "全部用量与费用" }),
      ).toContainText("88");
      await otherPage.close();
      await page.evaluate(() => history.pushState(null, "", "?next-page"));
      await expect(usage).toContainText("全部可用记录");
      await expect(
        usage.getByText("总 Tokens", { exact: true }).locator(".."),
      ).toContainText("88");
      await page.setViewportSize({ width: 392, height: 700 });
      await page.keyboard.press("Escape");
      await launcher.click();
      await page
        .getByRole("button", { name: "用量与费用", exact: true })
        .click();
      const bounds = await usage.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(392);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
      await usage.screenshot({ path: ".cache/ui/floating-usage-narrow.png" });
      await page.keyboard.press("Escape");
      await expect(launcher).toHaveAttribute("aria-expanded", "false");
      await expect(launcher).toBeFocused();
    },
  );
});

test("shows translation failures, allows restore and retry, and never displays unavailable usage as free", async () => {
  const options = { status: 500 };
  await fixture(options, async ({ page, model, context, id }) => {
    const launcher = page.getByRole("button", {
      name: launcherName,
      exact: true,
    });
    await launcher.click();
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    const progress = page.getByRole("region", { name: "整页翻译进度" });
    await expect(progress).toContainText("部分段落翻译失败");
    await expect(progress).toContainText("可悬停段落重试");
    await expect(launcher).toHaveAttribute("data-translation", "failed");
    await progress.getByRole("button", { name: "恢复原文" }).click();
    await expect(progress).toContainText("已恢复原文");
    await expect(page.locator("[data-lingo-sofa=error]")).toHaveCount(0);
    await page.getByRole("button", { name: "用量与费用", exact: true }).click();
    const usage = page.getByRole("region", { name: "全部用量与费用" });
    await expect(usage.locator(".usage-total strong")).toHaveText("待计费");
    await expect(usage).toContainText("缺少用量");
    await usage.getByRole("button", { name: "返回快捷菜单" }).click();
    options.status = 0;
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    expect(model.requests.length).toBeGreaterThan(1);
    await page.getByRole("button", { name: "用量与费用", exact: true }).click();
    await expect(usage).toBeVisible();
    await expect(usage).toContainText("缺少用量");
    await expect(usage.locator(".usage-total strong")).toHaveText("¥0.000256");
    await expect(usage.getByLabel("分模型用量")).toContainText("¥0.000256");
    await expect(usage).not.toContainText("总额尚不完整");
    await expect(usage).not.toContainText("≈");
    await mkdir(".cache/ui", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await usage.screenshot({
        path: `.cache/ui/billing-recorded-${colorScheme}.png`,
      });
    }
    await page.keyboard.press("Escape");
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html#usage`);
    await expect(settings.locator(".ls-cost-metric strong")).toHaveText(
      "¥0.000256",
    );
    await expect(
      settings.getByRole("table", { name: "分模型消耗" }),
    ).toContainText("¥0.000256");
    await expect(
      settings.locator(".ls-info-note").filter({ hasText: "待计费" }),
    ).toBeVisible();
    await settings.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      await api.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, mode: "bridge" },
      });
    });
    await settings.close();
    await launcher.click();
    await page.getByRole("button", { name: "用量与费用", exact: true }).click();
    await expect(usage.getByRole("alert")).toContainText("暂时无法读取用量");
    await expect(usage.locator(".usage-total")).toBeHidden();
  });
});
