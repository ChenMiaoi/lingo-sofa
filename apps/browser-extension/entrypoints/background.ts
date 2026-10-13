import { defineBackground } from "wxt/utils/define-background";
import { browser, type Browser } from "wxt/browser";
import { createPiClient, resolveModel } from "@lingo-sofa/provider-pi/browser";
import {
  requestSchema,
  settingsSchema,
  type UsageRecord,
  type Request,
  type Reply,
} from "@lingo-sofa/protocol";
import { TranslationService } from "@lingo-sofa/translation-core";
import { readSettings, apiKey, records } from "../src/storage.js";

export default defineBackground(() => {
  const inFlight = new Map<string, UsageRecord>();
  const service = new TranslationService({
    pricing: (settings) => {
      const resolved = resolveModel(settings.model);
      return resolved.costKnown ? resolved.model.cost : null;
    },
    onFinish: async (id) => {
      inFlight.delete(id);
      await browser.storage.session.set({ inFlight: [...inFlight.values()] });
    },
    client: async (settings, onMetrics) => {
      const key = await apiKey();
      if (!key) throw new Error("请在设置中填写本次浏览器会话使用的 API Key");
      const url = new URL(settings.model.endpoint);
      const pattern = `${url.origin}/*`;
      if (!(await browser.permissions.contains({ origins: [pattern] })))
        throw new Error("缺少模型端点访问权限，请在设置中授权");
      return createPiClient(settings.model, key, undefined, onMetrics);
    },
    onBegin: async (record) => {
      inFlight.set(record.requestId, record);
      await browser.storage.session.set({ inFlight: [...inFlight.values()] });
    },
    onRecords: async (usage) => {
      for (const record of usage) inFlight.delete(record.requestId);
      const settings = await readSettings();
      service.ledger.prune(Date.now(), settings.retentionDays);
      await (
        settings.persistUsage ? browser.storage.local : browser.storage.session
      ).set({ usage: service.ledger.list() });
      await browser.storage.session.set({ inFlight: [...inFlight.values()] });
    },
  });
  const ready = (async () => {
    await browser.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await browser.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    const settings = await readSettings();
    const saved = await records(settings);
    const pending = await browser.storage.session.get("inFlight");
    service.ledger.restore([
      ...saved,
      ...(Array.isArray(pending.inFlight)
        ? (pending.inFlight as UsageRecord[])
        : []),
    ]);
    inFlight.clear();
    service.ledger.prune(Date.now(), settings.retentionDays);
    await browser.storage.session.set({ inFlight: [] });
  })();
  const trustedUI = (sender: Browser.runtime.MessageSender) =>
    sender.id === browser.runtime.id &&
    sender.url?.startsWith(browser.runtime.getURL(""));
  async function bridge(request: Request, scope: string): Promise<Reply> {
    const response: unknown = await browser.runtime.sendNativeMessage(
      "com.lingosofa.bridge",
      { version: 1, scope, sourceKind: "web", request },
    );
    return response as Reply;
  }
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    return (async (): Promise<unknown> => {
      await ready;
      if (!message || typeof message !== "object")
        throw new Error("Invalid message");
      const settings = await readSettings();
      if ("kind" in message) {
        const request = requestSchema.parse(message);
        if (!sender.tab || sender.frameId !== 0 || !sender.url)
          throw new Error(
            "Requests must originate from an authorized top-level page",
          );
        const url = new URL(sender.url);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Unsupported page");
        const scope = `web:${sender.tab.id}:${url.origin}:${sender.documentId ?? url.pathname}`;
        if (request.kind === "translate") {
          for (const unit of request.units) {
            unit.sourceKind = "web";
            unit.targetLanguage = settings.targetLanguage;
          }
        }
        return settings.mode === "bridge"
          ? bridge(request, scope)
          : service.handle(request, scope, settings, "web");
      }
      if (!("action" in message)) throw new Error("Invalid action");
      const data = message as {
        action: string;
        settings?: unknown;
        apiKey?: unknown;
        command?: string;
        tabId?: number;
        request?: unknown;
        context?: string;
      };
      if (data.action === "auto-state" && sender.tab && sender.url)
        return {
          enabled: settings.autoOrigins.includes(new URL(sender.url).origin),
          targetLanguage: settings.targetLanguage,
        };
      if (!trustedUI(sender))
        throw new Error(
          "Settings and account data are restricted to extension pages",
        );
      if (data.action === "state")
        return {
          settings,
          usage: service.ledger.list(),
          hasKey: Boolean(await apiKey()),
        };
      if (data.action === "save") {
        const next = settingsSchema.parse(data.settings);
        for (const origin of next.autoOrigins)
          if (
            !(await browser.permissions.contains({ origins: [`${origin}/*`] }))
          )
            throw new Error("自动翻译网站尚未授权");
        service.reset();
        if (!next.persistUsage || next.persistUsage !== settings.persistUsage) {
          service.ledger.clear();
          await browser.storage.local.remove("usage");
          await browser.storage.session.remove("usage");
        }
        await browser.storage.local.set({ settings: next });
        if (typeof data.apiKey === "string")
          await browser.storage.session.set({ apiKey: data.apiKey });
        const scripts = await browser.scripting.getRegisteredContentScripts();
        if (scripts.some((script) => script.id === "lingo-sofa-auto"))
          await browser.scripting.unregisterContentScripts({
            ids: ["lingo-sofa-auto"],
          });
        if (next.autoOrigins.length)
          await browser.scripting.registerContentScripts([
            {
              id: "lingo-sofa-auto",
              matches: next.autoOrigins.map((origin) => `${origin}/*`),
              js: ["content-scripts/content.js"],
              runAt: "document_idle",
            },
          ]);
        return { ok: true };
      }
      if (data.action === "clear") {
        service.reset();
        service.ledger.clear();
        await browser.storage.local.remove("usage");
        await browser.storage.session.remove(["usage", "inFlight"]);
        return { ok: true };
      }
      if (data.action === "forget-key") {
        service.reset();
        await browser.storage.session.remove("apiKey");
        return { ok: true };
      }
      if (data.action === "page") {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
          throw new Error("当前页面不支持翻译");
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/content-scripts/content.js"],
        });
        return browser.tabs.sendMessage(tab.id, {
          action: data.command,
          targetLanguage: settings.targetLanguage,
        });
      }
      if (
        data.action === "ask" ||
        data.action === "cancel" ||
        data.action === "clear-session"
      ) {
        if (!data.tabId) throw new Error("Missing page context");
        const tab = await browser.tabs.get(data.tabId);
        if (!tab.url) throw new Error("Page unavailable");
        const request = requestSchema.parse(data.request);
        const scope = `web-qa:${tab.id}:${new URL(tab.url).origin}`;
        return settings.mode === "bridge"
          ? bridge(request, scope)
          : service.handle(request, scope, settings, "web");
      }
      if (data.action === "balance") {
        if (
          settings.model.provider !== "deepseek" ||
          new URL(settings.model.endpoint).origin !== "https://api.deepseek.com"
        )
          return { unavailable: true };
        const key = await apiKey();
        if (!key) throw new Error("API Key 未配置");
        if (
          !(await browser.permissions.contains({
            origins: ["https://api.deepseek.com/*"],
          }))
        )
          throw new Error("模型端点未授权");
        const response = await fetch("https://api.deepseek.com/user/balance", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("余额查询失败");
        return {
          data: (await response.json()) as unknown,
          updatedAt: Date.now(),
        };
      }
      throw new Error("Unsupported action");
    })().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : "操作失败",
    }));
  });
});
