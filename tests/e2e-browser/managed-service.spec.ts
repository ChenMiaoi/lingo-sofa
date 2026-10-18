import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  copyFile,
  cp,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  RuntimeClient,
  runtimePost,
  type RuntimeConnection,
} from "@lingo-sofa/local-runtime";
import { BROWSER_EXTENSION_ID } from "@lingo-sofa/protocol";
import { bridgeConfigSchema } from "../../apps/pi-bridge/src/config.js";
import { registerNativeFixture } from "./native-host-fixture.js";

const execute = promisify(execFile);
const binaryName = `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`;
const binary = resolve("apps/pi-bridge/dist", binaryName);
test.skip(!existsSync(binary), "Requires the packaged native host");
type ExtensionApi = typeof import("wxt/browser").browser;

async function stopPrivateRuntime(home: string) {
  let running: RuntimeConnection & { pid: number };
  try {
    running = JSON.parse(
      await readFile(join(home, "runtime-connection.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await runtimePost(
    running,
    "https://discord.com",
    "/v1/runtime/prepare-update",
    {},
  ).catch(() => undefined);
  try {
    await expect
      .poll(async () => existsSync(join(home, "runtime-connection.json")), {
        timeout: 5_000,
      })
      .toBe(false);
  } catch {
    try {
      process.kill(running.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
}

test("auto-starts shared service from MV3 and keeps Discord connected after browser releases its lease", async () => {
  test.setTimeout(180_000);
  const cache = resolve(".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "lingo-managed-browser-"));
  const home = join(directory, "home");
  const profile = join(directory, "profile");
  const extension = join(directory, "extension");
  const name = `com.lingosofa.test_${randomUUID().replaceAll("-", "")}`;
  const desktop = new RuntimeClient(home, "https://discord.com");
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let unregister: (() => Promise<void>) | undefined;
  const closing: Promise<void>[] = [];
  const closeBrowser = () => {
    if (!context) return;
    const previous = context;
    context = undefined;
    const closed = previous.close();
    closing.push(closed);
    void closed.catch(() => undefined);
  };
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      env: { ...process.env, LINGO_SOFA_HOME: home, LINGO_SOFA_API_KEY: "" },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
  try {
    await mkdir(home);
    await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(join(extension, "manifest.json"), "utf8"),
    );
    const background = join(extension, manifest.background.service_worker);
    const source = await readFile(background, "utf8");
    if (!source.includes("com.lingosofa.bridge"))
      throw Error("Native fixture target is missing");
    await writeFile(
      background,
      source.replaceAll("com.lingosofa.bridge", name),
    );
    const socket = createServer();
    await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((done) => socket.close(() => done()));
    await writeFile(
      join(home, "config.json"),
      JSON.stringify(
        bridgeConfigSchema.parse({
          port,
          allowedExtensions: [BROWSER_EXTENSION_ID],
          settings: { persistUsage: true },
        }),
      ),
    );
    await test.step("install the private runtime without changing production registration", async () => {
      await execute(
        process.execPath,
        ["install-runtime.mjs", BROWSER_EXTENSION_ID],
        {
          cwd: resolve("apps/pi-bridge"),
          env: { ...process.env, LINGO_SOFA_HOME: home },
          timeout: 120_000,
          windowsHide: true,
        },
      );
    });
    const localBinary = join(home, binaryName);
    await copyFile(binary, localBinary);
    unregister = await registerNativeFixture(profile, {
      name,
      description: "Isolated LingoSofa test",
      path: localBinary,
      type: "stdio",
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    });
    context = await launch();
    const options = await context.newPage();
    await options.goto(
      `chrome-extension://${BROWSER_EXTENSION_ID}/options.html#connection`,
    );
    await expect(options.locator(".ls-active-connection")).toHaveText(
      "免 Key 翻译可独立使用；大模型需要共享助手",
    );
    await expect(
      options.getByText("本地助手已连接", { exact: true }),
    ).toBeVisible({ timeout: 75_000 });
    await options
      .getByRole("button", { name: "使用共享账户", exact: true })
      .click({ timeout: 75_000 });
    await expect(options.locator(".ls-active-connection")).toHaveText(
      "当前使用：共享本地助手",
    );
    await test.step("migrate a browser account through the real packaged native host", async () => {
      await options.evaluate(async () => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        const catalog = await api.runtime.sendMessage({
          action: "provider-catalog",
        });
        const id = crypto.randomUUID();
        const model = { ...catalog.model, accountId: id };
        await api.storage.local.set({
          providerAccounts: {
            accounts: [
              {
                id,
                name: "Native migration fixture",
                model,
                apiKey: "native-migration-fixture-key",
              },
            ],
            translation: model,
            ask: model,
            translationEngine: "bing",
          },
        });
      });
      await options.reload();
      await options
        .getByRole("button", { name: "迁移浏览器账户并共用" })
        .click();
      await expect(
        options.getByRole("region", { name: "浏览器账户迁移" }),
      ).toContainText("现已共用");
      const migrated = await options.evaluate(async () => {
        const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
          .chrome;
        return {
          catalog: await api.runtime.sendMessage({
            action: "provider-catalog",
          }),
          local: await api.storage.local.get("providerAccounts"),
        };
      });
      expect(migrated.catalog.keyConfigured).toBe(true);
      expect(migrated.catalog.accounts).toHaveLength(1);
      expect(migrated.local).toEqual({});
      expect(JSON.stringify(migrated)).not.toContain(
        "native-migration-fixture-key",
      );
    });
    const state = await options.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({ action: "state" }),
    );
    expect(state.bridgeError).toBeUndefined();
    const connection = await desktop.start();
    const running = JSON.parse(
      await readFile(join(home, "runtime-connection.json"), "utf8"),
    );
    expect(connection.instanceId).toBe(running.instanceId);
    const status = async () =>
      (
        await runtimePost(
          connection,
          "https://discord.com",
          "/v1/runtime/status",
          {},
        )
      ).json();
    await expect.poll(async () => (await status()).clients).toBe(2);
    const provider = await runtimePost(
      connection,
      "https://discord.com",
      "/v1/provider",
      {},
    );
    expect(await provider.json()).toMatchObject({
      translationEngine: "bing",
      keyConfigured: true,
    });
    await options.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.local.set({ readingEnabled: false }),
    );
    // Playwright may wait for the detached Windows service when closing its browser process tree.
    // Observe the released browser lease now, then await process cleanup after stopping the service.
    closeBrowser();
    await expect.poll(async () => (await status()).clients).toBe(1);
    context = await launch();
    // No extension UI is opened: startup must restore the shared connection even with reading disabled.
    await expect
      .poll(async () => (await status()).clients, { timeout: 30_000 })
      .toBe(2);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(
      await worker.evaluate(() =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.runtime.onStartup.hasListeners(),
      ),
    ).toBe(true);
    const reopened = await context.newPage();
    await reopened.goto(
      `chrome-extension://${BROWSER_EXTENSION_ID}/options.html#connection`,
    );
    await expect(reopened.locator(".ls-active-connection")).toHaveText(
      "当前使用：共享本地助手",
    );
    const restored = await reopened.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.local.get("readingEnabled"),
    );
    expect(restored.readingEnabled).toBe(false);
    await reopened.evaluate(async () => {
      const reply = await (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({
        action: "save",
        patch: { mode: "direct" },
      });
      if (!reply.ok) throw Error(reply.error);
    });
    await expect.poll(async () => (await status()).clients).toBe(1);
    expect(
      (await runtimePost(connection, "https://discord.com", "/v1/provider", {}))
        .status,
    ).toBe(200);
  } finally {
    closeBrowser();
    await desktop.stop();
    try {
      await stopPrivateRuntime(home);
    } finally {
      await Promise.all(closing).finally(async () => {
        await unregister?.();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
    }
  }
});
