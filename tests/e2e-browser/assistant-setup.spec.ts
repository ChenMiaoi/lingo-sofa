import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
type ExtensionApi = typeof import("wxt/browser").browser;

test("guides browser installation with its own extension ID and hides the guide in direct mode", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lingo-setup-ui-"));
  const extension = join(profile, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const context = await chromium.launchPersistentContext(
    join(profile, "browser"),
    {
      channel: "chromium",
      headless: true,
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
    // Isolate this UI test from any installed native host in the user's profile.
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.getByRole("heading", { name: "AI 与 Pi" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "本地助手安装" }),
    ).toHaveCount(0);
    // The UI mode toggle exposes onboarding before persisting the selection.
    await page.getByText("连接方式", { exact: true }).click();
    await page.getByRole("button", { name: "本地助手", exact: true }).click();
    const setup = page.getByRole("region", { name: "本地助手安装" });
    await expect(setup).toBeVisible();
    await setup.getByText("首次安装或授权此浏览器", { exact: true }).click();
    await expect(setup.locator("code")).toHaveText(id);
    await expect(
      setup.getByRole("link", { name: "下载本地助手" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/ChenMiaoi/lingo-sofa/releases",
    );
    await expect(setup.getByRole("button", { name: "检测连接" })).toBeVisible();
    await page.screenshot({
      path: ".cache/ui/assistant-installation.png",
      fullPage: true,
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
