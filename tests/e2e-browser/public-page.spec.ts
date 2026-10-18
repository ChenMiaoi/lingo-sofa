import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import { test, chromium, expect } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelServer } from "../fixtures/model-server.js";
type ExtensionApi = typeof import("wxt/browser").browser;
test("preserves real public LLVM page controls and restores inline bilingual content", async () => {
  test.skip(
    process.env.LINGO_SOFA_PUBLIC_ACCEPTANCE !== "1",
    "Explicit network compatibility acceptance only",
  );
  const temp = await mkdtemp(join(tmpdir(), "lingo-public-"));
  const model = await modelServer();
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const extension = join(temp, "extension");
    await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
      recursive: true,
    });
    await prepareTestExtension(extension);
    const manifest = JSON.parse(
      await readFile(join(extension, "manifest.json"), "utf8"),
    );
    manifest.host_permissions = ["https://llvm.org/*", "http://127.0.0.1/*"];
    await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await connectTestAssistant(worker, context);
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      const reply = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-public-only",
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
    const url = "https://llvm.org/docs/ProgrammersManual.html";
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (response?.status() !== 200) throw Error("Public page unavailable");
    const before = await page.evaluate(() => ({
      codes: [...document.querySelectorAll("pre")].map((e) => e.textContent),
      links: [...document.querySelectorAll("a")].map((e) =>
        e.getAttribute("href"),
      ),
      inputs: [...document.querySelectorAll("input")].map((e) => e.value),
    }));
    const tabId = await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((t) =>
        t.url?.startsWith("https://llvm.org/docs/ProgrammersManual.html"),
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
    await expect(
      page.locator("[data-lingo-sofa=translation]").first(),
    ).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => scrollTo(0, 2500));
    await expect(page.locator("[data-lingo-sofa=translation]")).not.toHaveCount(
      0,
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-lingo-sofa=translation]").length >= 3,
    );
    const translations = await page
      .locator("[data-lingo-sofa=translation]")
      .count();
    await page.screenshot({ path: ".cache/ui/public-llvm.png" });
    await worker.evaluate(
      async (tabId) =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.tabs.sendMessage(tabId, { action: "stop" }),
      tabId,
    );
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(0);
    const after = await page.evaluate(() => ({
      codes: [...document.querySelectorAll("pre")].map((e) => e.textContent),
      links: [...document.querySelectorAll("a")].map((e) =>
        e.getAttribute("href"),
      ),
      inputs: [...document.querySelectorAll("input")].map((e) => e.value),
    }));
    expect(after).toEqual(before);
    const report = {
      url,
      browser: context.browser()?.version(),
      translations,
      requests: model.requests.length,
      codeBlocks: before.codes.length,
      links: before.links.length,
      inputs: before.inputs.length,
      restored: true,
      method:
        "Actual public LLVM page with actual MV3; local fixture provider only, no credentials or real model quality claim",
    };
    await writeFile(
      ".cache/public-page-report.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await context?.close();
    await model.close();
    await rm(temp, { recursive: true, force: true });
  }
});
