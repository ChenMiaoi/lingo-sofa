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
  const model = await modelServer({ delay: 1500, markdown: true });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<style>article{max-width:600px;margin:40px auto;font:18px/1.7 Georgia}p{margin:12px 0}</style><article><p id="first">Hello
    $x^2$ <code>fetch()</code> with <em>care</em> and <a href="https://example.test/docs?local=only">documentation</a>.<br>Next line.</p><p id="second">Second paragraph remains unchanged.</p><p id="third">Third paragraph.</p><pre><code>const untouched = 1;</code></pre><input value="draft"></article>`,
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
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({ action: "state" });
      const reply = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-inline-key",
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
    await expect(
      page.locator("#first [data-lingo-sofa=translation] strong"),
    ).toHaveText("译文");
    expect(
      await page
        .locator("#first [data-lingo-sofa=translation]")
        .evaluate((node) => getComputedStyle(node).borderBlockStartWidth),
    ).toBe("1px");
    await expect(page.locator("#first .lingo-sofa-inline-usage")).toHaveText(
      "44 Tokens · ≈ ¥0.000000",
    );
    await expect(
      page.locator("#first [data-lingo-sofa=translation] math"),
    ).toHaveCount(1);
    expect(model.requests).toHaveLength(1);
    await expect(
      page.locator("#first [data-lingo-sofa=translation] em"),
    ).toHaveText("care");
    await expect(
      page.locator("#first [data-lingo-sofa=translation] a"),
    ).toHaveAttribute("href", "https://example.test/docs?local=only");
    await expect(
      page.locator("#first [data-lingo-sofa=translation] br"),
    ).toHaveCount(1);
    expect(JSON.stringify(model.requests[0])).not.toContain("example.test");
    expect(
      await page
        .locator("#first [data-lingo-sofa=translation]")
        .evaluate((node) => getComputedStyle(node).borderInlineStartWidth),
    ).toBe("0px");
    for (const color of ["rgb(238, 238, 238)", "rgb(34, 34, 34)"]) {
      await page.evaluate((color) => {
        document.body.style.color = color;
        document.body.style.background =
          color === "rgb(238, 238, 238)" ? "#111" : "#fff";
      }, color);
      const appearance = await page
        .locator("#first [data-lingo-sofa=translation]")
        .evaluate((node) => ({
          color: getComputedStyle(node).color,
          originalColor: getComputedStyle(node.parentElement!).color,
          opacity: getComputedStyle(node).opacity,
        }));
      expect(appearance).toEqual({ color, originalColor: color, opacity: "1" });
    }
    expect(model.requests).toHaveLength(1);
    const launcher = page.getByRole("button", {
      name: "LingoSofa 页面控制，可拖动或用方向键移动",
      exact: true,
    });
    await launcher.click();
    await expect(
      page.getByRole("button", { name: "翻译选中内容", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "翻译整页", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ask", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: ".cache/ui/figma-floating-menu.png" });
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await expect(page.getByRole("combobox")).toHaveCount(2);
    const reading = page.getByRole("switch", { name: "开启双语阅读" });
    await reading.uncheck();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(0);
    await expect(page.getByLabel("目标语言", { exact: true })).toBeDisabled();
    await page.locator("#first").hover();
    await expect(
      page.getByRole("button", { name: "翻译这一段", exact: true }),
    ).toBeHidden();
    const disabledReply = await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tab = (await api.tabs.query({})).find((tab) =>
        tab.url?.startsWith("http://127.0.0.1"),
      )!;
      return api.tabs.sendMessage(tab.id!, { action: "selection" });
    });
    expect(disabledReply.ok).toBe(false);
    expect(model.requests).toHaveLength(1);
    await page.reload();
    await page.evaluate(() => {
      document.body.style.color = "rgb(34, 34, 34)";
      document.body.style.background = "#fff";
    });
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
    await launcher.click();
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await expect(reading).not.toBeChecked();
    await reading.check();
    const automatic = page.getByRole("switch", { name: "自动翻译此网站" });
    await automatic.check();
    await expect(
      page.locator("#first [data-lingo-sofa=translation]"),
    ).toBeVisible();
    await automatic.uncheck();
    await expect(
      page.locator("#first [data-lingo-sofa=translation]"),
    ).toBeVisible();
    await automatic.check();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    await expect(
      page.locator("#second .lingo-sofa-inline-usage"),
    ).toContainText("同批 3 段合计");
    await expect(page.getByText("更多操作", { exact: true })).toHaveCount(0);
    await expect(page.locator("pre code")).toHaveText("const untouched = 1;");
    await expect(page.getByRole("textbox")).toHaveValue("draft");
    await page.screenshot({ path: ".cache/ui/inline-reading.png" });
    await automatic.uncheck();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(3);
    await options.evaluate(async () => {
      await (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({ action: "page", command: "stop" });
    });
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(0);
    await page.evaluate(() => {
      const node = document.querySelector("#second")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 6);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    const selectionToolbar = page.getByRole("toolbar", {
      name: "选中文字操作",
    });
    const beforeSelectionAction = model.requests.length;
    await expect(selectionToolbar).toBeVisible();
    expect(model.requests).toHaveLength(beforeSelectionAction);
    await selectionToolbar
      .getByRole("button", { name: "翻译", exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    expect(model.requests).toHaveLength(beforeSelectionAction);
    await page.screenshot({ path: ".cache/ui/selection-actions.png" });
    await selectionToolbar
      .getByRole("button", { name: "翻译", exact: true })
      .click();
    await expect(selectionToolbar).toBeHidden();
    await expect(
      page.locator("#second [data-lingo-sofa=selection]"),
    ).toContainText("译文 Second");
    expect(
      await page
        .locator("#second [data-lingo-sofa=selection]")
        .evaluate((node) => ({
          color: getComputedStyle(node).color,
          opacity: getComputedStyle(node).opacity,
        })),
    ).toEqual({ color: "rgb(34, 34, 34)", opacity: "1" });
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector("#second")!.firstChild!, 0);
      range.setEnd(document.querySelector("#second")!.firstChild!, 6);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await expect(selectionToolbar).toBeVisible();
    const beforeToolbarAsk = model.requests.length;
    await selectionToolbar
      .getByRole("button", { name: "Ask", exact: true })
      .click();
    const toolbarAsk = page.locator("dialog[data-lingo-sofa=ask]");
    await expect(toolbarAsk).toBeVisible();
    const shellBox = (await toolbarAsk.boundingBox())!;
    const closeBox = (await toolbarAsk
      .getByRole("button", { name: "关闭并清理会话" })
      .boundingBox())!;
    const contentBox = (await toolbarAsk
      .locator(".ls-ask-conversation")
      .boundingBox())!;
    expect(closeBox.y - shellBox.y).toBeLessThanOrEqual(12);
    expect(
      shellBox.x + shellBox.width - closeBox.x - closeBox.width,
    ).toBeLessThanOrEqual(16);
    expect(contentBox.y).toBeGreaterThanOrEqual(closeBox.y + closeBox.height);
    await expect(
      toolbarAsk.locator(".ls-ask-composer-area .ls-ask-header"),
    ).toHaveCount(0);

    await expect(toolbarAsk.locator(".ls-ask-context")).toHaveCount(0);
    await expect(
      toolbarAsk.getByRole("button", { name: "移除所选上下文", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(toolbarAsk.getByText(/Enter 发送|管理供应商/)).toHaveCount(0);
    expect(model.requests).toHaveLength(beforeToolbarAsk);
    await toolbarAsk.getByRole("button", { name: "关闭并清理会话" }).click();
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector("#second")!.firstChild!, 0);
      range.setEnd(document.querySelector("#second")!.firstChild!, 6);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.locator("#second").evaluate((element) => {
      element.tabIndex = -1;
      element.focus();
    });
    const beforeQuickOpen = model.requests.length;
    await page.keyboard.press("Alt+Shift+KeyA");
    const dialog = page.locator("dialog[data-lingo-sofa=ask]");
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(model.requests).toHaveLength(beforeQuickOpen);
    await expect(dialog.locator(".ls-ask-context")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "移除所选上下文", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByRole("heading", { name: "坐下来，聊明白。" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await dialog.boundingBox())!.height)
      .toBe(440);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect
        .poll(() =>
          dialog
            .locator("img")
            .evaluateAll((images) =>
              images.every(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      await page.screenshot({ path: `.cache/ui/figma-ask-empty-${theme}.png` });
      await dialog.screenshot({ path: `.cache/ui/ask-minimal-${theme}.png` });
    }
    const beforeThemeChange = model.requests.length;
    for (const [theme, scheme, canvas] of [
      ["light", "dark", "#fafafa"],
      ["dark", "light", "#1e1f22"],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await options.evaluate(async (uiTheme) => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        await api.storage.local.set({ uiTheme });
      }, theme);
      await expect(dialog).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() =>
          dialog.evaluate((node) =>
            getComputedStyle(node).getPropertyValue("--ls-canvas").trim(),
          ),
        )
        .toBe(canvas);
      await expect
        .poll(() =>
          page
            .locator('[data-lingo-sofa="controls"]')
            .evaluate((node) =>
              getComputedStyle(node).getPropertyValue("--ls-canvas").trim(),
            ),
        )
        .toBe(canvas);
      await expect
        .poll(() =>
          options.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--ls-canvas")
              .trim(),
          ),
        )
        .toBe(canvas);
    }
    expect(model.requests.length).toBe(beforeThemeChange);
    await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.storage.local.remove("uiTheme");
    });
    await dialog.getByRole("button", { name: "解释这段话的含义" }).click();
    await expect(dialog.getByLabel("问题", { exact: true })).toHaveValue(
      "解释这段话的含义",
    );
    const beforeUntrusted = model.requests.length;
    await dialog.getByLabel("问题", { exact: true }).fill("Untrusted attempt");
    await dialog.evaluate((node) => {
      node.querySelector("form")!.requestSubmit();
      node
        .querySelector<HTMLTextAreaElement>(".ls-ask-question")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(model.requests).toHaveLength(beforeUntrusted);
    await dialog
      .getByRole("button", { name: "移除所选上下文", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "添加所选上下文", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await dialog.getByLabel("问题", { exact: true }).fill("Say hello");
    await dialog.getByLabel("问题", { exact: true }).press("Shift+Enter");
    await expect(dialog.getByLabel("问题", { exact: true })).toHaveValue(
      "Say hello\n",
    );
    await dialog.getByLabel("问题", { exact: true }).press("Enter");
    await expect(dialog).toContainText("这是模拟回答。");
    await expect
      .poll(async () => (await dialog.boundingBox())!.height)
      .toBe(660);
    expect(JSON.stringify(model.requests.at(-1))).not.toContain("Second");
    await dialog
      .getByRole("button", { name: "新建 / 清理会话", exact: true })
      .click();
    await expect(
      dialog.getByText("这是模拟回答。", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await dialog.boundingBox())!.height)
      .toBe(440);
    await dialog
      .getByRole("button", { name: "添加所选上下文", exact: true })
      .click();
    await dialog.getByLabel("问题", { exact: true }).fill("Explain");
    await dialog.getByRole("button", { name: "提问", exact: true }).click();
    await expect(dialog).toContainText("这是模拟回答。");
    await page.screenshot({ path: ".cache/ui/figma-ask-answer-dark.png" });
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
