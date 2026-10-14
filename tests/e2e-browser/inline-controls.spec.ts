import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";
type ExtensionApi = typeof import("wxt/browser").browser;

test("keeps bilingual reading inline with lightweight paragraph/page controls and separate selected-content questions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-inline-"));
  const model = await modelServer({ delay: 1500 });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<style>article{max-width:600px;margin:40px auto;font:18px/1.7 Georgia}p{margin:12px 0}</style><article><p id="first">Hello <code>fetch()</code></p><p id="second">Second paragraph remains unchanged.</p><p id="third">Third paragraph.</p><pre><code>const untouched = 1;</code></pre><input value="draft"></article>`,
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
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      const reply = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-inline-key",
        settings: {
          ...state.settings,
          model: {
            ...state.settings.model,
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      });
      if (!reply.ok) throw new Error(reply.error);
    }, model.endpoint);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((tab) =>
        tab.url?.startsWith("http://127.0.0.1"),
      )!;
      await api.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ["content-scripts/content.js"],
      });
    });
    expect(model.requests).toHaveLength(0);
    await page.locator("#first").hover();
    await page.getByRole("button", { name: "翻译这一段", exact: true }).click();
    await expect(
      page.locator("#first [data-lingo-sofa=translation]"),
    ).toContainText("fetch()");
    await expect(page.locator("#second")).toHaveText(
      "Second paragraph remains unchanged.",
    );
    expect(model.requests).toHaveLength(1);
    expect(
      await page
        .locator("#first [data-lingo-sofa=translation]")
        .evaluate((node) => getComputedStyle(node).borderInlineStartWidth),
    ).toBe("0px");
    const launcher = page.getByRole("button", {
      name: "LingoSofa 页面控制，可拖动或用方向键移动",
      exact: true,
    });
    await launcher.click();
    await page.getByRole("button", { name: "翻译整页", exact: true }).click();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "继续翻译", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("#first [data-lingo-sofa=translation]"),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续翻译", exact: true }).click();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    await expect(
      page.getByRole("button", { name: "恢复原文", exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("pre code")).toHaveText("const untouched = 1;");
    await expect(page.locator("input")).toHaveValue("draft");
    await page.screenshot({ path: ".cache/ui/inline-reading.png" });
    await page
      .getByRole("button", { name: "恢复原文", exact: true })
      .first()
      .click();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(0);
    await page.evaluate(() => {
      const node = document.querySelector("#second")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 6);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    const selectionReply = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return api.runtime.sendMessage({ action: "page", command: "selection" });
    });
    expect(selectionReply.ok).toBe(true);
    await expect(
      page.locator("#second [data-lingo-sofa=selection]"),
    ).toHaveText("译文 Second");
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.getByText("更多操作", { exact: true }).click();
    await page
      .getByRole("button", { name: "解释 / Ask Pi", exact: true })
      .click();
    const dialog = page.locator("dialog[data-lingo-sofa=ask]");
    await expect(
      dialog.getByLabel("将发送的上下文", { exact: true }),
    ).toHaveValue("Second");
    await dialog.getByLabel("问题", { exact: true }).fill("Explain");
    await dialog.getByRole("button", { name: "提问", exact: true }).click();
    await expect(dialog).toContainText("这是模拟回答。");
    await dialog.getByLabel("问题", { exact: true }).fill("Explain again");
    await dialog.getByRole("button", { name: "提问", exact: true }).click();
    await page.locator("#second").evaluate((element) => {
      element.firstChild!.textContent = "Changed original";
    });
    await expect(dialog.getByRole("alert")).toContainText("已变化");
    await expect(
      dialog.getByText("这是模拟回答。", { exact: true }),
    ).toHaveCount(1);
    await dialog
      .getByRole("button", { name: "关闭并清理会话", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(JSON.stringify(model.requests.at(-1))).toContain("Second");
    expect(JSON.stringify(model.requests.at(-1))).not.toContain(
      "Third paragraph",
    );
    await page.locator("#second").evaluate((element) => {
      element.firstChild!.textContent = "Changed original";
    });
    await expect(
      page.locator("#second [data-lingo-sofa=selection]"),
    ).toHaveCount(0);
    await launcher.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
