import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
type ExtensionApi = typeof import("wxt/browser").browser;

test("queries balance with the shared account and preserves the last display when refresh fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-shared-balance-ui-"));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  await prepareTestExtension(extension);
  const context = await chromium.launchPersistentContext(
    join(directory, "profile"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  const original = globalThis.fetch;
  const clock = Date.now;
  let offset = 0,
    calls = 0,
    fail = false;
  Date.now = () => clock() + offset;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.deepseek.com/user/balance")
      return original(input, init);
    expect(request.headers.get("authorization")).toBe(
      "Bearer fixture-account-key",
    );
    calls++;
    return new Response(
      JSON.stringify(
        fail
          ? { error: "private-fixture-provider-detail" }
          : {
              is_available: true,
              balance_infos: [{ currency: "CNY", total_balance: "10.00" }],
            },
      ),
      { status: fail ? 500 : 200 },
    );
  };
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await connectTestAssistant(worker, context);
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      const saved = await api.runtime.sendMessage({
        action: "save",
        settings: state.settings,
        apiKey: "fixture-account-key",
      });
      if (!saved.ok) throw Error(saved.error);
    });
    await options.reload();
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    const balance = options.locator("p").filter({ hasText: "供应商余额：" });
    await expect(balance).toContainText("10.00 CNY");
    await expect(balance).toContainText("DeepSeek 官方");
    const displayed = await balance.innerText();
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    await expect(
      options.getByRole("button", { name: "查询余额", exact: true }),
    ).toBeEnabled();
    expect(calls).toBe(1);
    offset += 31_000;
    fail = true;
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    await expect(options.getByRole("alert")).toContainText("余额查询失败");
    await expect(balance).toHaveText(displayed);
    await expect(options.getByRole("alert")).not.toContainText(
      "private-fixture",
    );
    expect(calls).toBe(2);
    expect(
      await worker.evaluate(async () =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.storage.local.get("providerAccounts"),
      ),
    ).toEqual({});
  } finally {
    globalThis.fetch = original;
    Date.now = clock;
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
