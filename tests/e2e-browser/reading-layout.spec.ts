import { test, expect, chromium } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";

type ExtensionApi = typeof import("wxt/browser").browser;

const translations = [
  ["A quieter way to read in two languages", "让双语阅读更从容"],
  [
    "Good typography lets you follow an idea without losing your place. Keep the original nearby and let the translation flow naturally beneath it.",
    "好的排版让你专注于文字，不必反复寻找读到的位置。原文就在眼前，译文在下方自然延续，阅读始终围绕同一个意思。",
  ],
  ["Read ", "阅读"],
  ["the key idea", "核心观点"],
  [", follow ", "，参考"],
  ["the guide", "使用指南"],
  [", and keep ", "，保留"],
  [" unchanged.", "原样。"],
  ["An explicit line break belongs to the source.", "原文的明确换行也应保留。"],
  ["One idea, one reading rhythm", "围绕同一个意思，保持连贯的阅读节奏"],
  ["Keep context.", "保留上下文。"],
  [
    "A longer list item should still read as one item. Its translation belongs beneath the original, aligned with the text rather than introducing another bullet or a full-width separator.",
    "较长的列表项仍然是同一个条目。译文放在原文下方，与正文对齐，不添加新的项目符号，也不以横线把内容割开。",
  ],
  ["Details stay together.", "细节保持在一起。"],
  ["Nested information remains nested.", "嵌套信息保留原有的缩进关系。"],
  [
    "Translation should support reading, with enough space to breathe and enough contrast to stay clear.",
    "翻译应当服务于阅读：留白适度，文字清晰，不让装饰分散注意力。",
  ],
  [
    "Wrap translated text.",
    "即使网页将原文设为不换行，较长的译文也应根据可用宽度自然折行，不把手机页面撑宽。",
  ],
  ["Feature", "功能"],
  ["Detail", "说明"],
  ["Bilingual reading", "双语阅读"],
  [
    "Readable narrow columns",
    "窄列中的长内容也应清晰可读，并允许 VeryLongIdentifierWithoutNaturalBreaksToExerciseNarrowColumnWrapping 在单元格内部换行。",
  ],
  ["قراءة مريحة مع الحفاظ على النص الأصلي.", "舒适阅读，并保留原文。"],
] as const;

test("keeps whole-page reading spacious, stacked and within narrow source columns", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "lingo-reading-layout-"));
  if (resolve(dirname(directory)) !== resolve(tmpdir()))
    throw Error("Unexpected test directory");
  const model = await modelServer({
    translate: (text) =>
      translations.reduce(
        (value, [source, target]) => value.replaceAll(source, target),
        text,
      ),
  });
  const html = await readFile("tests/fixtures/reading-layout.html", "utf8");
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const extension = join(directory, "extension");
    await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(join(extension, "manifest.json"), "utf8"),
    );
    manifest.host_permissions = ["http://127.0.0.1/*"];
    await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(
      join(directory, "profile"),
      {
        channel: "chromium",
        headless: true,
        viewport: { width: 1440, height: 1200 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const settings = await context.newPage();
    await settings.goto(
      `chrome-extension://${new URL(worker.url()).host}/options.html`,
    );
    await settings.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      const result = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-reading-layout-only",
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
      if (!result.ok) throw Error(result.error);
    }, model.endpoint);
    const page = await context.newPage();
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    await page.goto(url);
    const original = await page.locator("main").innerHTML();
    const sourceIds = await page
      .locator("[id^=reading-]:not(ul)")
      .evaluateAll((nodes) => nodes.map((node) => node.id));
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
    for (const id of sourceIds) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(
        page.locator(`#${id} > [data-lingo-sofa=translation]`),
      ).toBeVisible();
    }
    const translated = page.locator("[data-lingo-sofa=translation]");
    await expect(translated).toHaveCount(sourceIds.length);
    await expect(page.locator(".lingo-sofa-inline-usage")).toHaveCount(0);
    const calls = model.requests.length;
    await mkdir(".cache/ui", { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator("#reading-title").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `.cache/ui/reading-layout-${theme}-${width}.png`,
          fullPage: true,
          caret: "initial",
        });
        const layout = await translated.evaluateAll((nodes) => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          paragraphs: nodes.map((node) => {
            const source = node.parentElement!;
            const range = document.createRange();
            range.selectNodeContents(source);
            range.setEndBefore(node);
            const sourceBounds = range.getBoundingClientRect();
            const bounds = node.getBoundingClientRect();
            return {
              id: source.id,
              sourceBottom: sourceBounds.bottom,
              top: bounds.top,
              right: bounds.right,
              scrollRight: bounds.left + node.scrollWidth,
              sourceRight: source.getBoundingClientRect().right,
              font: Number.parseFloat(getComputedStyle(node).fontSize),
              sourceFont: Number.parseFloat(getComputedStyle(source).fontSize),
              separator: getComputedStyle(node).borderBlockStartWidth,
            };
          }),
        }));
        expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(
          layout.viewport,
        );
        for (const paragraph of layout.paragraphs) {
          expect(paragraph.top, paragraph.id).toBeGreaterThanOrEqual(
            paragraph.sourceBottom - 1,
          );
          expect(paragraph.right, paragraph.id).toBeLessThanOrEqual(
            paragraph.sourceRight + 1,
          );
          expect(paragraph.scrollRight, paragraph.id).toBeLessThanOrEqual(
            paragraph.sourceRight + 1,
          );
          expect(paragraph.separator, paragraph.id).toBe("0px");
        }
        const heading = layout.paragraphs.find(
          (paragraph) => paragraph.id === "reading-title",
        )!;
        expect(heading.font).toBeLessThan(heading.sourceFont * 0.9);
        const intro = layout.paragraphs.find(
          (paragraph) => paragraph.id === "reading-intro",
        )!;
        expect(intro.top - intro.sourceBottom).toBeLessThan(intro.font);
      }
    }
    await expect(
      page.locator("#reading-direction > [data-lingo-sofa=translation]"),
    ).toHaveCSS("direction", "ltr");
    await expect(
      page.locator("#reading-format [data-lingo-sofa=translation] br"),
    ).toHaveCount(1);
    await expect(
      page.locator("#reading-format [data-lingo-sofa=translation] a"),
    ).toHaveAttribute("href", "https://example.test/guide?keep=original");
    await expect(page.locator("pre code")).toHaveText(
      'const original = await fetch("/source");',
    );
    await expect(page.getByRole("textbox")).toHaveValue("Keep my draft");
    expect(model.requests).toHaveLength(calls);
    await worker.evaluate(
      async (tabId) =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.tabs.sendMessage(tabId, { action: "stop" }),
      tabId,
    );
    await expect(translated).toHaveCount(0);
    expect(await page.locator("main").innerHTML()).toBe(original);
  } finally {
    await context?.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
