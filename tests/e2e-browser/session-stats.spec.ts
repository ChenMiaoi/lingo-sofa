import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsSchema } from "@lingo-sofa/protocol";

test("clears previous session totals while a new answer is pending and after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-session-stats-"));
  const extension = resolve("apps/browser-extension/.output/chrome-mv3");
  const context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    await context.addInitScript(
      ({ settings }) => {
        const fixture = globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
          finishCancelledAnswer?: () => void;
        };
        let calls = 0;
        fixture.chrome.runtime.sendMessage = ((message: { action: string }) => {
          if (message.action === "state")
            return Promise.resolve({ settings, usage: [], hasKey: false });
          if (message.action === "page")
            return Promise.resolve({ text: "Selected synthetic context" });
          if (message.action === "ask") {
            if (++calls === 1)
              return Promise.resolve({
                ok: true,
                text: "Fixture answer",
                sessionStats: { tokens: 999, cost: 0.001, messages: 3 },
              });
            return new Promise<unknown>((resolve) => {
              fixture.finishCancelledAnswer = () =>
                resolve({ ok: false, error: "Request cancelled or timed out" });
            });
          }
          return Promise.resolve({ ok: true });
        }) as typeof fixture.chrome.runtime.sendMessage;
      },
      { settings: settingsSchema.parse({ mode: "bridge" }) },
    );
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options
      .getByRole("button", { name: "预览文章 / 选中内容并提问" })
      .click();
    await options.getByLabel("问题", { exact: true }).fill("First question");
    await options.getByRole("button", { name: "提问", exact: true }).click();
    await expect(options.getByText(/Pi 会话汇总/)).toContainText("999");
    await options.getByLabel("问题", { exact: true }).fill("Second question");
    await options.getByRole("button", { name: "提问", exact: true }).click();
    await expect(
      options.getByRole("button", { name: "停止", exact: true }),
    ).toBeVisible();
    await expect(options.getByText(/Pi 会话汇总/)).toHaveCount(0);
    await options.evaluate(() => {
      (
        globalThis as typeof globalThis & { finishCancelledAnswer: () => void }
      ).finishCancelledAnswer();
    });
    await expect(options.getByRole("alert")).toContainText(
      "Request cancelled or timed out",
    );
    await expect(options.getByText(/Pi 会话汇总/)).toHaveCount(0);
    await expect(
      options.getByText("Fixture answer", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
