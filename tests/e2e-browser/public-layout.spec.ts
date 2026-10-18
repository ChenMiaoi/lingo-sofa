import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import { test, expect, chromium, type Page } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { modelServer } from "../fixtures/model-server.js";

type ExtensionApi = typeof import("wxt/browser").browser;
const pages = [
  {
    id: "hacker-news",
    url: "https://news.ycombinator.com/",
    content: "#hnmain",
    focus: ".titleline",
    heading: ".titleline",
    metadata: ".subtext,.rank,.sitebit",
  },
  {
    id: "github-repository",
    url: "https://github.com/llvm/llvm-project",
    content: "main",
    focus: ".markdown-body",
    heading: ".markdown-body h1",
    metadata: "table[aria-labelledby='folders-and-files']",
  },
  {
    id: "github-issue",
    url: "https://github.com/microsoft/TypeScript/issues/9998",
    content: "main",
    focus: "main h1",
    heading: "main h1",
    metadata: ".Timeline-Item > .TimelineBody",
  },
  {
    id: "mdn",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise",
    content: "main",
    focus: "main h1",
  },
  {
    id: "python",
    url: "https://docs.python.org/3/tutorial/controlflow.html",
    content: ".document",
    focus: ".body h1",
    heading: ".body h1",
  },
  {
    id: "rust-book",
    url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
    content: "main",
    focus: "#what-is-ownership",
    heading: "#what-is-ownership",
    metadata: "#mdbook-menu-bar,#mdbook-sidebar",
  },
  {
    id: "kernel-docs",
    url: "https://docs.kernel.org/core-api/memory-allocation.html",
    content: "[role=main]",
    focus: "h1",
    heading: "h1",
  },
  {
    id: "wikipedia",
    url: "https://en.wikipedia.org/wiki/LLVM",
    content: "#mw-content-text",
    focus: "#firstHeading",
    heading: "#firstHeading",
    metadata: ".mw-editsection,.mw-parser-output .infobox td",
  },
  {
    id: "stack-overflow",
    url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
    content: "#mainbar",
    focus: "#question-header h1",
    heading: "#question-header h1",
    metadata: ".js-voting-container,.post-signature",
  },
  {
    id: "guardian",
    url: "https://www.theguardian.com/international",
    content: "main",
    focus: "main",
  },
  {
    id: "python-forum",
    url: "https://discuss.python.org/latest",
    content: ".topic-list",
    focus: ".topic-list",
    heading: ".topic-list .link-top-line",
    metadata: ".topic-list .num,.topic-list .link-bottom-line",
  },
] as const;

