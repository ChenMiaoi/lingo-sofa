import { test, expect, chromium } from "@playwright/test";
import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";

type ExtensionApi = typeof import("wxt/browser").browser;
const launcherName = "LingoSofa 页面控制，可拖动或用方向键移动";

test("restores authorized reading and floating preferences across full browser restarts without opening extension UI", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "lingo-reading-startup-"));
  if (resolve(dirname(directory)) !== resolve(tmpdir()))
    throw Error("Unexpected test directory");
  const model = await modelServer();
  let revision = 0;
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<article><p>Reading after restart ${revision}</p></article>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const extension = join(directory, "extension");
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
      recursive: true,
    });
    await prepareTestExtension(extension);
    const manifest = JSON.parse(
      await readFile(join(extension, "manifest.json"), "utf8"),
    );
    manifest.host_permissions = ["http://127.0.0.1/*"];
    await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
    const launch = () =>
      chromium.launchPersistentContext(join(directory, "profile"), {
        channel: "chromium",
        headless: true,
        viewport: { width: 1100, height: 800 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      });
    context = await launch();
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const assistant = await connectTestAssistant(worker, context);
    const id = new URL(worker.url()).host;
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/options.html`);
    await setup.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const current = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      const reply = await api.runtime.sendMessage({
        action: "save",
        apiKey: "fixture-restart-only",
        settings: {
          ...current.settings,
          mode: "direct",
          model: {
            ...current.settings.model,
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      });
      if (!reply.ok) throw Error(reply.error);
      await api.storage.local.set({
        floatingDock: { side: "left", y: 0.25, autoHide: false },
      });
    }, model.endpoint);
    await setup.close();
    // Command-line unpacked extensions may create their install welcome tab on
    // every launch. Close that tab without interacting with extension UI.
    const closeWelcome = async () => {
      for (const tab of context!.pages())
        if (tab.url().startsWith(`chrome-extension://${id}/`))
          await tab.close();
    };
    await closeWelcome();
    let page = await context.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: launcherName }),
    ).toBeVisible();
    expect(model.requests).toHaveLength(0);
    await page.getByRole("button", { name: launcherName }).click();
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await page.getByRole("switch", { name: "自动翻译此网站" }).check();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveText(
      "译文 Reading after restart 0",
    );
    await context.close();

    revision++;
    context = await launch();
    await assistant.attach(
      context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker")),
    );
    await closeWelcome();
    // Navigate directly to the authorized site. No popup/options page wakes it.
    page = await context.newPage();
    await page.goto(url);
    const launcher = page.getByRole("button", { name: launcherName });
    await expect(launcher).toBeVisible();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveText(
      "译文 Reading after restart 1",
    );
    await expect(page.locator("[data-lingo-sofa=controls]")).toHaveCount(1);
    const dock = page.locator("[data-lingo-sofa=controls] .dock");
    await expect(dock).toHaveAttribute("data-side", "left");
    expect((await launcher.boundingBox())!.x).toBe(16);
    await launcher.click();
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "空闲自动收起" }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("switch", { name: "自动翻译此网站" }),
    ).toBeChecked();
    await page.getByRole("switch", { name: "开启双语阅读" }).uncheck();
    await expect(
      page.getByRole("switch", { name: "开启双语阅读" }),
    ).toBeEnabled();
    await context.close();

    revision++;
    const calls = model.requests.length;
    context = await launch();
    await assistant.attach(
      context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker")),
    );
    await closeWelcome();
    page = await context.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: launcherName }),
    ).toBeVisible();
    await page.getByRole("button", { name: launcherName }).click();
    await page.getByRole("button", { name: "阅读偏好", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "开启双语阅读" }),
    ).not.toBeChecked();
    await expect(page.locator("[data-lingo-sofa=translation]")).toHaveCount(0);
    expect(model.requests).toHaveLength(calls);
  } finally {
    await context?.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
