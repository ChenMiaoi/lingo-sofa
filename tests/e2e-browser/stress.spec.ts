import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";
type ExtensionApi = typeof import("wxt/browser").browser;

test("handles 1,000 visible paragraphs and 100 SPA replacements in the actual MV3 runtime", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "lingo-stress-"));
  const model = await modelServer({ delay: 1 });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<style>p{margin:0;line-height:16px}</style><article>${Array.from({ length: 1000 }, (_, i) => `<p>Paragraph ${i} <code>fetch()</code></p>`).join("")}</article>`,
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
      viewport: { width: 1200, height: 40000 },
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
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      const result = await api.runtime.sendMessage({
        action: "save",
        settings: {
          ...state.settings,
          mode: "direct",
          model: {
            ...state.settings.model,
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            maxOutputTokens: 8192,
            prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        apiKey: "fixture-stress-key",
      });
      if (!result.ok) throw new Error(result.error);
    }, model.endpoint);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
    const started = Date.now();
    const tabId = await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((candidate) =>
        candidate.url?.startsWith("http://127.0.0.1"),
      )!;
      await api.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ["content-scripts/content.js"],
      });
      await api.tabs.sendMessage(tab.id!, {
        action: "page",
        targetLanguage: "简体中文",
      });
      return tab.id!;
    });
    await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
      1000,
      { timeout: 30_000 },
    );
    await expect(page.locator("p > code")).toHaveCount(1000);
    await expect(
      page.locator("p [data-lingo-sofa=translation] code"),
    ).toHaveCount(1000);
    const firstPassMs = Date.now() - started;
    const firstRequests = model.requests.length;
    for (let view = 0; view < 100; view++) {
      await page.evaluate((view) => {
        const article = document.querySelector("article")!;
        article.replaceChildren(
          ...Array.from({ length: 5 }, (_, row) => {
            const p = document.createElement("p");
            p.textContent = `View ${view} row ${row}`;
            return p;
          }),
        );
        history.replaceState(null, "", `?view=${view}`);
      }, view);
      await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
        5,
      );
      await expect(
        page.locator("[data-lingo-sofa='translation']").first(),
      ).toContainText(`View ${view} row 0`);
    }
    const requestsBeforeStop = model.requests.length;
    await worker.evaluate(async (tabId) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.tabs.sendMessage(tabId, { action: "stop" });
    }, tabId);
    await expect(
      page.locator(
        "[data-lingo-sofa=translation],[data-lingo-sofa=error],[data-lingo-sofa=selection]",
      ),
    ).toHaveCount(0);
    await page.locator("article").evaluate((article) => {
      const p = document.createElement("p");
      p.textContent = "After stop";
      article.append(p);
    });
    await expect(page.locator("article p")).toHaveCount(6);
    expect(model.requests.length).toBe(requestsBeforeStop);
    await writeFile(
      ".cache/browser-stress-report.json",
      JSON.stringify(
        {
          browser: context.browser()?.version(),
          paragraphs: 1000,
          spaReplacements: 100,
          firstPassMs,
          firstRequests,
          totalRequests: requestsBeforeStop,
          originalCodePreserved: true,
          stoppedAndCleaned: true,
          method:
            "Synthetic local fixture, oversized viewport makes all blocks visible; elapsed includes fixture model/queue/rendering and is not extraction-only or internet latency",
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
