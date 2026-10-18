import { test, expect, chromium } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BROWSER_EXTENSION_ID,
  type ProviderCatalog,
} from "@lingo-sofa/protocol";

type ExtensionApi = typeof import("wxt/browser").browser;

test("keeps its ID, accounts and preferences when an updated browser build moves to a different directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-browser-identity-"));
  const first = join(directory, "old-version");
  const second = join(directory, "new-version");
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const launch = (extension: string) =>
    chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
  try {
    for (const extension of [first, second])
      await cp(
        resolve("apps/browser-extension/.output/chrome-mv3"),
        extension,
        { recursive: true },
      );
    const manifest = JSON.parse(
      await readFile(join(second, "manifest.json"), "utf8"),
    );
    const parts = manifest.version.split(".").map(Number);
    parts[parts.length - 1] = parts.at(-1)! + 1;
    manifest.version = parts.join(".");
    await writeFile(join(second, "manifest.json"), JSON.stringify(manifest));
    context = await launch(first);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(BROWSER_EXTENSION_ID);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${BROWSER_EXTENSION_ID}/options.html`);
    await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const current = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      const reply = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-stable-browser-key",
        settings: {
          ...current.settings,
          targetLanguage: "English",
          mode: "direct",
        },
      });
      if (!reply.ok) throw Error(reply.error);
      const engine = await api.runtime.sendMessage({
        action: "provider-update",
        mode: "direct",
        update: { target: "translation-engine", engine: "google" },
      });
      if (!engine.ok) throw Error(engine.error);
      await api.storage.local.set({ readingEnabled: false });
    });
    await context.close();
    context = await launch(second);
    const restoredWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(new URL(restoredWorker.url()).host).toBe(BROWSER_EXTENSION_ID);
    const reopened = await context.newPage();
    await reopened.goto(
      `chrome-extension://${BROWSER_EXTENSION_ID}/options.html`,
    );
    await expect(reopened.getByLabel("目标语言", { exact: true })).toHaveValue(
      "English",
    );
    await expect(
      reopened.getByRole("button", { name: "谷歌翻译 免 Key" }),
    ).toHaveAttribute("aria-pressed", "true");
    const saved = await reopened.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return {
        state: await api.runtime.sendMessage({
          action: "state",
          localOnly: true,
        }),
        catalog: (await api.runtime.sendMessage({
          action: "provider-catalog",
          mode: "direct",
        })) as ProviderCatalog,
        readingEnabled: (await api.storage.local.get("readingEnabled"))
          .readingEnabled,
      };
    });
    expect(saved.state.hasKey).toBe(true);
    expect(saved.catalog.accounts).toHaveLength(1);
    expect(saved.catalog.translationEngine).toBe("google");
    expect(saved.readingEnabled).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("fixture-stable-browser-key");
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
