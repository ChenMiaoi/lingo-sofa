import {
  connectTestAssistant,
  prepareTestExtension,
} from "./shared-assistant-fixture.js";
import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelServer } from "../fixtures/model-server.js";
type ExtensionApi = typeof import("wxt/browser").browser;
test("loads MV3, translates through Pi, restores DOM and keeps secrets out of content scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-sofa-e2e-"));
  const model = await modelServer({ echoMetadata: true });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<article><p>Hello <code>fetch()</code></p><table><tbody><tr><td>World</td></tr></tbody></table><p hidden>secret</p></article>",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  await prepareTestExtension(extension);
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  ) as { host_permissions?: string[] };
  // Grant only the local fixture origin in this temporary test copy. The release manifest keeps all hosts optional.
  manifest.host_permissions = ["http://127.0.0.1/*"];
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
    await context.addInitScript(() => {
      const violations: string[] = [];
      (
        globalThis as typeof globalThis & { cspViolations: string[] }
      ).cspViolations = violations;
      addEventListener("securitypolicyviolation", (event) => {
        violations.push(event.violatedDirective);
      });
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const assistant = await connectTestAssistant(worker, context);
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html?view=activity`);
    await expect(
      options.getByRole("heading", { name: "用量与费用", exact: true }),
    ).toBeVisible();
    const icons = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const manifest = api.runtime.getManifest();
      return Promise.all(
        Object.entries(manifest.icons ?? {}).map(async ([size, path]) => {
          const image = new Image();
          image.src = new URL(path, location.href).href;
          await image.decode();
          return {
            size: Number(size),
            width: image.naturalWidth,
            height: image.naturalHeight,
            toolbar: manifest.action?.default_icon?.[Number(size)] === path,
          };
        }),
      );
    });
    expect(icons).toEqual(
      [16, 32, 48, 128].map((size) => ({
        size,
        width: size,
        height: size,
        toolbar: true,
      })),
    );
    await options.evaluate(async (endpoint) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const data = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: Record<string, unknown>;
      };
      const reply = (await api.runtime.sendMessage({
        action: "save",
        settings: {
          ...data.settings,
          mode: "direct",
          model: {
            provider: "openai-compatible",
            model: "fixture",
            endpoint,
            maxOutputTokens: 2048,
            timeoutMs: 30000,
            prices: null,
          },
        },
        apiKey: "fixture-key",
      })) as { ok: boolean; error?: string };
      if (!reply.ok) throw new Error(reply.error);
    }, model.endpoint);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
    await expect(
      page.getByRole("button", {
        name: "LingoSofa 页面控制，可拖动或用方向键移动",
        exact: true,
      }),
    ).toBeVisible();
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tabs = await api.tabs.query({});
      const tab = tabs.find((tab) => tab.url?.startsWith("http://127.0.0.1"));
      await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        files: ["content-scripts/content.js"],
      });
      await api.tabs.sendMessage(tab!.id!, {
        action: "page",
        targetLanguage: "简体中文",
      });
    });
    await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
      2,
    );
    await expect(page.locator("p > code")).toHaveText("fetch()");
    await expect(
      page.locator("p [data-lingo-sofa=translation] code"),
    ).toHaveText("fetch()");
    expect(await page.locator("article [hidden]").textContent()).toBe("secret");
    const requestCount = model.requests.length;
    await page.evaluate(() => {
      document.querySelector("p")!.firstChild!.textContent = "Edited ";
    });
    await expect(page.locator("p [data-lingo-sofa]")).toContainText("Edited");
    expect(model.requests.length).toBe(requestCount + 1);
    const usage = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({ action: "state" })) as {
        bridgeUsage: { usage: { totalTokens: number } }[];
      };
    });
    expect(usage.bridgeUsage).toHaveLength(2);
    expect(usage.bridgeUsage[0]!.usage.totalTokens).toBe(44);
    const migrations = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const results = [];
      for (const persistUsage of [true, false]) {
        const current = await api.runtime.sendMessage({
          action: "state",
          localOnly: true,
        });
        const saved = await api.runtime.sendMessage({
          action: "save",
          settings: { ...current.settings, persistUsage },
        });
        const state = await api.runtime.sendMessage({
          action: "state",
        });
        const persistent = (await api.storage.local.get("usage")).usage;
        const session = (await api.storage.session.get("usage")).usage;
        results.push({
          ok: saved.ok,
          records: state.bridgeUsage.length,
          persistent: Array.isArray(persistent) ? persistent.length : 0,
          session: Array.isArray(session) ? session.length : 0,
        });
      }
      return results;
    });
    expect(migrations).toEqual([
      { ok: true, records: 2, persistent: 0, session: 0 },
      { ok: true, records: 2, persistent: 0, session: 0 },
    ]);
    const interruptedId = crypto.randomUUID();
    await options.evaluate(async (requestId) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const saved = (await api.runtime.sendMessage({ action: "state" })) as {
        bridgeUsage: Record<string, unknown>[];
      };
      await api.storage.session.set({
        inFlight: [
          {
            ...saved.bridgeUsage[0],
            requestId,
            mode: "direct",
            status: "unknown",
            usage: null,
            costKnown: false,
          },
        ],
      });
    }, interruptedId);
    const beforeRestart = model.requests.length;
    const devtools = await context.newCDPSession(options);
    await devtools.send("ServiceWorker.enable");
    await devtools.send("ServiceWorker.stopAllWorkers");
    let restored = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({ action: "state" })) as {
        usage: { requestId: string; status: string }[];
        bridgeUsage: unknown[];
      };
    });
    const replacement = context
      .serviceWorkers()
      .find((candidate) => candidate.url().includes(id))!;
    await assistant.attach(replacement, true);
    await expect
      .poll(async () => {
        restored = await options.evaluate(async () =>
          (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome.runtime.sendMessage({ action: "state" }),
        );
        return restored.bridgeUsage.length;
      })
      .toBe(2);
    expect(restored.bridgeUsage).toHaveLength(2);
    expect(restored.usage).toHaveLength(1);
    expect(
      restored.usage.find((record) => record.requestId === interruptedId)
        ?.status,
    ).toBe("unknown");
    expect(model.requests.length).toBe(beforeRestart);
    const restartedWorker = context
      .serviceWorkers()
      .find((candidate) => candidate.url().includes(id))!;
    const data = await restartedWorker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const tabs = await api.tabs.query({});
      const tab = tabs.find((tab) => tab.url?.startsWith("http://127.0.0.1"));
      const result = await api.scripting.executeScript({
        target: { tabId: tab!.id! },
        func: async () => {
          const api = (
            globalThis as typeof globalThis & { chrome: ExtensionApi }
          ).chrome;
          const state = (await api.runtime.sendMessage({
            action: "state",
          })) as { ok: boolean };
          let storageAccessible = false;
          try {
            await api.storage.local.get("providerAccounts");
            storageAccessible = true;
          } catch {
            /* Expected: trusted contexts only. */
          }
          return { state, storageAccessible };
        },
      });
      await api.tabs.sendMessage(tab!.id!, { action: "stop" });
      return result[0]!.result;
    });
    expect(data).toMatchObject({
      state: { ok: false },
      storageAccessible: false,
    });
    await expect(
      page.locator(
        "[data-lingo-sofa=translation],[data-lingo-sofa=error],[data-lingo-sofa=selection]",
      ),
    ).toHaveCount(0);
    await expect(page.locator("p").first()).toHaveText("Edited fetch()");
    const qa = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const preview = (await api.runtime.sendMessage({
        action: "page",
        command: "context",
      })) as { text: string };
      const tabs = await api.tabs.query({});
      const tab = tabs.find((tab) => tab.url?.startsWith("http://127.0.0.1"))!;
      const request = {
        kind: "ask",
        requestId: crypto.randomUUID(),
        sessionId: "preview-session",
        context: preview.text,
        question: "Explain",
      };
      const reply = await api.runtime.sendMessage({
        action: "ask",
        tabId: tab.id,
        request,
      });
      return { reply, tabId: tab.id, request };
    });
    expect(qa.reply).toMatchObject({ ok: true, text: "这是模拟回答。" });
    const beforeReload = model.requests.length;
    await page.reload();
    const stale = await options.evaluate(async (qa) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return await api.runtime.sendMessage({
        action: "ask",
        tabId: qa.tabId,
        request: { ...qa.request, requestId: crypto.randomUUID() },
      });
    }, qa);
    expect(stale).toMatchObject({ ok: false });
    expect(model.requests.length).toBe(beforeReload);
    await options.evaluate(async (origin) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: Record<string, unknown>;
      };
      const saved = await api.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, autoOrigins: [origin] },
      });
      if (saved.ok === false) throw new Error(saved.error);
    }, new URL(page.url()).origin);
    // The default launcher is already present: enabling automatic mode processes this document.
    await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
      2,
    );
    expect(model.requests).toHaveLength(beforeReload);
    await page.reload();
    await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
      2,
    );
    expect(model.requests).toHaveLength(beforeReload);
    await expect(page.locator(".lingo-sofa-inline-usage")).toHaveCount(0);
    await expect(
      page.locator("[data-lingo-sofa=translation]").first(),
    ).toHaveAttribute("title", /缓存命中/);

    const changed = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: { model: Record<string, unknown> };
        usage: unknown[];
      };
      const rejected = await api.runtime.sendMessage({
        action: "save",
        settings: {
          ...state.settings,
          autoOrigins: [],
          model: {
            ...state.settings.model,
            endpoint: "https://api.deepseek.com",
          },
        },
      });
      await api.runtime.sendMessage({
        action: "save",
        patch: { autoOrigins: [] },
      });
      await api.runtime.sendMessage({ action: "page-enabled", enabled: false });
      return {
        rejected,
        catalog: await api.runtime.sendMessage({ action: "provider-catalog" }),
        state: await api.runtime.sendMessage({ action: "state" }),
      };
    });
    expect(changed.rejected.ok).toBe(false);
    expect(changed.catalog.keyConfigured).toBe(true);
    expect(changed.catalog.model.endpoint).toBe(model.endpoint);
    await expect(page.locator("[data-lingo-sofa=controls]")).toHaveCount(1);
    await expect(
      page.locator(
        "[data-lingo-sofa=translation],[data-lingo-sofa=error],[data-lingo-sofa=selection]",
      ),
    ).toHaveCount(0);
    expect(changed.state.bridgeUsage).toHaveLength(3);
    expect(
      await options.evaluate(
        () =>
          (globalThis as typeof globalThis & { cspViolations: string[] })
            .cspViolations,
      ),
    ).toEqual([]);
    const credentialCache = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: Record<string, unknown>;
      };
      await api.storage.session.set({
        balance: { data: { balance_infos: [] }, updatedAt: Date.now() },
      });
      await api.runtime.sendMessage({
        action: "save",
        settings: state.settings,
        apiKey: "replacement-fixture-key",
      });
      const afterRotation = await api.storage.session.get("balance");
      await api.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, mode: "bridge" },
      });
      return afterRotation;
    });
    expect(credentialCache).toEqual({});
    await options.reload();
    await expect(options.locator(".ls-activity-heading")).toContainText(
      "全部客户端",
    );
    expect(
      await options.evaluate(async () =>
        (
          globalThis as typeof globalThis & { chrome: ExtensionApi }
        ).chrome.storage.local.get("providerAccounts"),
      ),
    ).toEqual({});
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