// Deterministic Chinese of comparable length, retaining model protection
// markers and Markdown. This exercises layout, not translation quality.
function chinese(text: string): string {
  const prose =
    "这段示例文字用于检查中文译文的自然换行以及链接和段落的显示效果";
  return text.replace(
    /⟦LS:+\d+⟧|&(?:#\d+|#x[\da-f]+|\w+);|[a-z][a-z\d]*(?:[ \t]+[a-z][a-z\d]*)*/gi,
    (part) => {
      if (part.startsWith("⟦") || part.startsWith("&")) return part;
      const size = Math.max(2, Math.ceil(part.length * 0.5));
      return prose.repeat(Math.ceil(size / prose.length)).slice(0, size);
    },
  );
}

async function settleTranslations(page: Page) {
  // Let resize/scroll intersections reach the translator before checking its
  // pending requests, so screenshots cannot pass on earlier viewport results.
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await expect(
    page.locator("[data-lingo-sofa=controls]").locator(".launcher"),
  ).toHaveAttribute("data-translation", "complete", { timeout: 12_000 });
}

function sourceRegions(selector: string): ParentNode[] {
  const regions: ParentNode[] = [...document.querySelectorAll(selector)];
  // MDN moves live examples into open shadow roots during hydration.
  for (let i = 0; i < regions.length; i++)
    for (const node of regions[i]!.querySelectorAll("*"))
      if (node.shadowRoot) regions.push(node.shadowRoot);
  return regions;
}

async function captureSource(page: Page, content: string) {
  // Keep original node identities: responsive layouts and hydration can add
  // nodes independently of the extension. Ignore added copy-button labels.
  const regions = await page.evaluateHandle(sourceRegions, content);
  const source = await regions.evaluateHandle((regions) => {
    return {
      code: regions.flatMap((region) =>
        [...region.querySelectorAll("pre")].map((node) => ({
          node,
          value: (node.querySelector("code") ?? node).textContent,
        })),
      ),
      links: regions.flatMap((region) =>
        [...region.querySelectorAll("a")].map((node) => ({
          node,
          value: node.getAttribute("href"),
        })),
      ),
      inputs: regions.flatMap((region) =>
        [
          ...region.querySelectorAll<
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          >("input,textarea,select"),
        ].map((node) => ({ node, value: node.value })),
      ),
    };
  });
  await regions.dispose();
  return source;
}

for (const site of pages) {
  test(`public layout: ${site.id}`, async () => {
    test.skip(
      process.env.LINGO_SOFA_PUBLIC_ACCEPTANCE !== "1",
      "Explicit public network acceptance only",
    );
    test.setTimeout(60_000);
    const directory = await mkdtemp(join(tmpdir(), "lingo-public-layout-"));
    if (resolve(dirname(directory)) !== resolve(tmpdir()))
      throw Error("Unexpected test directory");
    const model = await modelServer({ translate: chinese });
    const output = resolve(".cache/public-layout");
    await mkdir(output, { recursive: true });
    const report: Record<string, unknown> = {
      id: site.id,
      url: site.url,
      method:
        "Actual Chromium MV3 with local synthetic Chinese responses; no real model or credentials",
      status: "failed",
    };
    let context:
      Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    let page: Page | undefined;
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
        `${new URL(site.url).origin}/*`,
        "http://127.0.0.1/*",
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
      report.browser = context.browser()?.version();
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      await connectTestAssistant(worker, context);
      const settings = await context.newPage();
      await settings.goto(
        `chrome-extension://${new URL(worker.url()).host}/options.html`,
      );
      await settings.evaluate(async (endpoint) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const state = await api.runtime.sendMessage({ action: "state" });
        const reply = await api.runtime.sendMessage({
          action: "save",
          apiKey: "fixture-public-layout-only",
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
      page = await context.newPage();
      try {
        const response = await page.goto(site.url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        report.httpStatus = response?.status();
        if (!response?.ok()) throw Error(`HTTP ${response?.status()}`);
      } catch (error) {
        report.status = "unavailable";
        report.error = error instanceof Error ? error.message : String(error);
        report.title = await page.title();
        await page.screenshot({
          path: join(output, `${site.id}-unavailable.png`),
        });
        test.skip(true, String(report.error));
      }
      await page
        .locator(site.focus)
        .first()
        .waitFor({ state: "visible", timeout: 8_000 });
      await expect(page.locator(site.content)).not.toHaveCount(0);
      await page.locator(site.focus).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${site.id}-before.png`) });
      const original = await captureSource(page, site.content);
      report.source = await original.evaluate((source) => ({
        codeBlocks: source.code.length,
        links: source.links.length,
        inputs: source.inputs.length,
      }));
      expect(
        await original.evaluate((source) => source.links.length),
      ).toBeGreaterThan(0);
      report.headings = await page
        .locator("h1,h2,h3,[role=heading]")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => !node.closest("[data-lingo-sofa]"))
            .slice(0, 8)
            .map((node) => ({
              tag: node.tagName,
              class: node.className,
              text: node.textContent?.trim().slice(0, 100),
              display: getComputedStyle(node).display,
            })),
        );
      const widths: Record<number, number> = {};
      const translatedWidths: Record<number, number> = {};
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        widths[width] = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      const tabId = await worker.evaluate(async (url) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
        await api.scripting.executeScript({
          target: { tabId: tab.id! },
          files: ["content-scripts/content.js"],
        });
        const reply = await api.tabs.sendMessage(tab.id!, {
          action: "page",
          targetLanguage: "简体中文",
        });
        if (!reply.ok) throw Error(reply.error);
        return tab.id!;
      }, page.url());
      const translations = page.locator('[data-lingo-sofa="translation"]');
      await expect(translations.first()).toBeVisible({ timeout: 12_000 });
      await settleTranslations(page);
      const issues: string[] = [];
      if ("heading" in site)
        await page
          .locator(`${site.heading} > [data-lingo-sofa=translation]`)
          .first()
          .waitFor({ state: "attached", timeout: 3_000 })
          .catch(() =>
            issues.push("Primary heading has no independent translation"),
          );
      await page.evaluate(() =>
        scrollTo(0, document.documentElement.scrollHeight / 2),
      );
      await settleTranslations(page);
      report.middleTranslations = await translations.count();
      await page.screenshot({ path: join(output, `${site.id}-middle.png`) });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator(site.focus).first().scrollIntoViewIfNeeded();
        await settleTranslations(page);
        await expect
          .poll(() =>
            translations.evaluateAll(
              (nodes) =>
                nodes.filter((node) => {
                  const bounds = node.getBoundingClientRect();
                  return (
                    bounds.width > 0 &&
                    bounds.height > 0 &&
                    bounds.bottom > 0 &&
                    bounds.top < innerHeight
                  );
                }).length,
            ),
          )
          .toBeGreaterThan(0);
        await page.screenshot({
          path: join(output, `${site.id}-${width}.png`),
        });
        const widthAfter = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        translatedWidths[width] = widthAfter;
        if (widthAfter > Math.max(width, widths[width]!) + 1) {
          report[`overflow${width}`] = await translations.evaluateAll((nodes) =>
            nodes
              .filter((node) => {
                const bounds = node.getBoundingClientRect();
                return (
                  bounds.width > 0 &&
                  (bounds.right > innerWidth + 1 ||
                    bounds.left + node.scrollWidth > innerWidth + 1)
                );
              })
              .map((node) => ({
                tag: node.parentElement!.tagName,
                class: node.parentElement!.className,
                whiteSpace: getComputedStyle(node).whiteSpace,
                parentWhiteSpace: getComputedStyle(node.parentElement!)
                  .whiteSpace,
                text: node.textContent?.slice(0, 150),
              })),
          );
        }
        report[`width${width}`] = { before: widths[width], after: widthAfter };
        if (widthAfter > Math.max(width, widths[width]!) + 1)
          report[`sourceOverflow${width}`] = await page.evaluate(() =>
            [...document.querySelectorAll("body *")]
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return (
                  !node.closest("pre") &&
                  r.width > 0 &&
                  r.right > innerWidth + 1
                );
              })
              .slice(0, 15)
              .map((node) => ({
                tag: node.tagName,
                class: node.className,
                text: node.textContent?.slice(0, 80),
                right: node.getBoundingClientRect().right,
              })),
          );
        const clipped = await translations.evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const parent = node.parentElement!;
              const style = getComputedStyle(parent);
              const outer = parent.getBoundingClientRect();
              const inner = node.getBoundingClientRect();
              return (
                inner.width > 0 &&
                ((/hidden|clip/.test(style.overflowY) &&
                  inner.bottom > outer.bottom + 1) ||
                  (/hidden|clip/.test(style.overflowX) &&
                    inner.right > outer.right + 1))
              );
            })
            .map((node) => ({
              tag: node.parentElement!.tagName,
              class: node.parentElement!.className,
              text: node.textContent?.slice(0, 60),
            })),
        );
        if (clipped.length)
          issues.push(`${clipped.length} translations clipped at ${width}px`);
        report[`clipped${width}`] = clipped;
      }
      const rendered = await translations.evaluateAll((nodes) =>
        nodes.map((node) => ({
          tag: node.parentElement!.tagName,
          class: node.parentElement!.className,
          text: node.textContent?.slice(0, 100),
          parentDisplay: getComputedStyle(node.parentElement!).display,
          usage: !!node.querySelector(".lingo-sofa-inline-usage"),
          pilcrow: node.textContent?.includes("¶"),
          editLinks: !!node.querySelector('a[href*="action=edit"]'),
        })),
      );
      report.translations = rendered.length;
      report.samples = rendered.slice(0, 20);
      if (
        "metadata" in site &&
        (await page
          .locator(site.metadata)
          .locator("[data-lingo-sofa=translation]")
          .count())
      )
        issues.push("Metadata was translated as reading content");
      if (rendered.some((node) => node.pilcrow))
        issues.push("Heading permalink glyph included in translation");
      if (rendered.some((node) => node.editLinks))
        issues.push("Article edit control cloned into translation");
      if (
        await page
          .locator("pre,button,nav,body > header,[role=banner],input,textarea")
          .locator('[data-lingo-sofa="translation"]')
          .count()
      )
        issues.push("A protected source region contains translations");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await worker.evaluate(
        async (tabId) =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.tabs.sendMessage(tabId, { action: "stop" }),
        tabId,
      );
      await expect(translations).toHaveCount(0);
      // Lazy loading and responsive remounts may change the initial source.
      // Compare widths against the same loaded page with translations removed.
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const restoredWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        report[`width${width}`] = {
          before: widths[width],
          translated: translatedWidths[width],
          restored: restoredWidth,
        };
        if (translatedWidths[width]! > Math.max(width, restoredWidth) + 1)
          issues.push(
            `Translation widened page from ${restoredWidth} to ${translatedWidths[width]} at ${width}px`,
          );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      const currentRegions = await page.evaluateHandle(
        sourceRegions,
        site.content,
      );
      const restored = await original.evaluate((source, regions) => {
        const current = {
          code: new Set(
            regions.flatMap((region) =>
              [...region.querySelectorAll("pre")].map(
                (node) => (node.querySelector("code") ?? node).textContent,
              ),
            ),
          ),
          links: new Set(
            regions.flatMap((region) =>
              [...region.querySelectorAll("a")].map((node) =>
                node.getAttribute("href"),
              ),
            ),
          ),
          inputs: new Set(
            regions.flatMap((region) =>
              [
                ...region.querySelectorAll<
                  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                >("input,textarea,select"),
              ].map((node) => node.value),
            ),
          ),
        };
        return {
          code: source.code.every(
            ({ node, value }) =>
              (node.querySelector("code") ?? node).textContent === value &&
              (node.isConnected || current.code.has(value)),
          ),
          links: source.links.every(
            ({ node, value }) =>
              node.getAttribute("href") === value &&
              (node.isConnected || current.links.has(value)),
          ),
          inputs: source.inputs.every(
            ({ node, value }) =>
              node.value === value &&
              (node.isConnected || current.inputs.has(value)),
          ),
          detachedOriginalNodes: [
            ...source.code,
            ...source.links,
            ...source.inputs,
          ].filter(({ node }) => !node.isConnected).length,
        };
      }, currentRegions);
      await currentRegions.dispose();
      report.restored = restored;
      for (const [kind, matches] of Object.entries({
        code: restored.code,
        links: restored.links,
        inputs: restored.inputs,
      }))
        if (!matches) issues.push(`Source ${kind} changed after restoring`);
      await original.dispose();
      report.requests = model.requests.length;
      report.issues = issues;
      expect(issues).toEqual([]);
      report.status = "passed";
    } catch (error) {
      if (report.status !== "unavailable") {
        report.error = error instanceof Error ? error.message : String(error);
        await page
          ?.screenshot({ path: join(output, `${site.id}-failure.png`) })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await writeFile(
        join(output, `${site.id}.json`),
        JSON.stringify(report, null, 2),
      );
      await context?.close();
      await model.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
