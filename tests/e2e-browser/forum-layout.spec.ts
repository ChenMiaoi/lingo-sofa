import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";

type ExtensionApi = typeof import("wxt/browser").browser;

// Fixed Chinese responses exercise CJK wrapping, without a paid model call.
const translations = [
  ["Adding Chromium C++ code to CTMark", "将 Chromium C++ 代码加入 CTMark"],
  [
    "A web-based matcher for checking how often an IR pattern occurs in real code",
    "用网页匹配器检查 IR 模式在真实代码中的出现频率",
  ],
  [
    "Reducing release note merge conflicts with per-change fragments",
    "按变更记录片段，减少发布说明的合并冲突",
  ],
  [
    "CPU store-packing opportunities and default pipeline scheduling",
    "CPU 存储打包机会与默认流水线调度",
  ],
  ["Forbid AI-generated communication", "禁止使用 AI 生成的交流内容"],
  [
    "Mapping MLIR linalg.matmul to an RTL Systolic Array",
    "将 MLIR linalg.matmul 映射到 RTL 脉动阵列",
  ],
  [
    "Question on permutation maps vs masking in rank-reducing vectorization",
    "关于降秩向量化中置换映射与掩码的问题",
  ],
  [
    "I think some maintenance cost is unavoidable. We can settle on the design and metadata before implementing the workflow.",
    "我认为，一些维护成本不可避免。可以先确定设计和元数据，再实现这套工作流程。",
  ],
  ["Updated title", "更新后的标题"],
  ["Topic", "主题"],
] as const;

