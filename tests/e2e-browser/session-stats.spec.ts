import { historyPage } from "../../apps/browser-extension/src/history-page.js";
import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsSchema, type UsageRecord } from "@lingo-sofa/protocol";
import { summarizeModels } from "@lingo-sofa/translation-core";

test("unifies activity navigation, filters requests, preserves glossary edits and clears totals explicitly", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "lingo-activity-"));
  const extension = resolve("apps/browser-extension/.output/chrome-mv3");
  const context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const settings = settingsSchema.parse({ mode: "direct" });
  const record: UsageRecord = {
    requestId: crypto.randomUUID(),
    scope: "web:1:https://example.test:1",
    model: "fixture-flash",
    provider: "deepseek",
    sourceKind: "web",
    mode: "direct",
    status: "success",
    timestamp: Date.now(),
    usage: {
      input: 223,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 303,
      cost: {
        input: 0.0001,
        output: 0.0002,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.0003,
      },
    },
    costKnown: true,
    durationMs: 1000,
    firstOutputMs: 100,
    firstTextMs: 100,
    generationMs: 900,
    tps: 88,
  };
  const records = [
    record,
    {
      ...record,
      requestId: crypto.randomUUID(),
      model: "fixture-pro",
      sourceKind: "discord" as const,
      scope: "discord:channel-2",
      status: "unknown" as const,
      usage: null,
      costKnown: false,
      tps: null,
    },
  ];
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    await context.exposeFunction("fixtureHistoryPage", historyPage);
    await context.addInitScript(
      ({ settings, records, summary }) => {
        const api = (
          globalThis as typeof globalThis & {
            chrome: typeof import("wxt/browser").browser;
          }
        ).chrome;
        let saved = settings;
        let usage = records;
        let allUsage = summary;
        let fail = false;
        const original = api.runtime.sendMessage.bind(api.runtime);
        api.runtime.sendMessage = ((message: {
          action: string;
          settings: typeof settings;
          historyQuery?: unknown;
        }) => {
          if (message.action === "state" && message.historyQuery)
            return Promise.resolve(
              (
                window as unknown as { fixtureHistoryPage: typeof historyPage }
              ).fixtureHistoryPage(usage, message.historyQuery, saved.timeZone),
            ).then((historyPage) => ({
              settings: saved,
              usage: [],
              historyPage,
            }));
          if (message.action === "state")
            return Promise.resolve({
              settings: saved,
              usage,
              allUsage,
              hasKey: false,
            });
          if (message.action === "save") {
            if (fail)
              return Promise.resolve({
                ok: false,
                error: "Fixture save failure",
              });
            saved = message.settings;
            return Promise.resolve({ ok: true });
          }
          if (message.action === "fixture-many") {
            usage = Array.from({ length: 123 }, (_, index) => ({
              ...records[0]!,
              requestId: crypto.randomUUID(),
              timestamp: Date.now() - index * 1000,
            }));
            return Promise.resolve({ ok: true });
          }
          if (message.action === "fixture-fail") {
            fail = !fail;
            return Promise.resolve({ ok: true });
          }
          if (message.action === "clear") {
            usage = [];
            allUsage = {
              ...allUsage,
              models: [],
              totals: {
                requests: 0,
                tokens: 0,
                input: 0,
                output: 0,
                cost: 0,
                knownCost: 0,
                unknown: 0,
                unpriced: 0,
              },
            };
            return Promise.resolve({ ok: true });
          }
          return original(message);
        }) as typeof api.runtime.sendMessage;
      },
      {
        settings,
        records,
        summary: {
          ...summarizeModels(records),
          mode: "direct",
          coverage: "all-clients",
        },
      },
    );
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html?view=activity`);
    await expect(page).toHaveURL(`chrome-extension://${id}/options.html#usage`);
    const nav = page.getByRole("navigation", { name: "设置导航" });
    await expect(
      nav.getByRole("button", { name: "用量与费用", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("region", { name: "用量摘要" })).toHaveCount(0);
    await expect(page.getByLabel("用量摘要")).toContainText("223");
    await expect(page.getByLabel("用量摘要")).toContainText("80");
    await expect(
      page.getByText("全部客户端", { exact: false }).first(),
    ).toBeVisible();
    const perModel = page.getByRole("table", {
      name: "分模型消耗",
      exact: true,
    });
    await expect(perModel.locator("tbody tr")).toHaveCount(2);
    await expect(perModel).toContainText("fixture-flash");
    await expect(perModel).toContainText("fixture-pro");
    await expect(
      page.getByRole("button", { name: "翻译页面", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('a[href*="view=activity"]')).toHaveCount(0);
    await mkdir(".cache/ui", { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: `.cache/ui/activity-populated-${scheme}.png`,
      });
    }
    await page.getByRole("link", { name: "查看请求历史 →" }).click();
    await expect(
      nav.getByRole("button", { name: "请求历史", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await page.getByLabel("来源", { exact: true }).selectOption("discord");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("结果未知");
    await page.getByLabel("请求状态").selectOption("success");
    await expect(
      page.getByRole("heading", { name: "没有符合筛选条件的记录" }),
    ).toBeVisible();
    await page.getByLabel("来源", { exact: true }).selectOption("");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("fixture-flash");
    await page.screenshot({ path: ".cache/ui/history-populated-dark.png" });
    await nav.getByRole("button", { name: "术语表", exact: true }).click();
    await page.getByRole("button", { name: "＋ 添加术语" }).click();
    await page.getByLabel("原词 1", { exact: true }).fill("kernel");
    await page.getByRole("button", { name: "保存术语表" }).click();
    await expect(page.getByRole("alert")).toContainText("请填写每一项");
    await page.getByLabel("译词 1", { exact: true }).fill("内核");
    await nav.getByRole("button", { name: "翻译偏好", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "术语表有未保存更改 · 返回保存" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "术语表有未保存更改 · 返回保存" })
      .click();
    await expect(page.getByLabel("原词 1", { exact: true })).toHaveValue(
      "kernel",
    );
    await page.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome;
      const current = await api.runtime.sendMessage({ action: "state" });
      await api.runtime.sendMessage({
        action: "save",
        settings: { ...current.settings, targetLanguage: "English" },
      });
      await api.runtime.sendMessage({ action: "fixture-fail" });
    });
    await page.getByRole("button", { name: "保存术语表" }).click();
    await expect(page.getByRole("alert")).toContainText("保存失败");
    await expect(page.getByLabel("译词 1", { exact: true })).toHaveValue(
      "内核",
    );
    await page.evaluate(async () => {
      await (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome.runtime.sendMessage({ action: "fixture-fail" });
    });
    await page.getByRole("button", { name: "保存术语表" }).click();
    await expect(page.getByRole("status")).toContainText("术语表已保存");
    const saved = await page.evaluate(async () => {
      return (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome.runtime.sendMessage({ action: "state" });
    });
    expect(saved.settings.targetLanguage).toBe("English");
    expect(saved.settings.glossary).toEqual([
      { source: "kernel", target: "内核" },
    ]);
    await page.getByLabel("导入术语文件").setInputFiles({
      name: "terms.tsv",
      mimeType: "text/tab-separated-values",
      buffer: Buffer.from("cache\t缓存"),
    });
    await expect(page.getByRole("status")).toContainText("合并到草稿");
    await page.getByLabel("搜索术语").fill("缓存");
    await expect(page.getByLabel("原词 1", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("原词 2", { exact: true })).toHaveValue(
      "cache",
    );
    await page.getByLabel("搜索术语").fill("");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON" }).click();
    expect((await download).suggestedFilename()).toBe(
      "lingo-sofa-glossary.json",
    );
    await page.getByRole("button", { name: "保存术语表" }).click();
    await expect(page.getByRole("status")).toContainText("术语表已保存");
    await page.screenshot({ path: ".cache/ui/glossary-populated-dark.png" });
    await nav.getByRole("button", { name: "隐私与数据", exact: true }).click();
    await expect(page.getByLabel("历史保留天数")).toBeDisabled();
    await page.getByLabel("持久保存用量").selectOption("true");
    await page.getByLabel("历史保留天数").selectOption("7");
    await page.getByLabel("统计时区").selectOption("UTC");
    await expect(page.getByRole("status")).toHaveText("所有更改已保存");
    await page
      .getByRole("button", { name: "清除缓存、会话与用量", exact: true })
      .click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await nav.getByRole("button", { name: "用量与费用", exact: true }).click();
    await expect(page.getByLabel("用量摘要")).toContainText("223");
    await nav.getByRole("button", { name: "隐私与数据", exact: true }).click();
    await page
      .getByRole("button", { name: "清除缓存、会话与用量", exact: true })
      .click();
    await page.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("缓存、会话与用量已清除");
    await nav.getByRole("button", { name: "用量与费用", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "还没有请求记录" }),
    ).toBeVisible();
    await expect(page.getByLabel("用量摘要")).not.toContainText("223");
    await nav.getByRole("button", { name: "请求历史", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "用量与费用", exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome.runtime.sendMessage({ action: "fixture-many" });
    });
    await nav.getByRole("button", { name: "请求历史", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator(".ls-history-footer")).toContainText(
      "51–100 / 123",
    );
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(23);
    await expect(
      page.getByRole("button", { name: "下一页", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await page.getByLabel("来源", { exact: true }).selectOption("discord");
    await expect(page.locator("tbody tr")).toHaveCount(0);
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
