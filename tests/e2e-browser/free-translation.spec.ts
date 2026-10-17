import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderCatalog } from "@lingo-sofa/protocol";
type ExtensionApi = typeof import("wxt/browser").browser;

test("starts without a Key, switches free engines, keeps Ask separate and persists choices", async () => {
  const live = process.env.LINGO_SOFA_LIVE_TRANSLATION === "1";
  test.setTimeout(live ? 60_000 : 30_000);
  const directory = await mkdtemp(join(tmpdir(), "lingo-free-browser-"));
  const extension = join(directory, "extension");
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      '<article style="margin:60px auto;width:600px;font:20px/1.8 system-ui"><p>Hello world</p></article>',
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = [
    "https://edge.microsoft.com/*",
    "https://translate.googleapis.com/*",
    "http://127.0.0.1/*",
  ];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const background = join(extension, manifest.background.service_worker);
  if (!live)
    await writeFile(
      background,
      `const originalFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{const url=String(input);if(url.startsWith("https://edge.microsoft.com/translate/"))return Response.json(JSON.parse(String(init.body)).map(()=>({translations:[{text:"必应测试译文"}]})));if(url.startsWith("https://translate.googleapis.com/translate_a/"))return Response.json([[["谷歌测试译文"]]]);return originalFetch(input,init);};\n` +
        (await readFile(background, "utf8")),
    );
  const context = await chromium.launchPersistentContext(
    join(directory, "profile"),
    {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 1000 },
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
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html#translation`);
    const bing = page.getByRole("button", { name: /必应翻译/ });
    const google = page.getByRole("button", { name: /谷歌翻译/ });
    await expect(bing).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await google.click();
    await expect(google).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByText("翻译引擎已保存，不影响 Ask 会话", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(google).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("目标语言", { exact: true }).selectOption("English");
    await expect(page.getByRole("status")).toContainText("所有更改已保存");
    await page.reload();
    await expect(google).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("目标语言", { exact: true }).selectOption("简体中文");
    await expect(page.getByRole("status")).toContainText("所有更改已保存");
    const article = await context.newPage();
    await article.goto(origin);
    await worker.evaluate(async (origin) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((item) =>
        item.url?.startsWith(origin),
      );
      await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        files: ["content-scripts/content.js"],
      });
      await api.tabs.sendMessage(tab!.id!, { action: "page" });
    }, origin);
    await expect(
      article.locator('[data-lingo-sofa="translation"]'),
    ).toContainText(live ? /你好|您好/u : "谷歌测试译文");
    await expect(
      article.locator('[data-lingo-sofa="translation"]'),
    ).toContainText("免 Key 翻译");
    const before = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const catalog: ProviderCatalog = await api.runtime.sendMessage({
        action: "provider-catalog",
        mode: "direct",
      });
      await api.runtime.sendMessage({
        action: "provider-update",
        mode: "direct",
        update: {
          target: "account",
          model: catalog.model,
          apiKey: "fixture-model-key",
        },
      });
      return catalog;
    });
    await page.reload();
    await expect(google).toHaveAttribute("aria-pressed", "true");
    const after = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({
        action: "provider-catalog",
        mode: "direct",
      })) as ProviderCatalog;
    });
    expect(after.askModel).toEqual(before.askModel);
    expect(after.keyConfigured).toBe(true);
    await bing.click();
    await expect(bing).toHaveAttribute("aria-pressed", "true");
    await article.reload();
    await worker.evaluate(async (origin) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((item) =>
        item.url?.startsWith(origin),
      );
      await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        files: ["content-scripts/content.js"],
      });
      await api.tabs.sendMessage(tab!.id!, { action: "page" });
    }, origin);
    await expect(
      article.locator('[data-lingo-sofa="translation"]'),
    ).toContainText(live ? /你好|您好/u : "必应测试译文");
    await article.bringToFront();
    const availability = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return api.runtime.sendMessage({ action: "page-status" });
    });
    const history = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return api.runtime.sendMessage({
        action: "state",
        historyQuery: {
          offset: 0,
          range: "all",
          source: "",
          provider: "",
          model: "",
          scope: "",
          status: "",
        },
      });
    });
    expect(history.usage).toEqual([]);
    expect(history.bridgeUsage).toEqual([]);
    expect(history.historyPage.total).toBeGreaterThan(0);
    expect(history.historyPage.records.length).toBeLessThanOrEqual(50);
    const overview = await page.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({
        action: "state",
        includeUsageSummary: true,
      }),
    );
    expect(overview.usage).toEqual([]);
    expect(overview.bridgeUsage).toEqual([]);
    expect(overview.allUsage.totals.requests).toBeGreaterThan(0);
    expect(availability).toMatchObject({
      supported: true,
      translated: true,
      hasSelection: false,
    });
    await page
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "问答设置", exact: true })
      .click();
    await page.getByText("上下文与权限说明", { exact: true }).click();
    await expect(page.getByText("仅所选文本", { exact: true })).toBeVisible();
    await page.getByText("上下文与权限说明", { exact: true }).click();
    await expect(
      page.getByText("仅所选文本", { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByLabel("Ask 默认模型", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "翻译引擎", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "翻译偏好", exact: true })
      .click();
    await mkdir(".cache/ui", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: `.cache/ui/free-translation-browser-${colorScheme}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 400, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(google).toBeVisible();
  } finally {
    await context.close();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("offers free translation and independent Ask in Discord settings at narrow widths", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import React from "react";import {createRoot} from "react-dom/client";import {createAISettings} from "./packages/ui-shared/src/ai-settings.tsx";
const Settings=createAISettings(()=>React);const model={provider:"deepseek",authMode:"api_key",model:"deepseek-flash",endpoint:"https://api.deepseek.com",maxOutputTokens:0,timeoutMs:30000,prices:null};let catalog={translationEngine:"bing",model,askModel:model,accounts:[],keyConfigured:false,piAuth:false,providers:[]};window.saved=[];window.fail=false;
createRoot(document.getElementById("root")).render(<Settings client={{providers:async()=>catalog,configureProvider:async(update)=>{if(window.fail)throw Error("fixture save failure");window.saved.push(update);if(update.target==="translation-engine")catalog={...catalog,translationEngine:update.engine};return {ok:true};}}}/>);`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "transform",
    jsxFactory: "React.createElement",
  });
  await page.setViewportSize({ width: 480, height: 1000 });
  await page.setContent('<div id="root" style="padding:20px"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const google = page.getByRole("button", { name: /谷歌翻译/ });
  const bing = page.getByRole("button", { name: /必应翻译/ });
  await expect(bing).toHaveAttribute("aria-pressed", "true");
  await google.click();
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Ask 默认模型", { exact: true })).toHaveValue(
    "current:deepseek-flash",
  );
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = true;
  });
  await bing.click();
  await expect(page.getByRole("alert")).toContainText("fixture save failure");
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = false;
  });
  await google.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mkdir(".cache/ui", { recursive: true });
  await page.screenshot({
    path: ".cache/ui/free-translation-discord-narrow.png",
    fullPage: true,
  });
});
