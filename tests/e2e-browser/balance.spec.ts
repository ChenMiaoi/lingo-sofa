import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
type ExtensionApi = typeof import("wxt/browser").browser;

test("caches account queries and preserves the last displayed balance after refresh failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-balance-"));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  ) as { host_permissions?: string[] };
  // Only the temporary copy has required permission; the worker's fetch is replaced with a fixture below.
  manifest.host_permissions = ["https://api.deepseek.com/*"];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
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
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    await worker.evaluate(async () => {
      const fixture = globalThis as typeof globalThis & {
        chrome: ExtensionApi;
        balanceFetchCount: number;
        balanceFails: boolean;
      };
      await fixture.chrome.storage.session.set({
        apiKey: "fixture-account-key",
      });
      fixture.balanceFetchCount = 0;
      fixture.balanceFails = false;
      globalThis.fetch = async (input) => {
        if (String(input) !== "https://api.deepseek.com/user/balance")
          throw new Error("Unexpected fixture network request");
        fixture.balanceFetchCount++;
        return new Response(
          JSON.stringify(
            fixture.balanceFails
              ? { error: "fixture-private-provider-detail" }
              : {
                  balance_infos: [{ currency: "CNY", total_balance: "10.00" }],
                },
          ),
          {
            status: fixture.balanceFails ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      };
    });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    const balance = options.locator("p").filter({ hasText: "供应商余额：" });
    await expect(balance).toContainText("10.00 CNY");
    await expect(balance).toContainText("DeepSeek 官方");
    const displayed = await balance.innerText();
    const first = await worker.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.session.get("balance"),
    );
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { balanceFetchCount: number })
            .balanceFetchCount,
      ),
    ).toBe(1);
    const previous = await worker.evaluate(async () => {
      const fixture = globalThis as typeof globalThis & {
        chrome: ExtensionApi;
        balanceFails: boolean;
      };
      const stored = await fixture.chrome.storage.session.get("balance");
      const balance = stored.balance as { data: unknown; updatedAt: number };
      balance.updatedAt = Date.now() - 31_000;
      await fixture.chrome.storage.session.set({ balance });
      fixture.balanceFails = true;
      return balance;
    });
    await options
      .getByRole("button", { name: "查询余额", exact: true })
      .click();
    await expect(options.getByRole("alert")).toContainText("余额查询失败");
    await expect(balance).toHaveText(displayed);
    const retained = await worker.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.storage.session.get("balance"),
    );
    expect(retained.balance).toEqual(previous);
    expect((retained.balance as { data: unknown }).data).toEqual(
      (first.balance as { data: unknown }).data,
    );
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { balanceFetchCount: number })
            .balanceFetchCount,
      ),
    ).toBe(2);
    await expect(options.locator("body")).not.toContainText(
      "fixture-private-provider-detail",
    );
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
