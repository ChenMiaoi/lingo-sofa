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
  const model = await modelServer();
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
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(
      options.getByRole("heading", { name: "LingoSofa", exact: true }),
    ).toBeVisible();
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
    await expect(page.locator("p code")).toHaveText("fetch()");
    expect(await page.locator("[hidden]").textContent()).toBe("secret");
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
        usage: { usage: { totalTokens: number } }[];
        hasKey: boolean;
      };
    });
    expect(usage.hasKey).toBe(true);
    expect(usage.usage).toHaveLength(2);
    expect(usage.usage[0]!.usage.totalTokens).toBe(44);
    const interruptedId = crypto.randomUUID();
    await options.evaluate(async (requestId) => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const saved = (await api.runtime.sendMessage({ action: "state" })) as {
        usage: Record<string, unknown>[];
      };
      await api.storage.session.set({
        inFlight: [
          {
            ...saved.usage[0],
            requestId,
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
    const restored = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({ action: "state" })) as {
        usage: { requestId: string; status: string }[];
        hasKey: boolean;
      };
    });
    expect(restored.hasKey).toBe(true);
    expect(restored.usage).toHaveLength(3);
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
            await api.storage.session.get("apiKey");
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
    await expect(page.locator("[data-lingo-sofa]")).toHaveCount(0);
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
    await page.reload();
    await expect(page.locator("[data-lingo-sofa='translation']")).toHaveCount(
      2,
    );
    expect(model.requests).toHaveLength(beforeReload + 1);

    const changed = await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: { model: Record<string, unknown> };
        usage: unknown[];
      };
      await api.runtime.sendMessage({
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
      return (await api.runtime.sendMessage({ action: "state" })) as {
        hasKey: boolean;
        usage: unknown[];
      };
    });
    expect(changed.hasKey).toBe(false);
    await expect(page.locator("[data-lingo-sofa]")).toHaveCount(0);
    expect(changed.usage).toHaveLength(5);
    expect(
      await options.evaluate(
        () =>
          (globalThis as typeof globalThis & { cspViolations: string[] })
            .cspViolations,
      ),
    ).toEqual([]);
    await options.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      const state = (await api.runtime.sendMessage({ action: "state" })) as {
        settings: Record<string, unknown>;
      };
      await api.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, mode: "bridge" },
      });
    });
    await options.reload();
    await expect(options.getByRole("alert")).toContainText(
      "Bridge 用量暂不可用",
    );
    await expect(options.locator(".stats")).toContainText("Input 未知");
    await expect(options.locator(".stats")).toContainText("Output 未知");
  } finally {
    await context.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