for (const source of ["fixture", "public"] as const) {
  test(`preserves compact forum titles and table layout on ${source}`, async () => {
    test.skip(
      source === "public" && process.env.LINGO_SOFA_PUBLIC_ACCEPTANCE !== "1",
      "Explicit network compatibility acceptance only",
    );
    test.setTimeout(60_000);
    const directory = await mkdtemp(join(tmpdir(), "lingo-forum-"));
    if (resolve(dirname(directory)) !== resolve(tmpdir()))
      throw Error("Unexpected test directory");
    const model = await modelServer({
      translate: (text) =>
        translations.reduce(
          (value, [original, translated]) =>
            value.replaceAll(original, translated),
          text,
        ),
    });
    const html = await readFile("tests/fixtures/forum.html", "utf8");
    const site = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    let context:
      Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    try {
      const extension = join(directory, "extension");
      await cp(
        resolve("apps/browser-extension/.output/chrome-mv3"),
        extension,
        { recursive: true },
      );
      await prepareTestExtension(extension);
      const manifest = JSON.parse(
        await readFile(join(extension, "manifest.json"), "utf8"),
      );
      manifest.host_permissions = [
        "http://127.0.0.1/*",
        ...(source === "public" ? ["https://discourse.llvm.org/*"] : []),
      ];
      await writeFile(
        join(extension, "manifest.json"),
        JSON.stringify(manifest),
      );
      context = await chromium.launchPersistentContext(
        join(directory, "profile"),
        {
          channel: "chromium",
          headless: true,
          viewport: { width: 1440, height: 1000 },
          args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
          ],
        },
      );
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      await connectTestAssistant(worker, context);
      const options = await context.newPage();
      await options.goto(
        `chrome-extension://${new URL(worker.url()).host}/options.html?view=activity`,
      );
      await options.evaluate(async (endpoint) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const state = await api.runtime.sendMessage({ action: "state" });
        const reply = await api.runtime.sendMessage({
          action: "save",
          apiKey: "fixture-forum-only",
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
        if (!reply.ok) throw Error(reply.error);
      }, model.endpoint);
      const page = await context.newPage();
      const url =
        source === "public"
          ? "https://discourse.llvm.org/latest"
          : `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      await expect(
        page.locator(".topic-list .link-top-line").first(),
      ).toBeVisible();
      const original = await page
        .locator(".topic-list")
        .evaluate((table) => table.innerHTML);
      const values = await page
        .locator(".topic-list tbody td.num")
        .allTextContents();
      const tabId = await worker.evaluate(async (url) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
        await api.scripting.executeScript({
          target: { tabId: tab.id! },
          files: ["content-scripts/content.js"],
        });
        await api.tabs.sendMessage(tab.id!, {
          action: "page",
          targetLanguage: "简体中文",
        });
        return tab.id!;
      }, url);
      const titles = page.locator(
        '.topic-list .link-top-line > [data-lingo-sofa="translation"]',
      );
      await expect(titles.first()).toBeVisible({ timeout: 15_000 });
      await expect(titles.nth(2)).toBeVisible();
      await expect(titles.first()).toHaveAttribute("title", /Tokens/);
      await expect(titles.locator(".lingo-sofa-inline-usage")).toHaveCount(0);
      await expect(
        page.locator(
          ".topic-list .num [data-lingo-sofa],.link-bottom-line [data-lingo-sofa],#navigation-bar [data-lingo-sofa],.category-breadcrumb [data-lingo-sofa],.filters [data-lingo-sofa]",
        ),
      ).toHaveCount(0);
      expect(
        await page.locator(".topic-list tbody td.num").allTextContents(),
      ).toEqual(values);
      expect(
        await titles
          .first()
          .evaluate((node) => getComputedStyle(node).borderBlockStartWidth),
      ).toBe("0px");
      if (source === "fixture") {
        await expect(titles.locator("math")).toHaveCount(0);
        await expect(titles.first()).toContainText(
          "[RFC] 将 Chromium C++ 代码加入 CTMark",
        );
        await expect(titles.nth(2)).toContainText("[LoadStoreVectorizer]");
        await expect(
          page.locator("article .lingo-sofa-inline-usage"),
        ).toHaveCount(0);
        await expect(
          page.locator("article [data-lingo-sofa=translation]").first(),
        ).toHaveAttribute("title", /Tokens/);
        expect(JSON.stringify(model.requests)).not.toContain("infrastructure");
      }
      await mkdir(".cache/ui", { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        expect(
          await titles
            .first()
            .evaluate(
              (node) =>
                getComputedStyle(node).color ===
                getComputedStyle(node.parentElement!).color,
            ),
        ).toBe(true);
        await page.screenshot({
          path: `.cache/ui/forum-${source}-${theme}.png`,
        });
      }
      if (source === "fixture") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: ".cache/ui/forum-fixture-mobile.png" });
        const layout = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
        }));
        expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(
          layout.viewport,
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page
          .locator(".raw-topic-link")
          .first()
          .evaluate((link) => {
            link.firstChild!.textContent = "[RFC] Updated title";
          });
        await expect(titles.first()).toContainText("[RFC] 更新后的标题");
        await expect(titles).toHaveCount(3);
      }
      await worker.evaluate(
        async (tabId) =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.tabs.sendMessage(tabId, { action: "stop" }),
        tabId,
      );
      await expect(page.locator('[data-lingo-sofa="translation"]')).toHaveCount(
        0,
      );
      if (source === "fixture") {
        await page
          .locator(".raw-topic-link")
          .first()
          .evaluate((link) => {
            link.firstChild!.textContent =
              "[RFC] Adding Chromium C++ code to CTMark";
            const range = document.createRange();
            range.selectNodeContents(link);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
          });
        const reply = await worker.evaluate(
          async (tabId) =>
            (
              globalThis as typeof globalThis & { chrome: ExtensionApi }
            ).chrome.tabs.sendMessage(tabId, {
              action: "selection",
              targetLanguage: "简体中文",
            }),
          tabId,
        );
        expect(reply.ok).toBe(true);
        const selection = page.locator('[data-lingo-sofa="selection"]');
        await expect(selection).toContainText("[RFC]");
        await expect(selection).toHaveAttribute("title", /Tokens/);
        await expect(
          selection.locator("math,.lingo-sofa-inline-usage"),
        ).toHaveCount(0);
        expect(
          await selection.evaluate(
            (node) => getComputedStyle(node).borderBlockStartWidth,
          ),
        ).toBe("0px");
        await page
          .locator(".link-top-line")
          .first()
          .evaluate((node) => node.setAttribute("translate", "no"));
        await expect(selection).toHaveCount(0);
        await page
          .locator(".link-top-line")
          .first()
          .evaluate((node) => node.removeAttribute("translate"));
      }
      expect(
        await page.locator(".topic-list").evaluate((table) => table.innerHTML),
      ).toBe(original);
    } finally {
      await context?.close();
      await model.close();
      site.closeAllConnections();
      await new Promise<void>((done) => site.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
