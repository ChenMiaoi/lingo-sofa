import {
  directAccounts,
  updateDirectAccounts,
  directKey,
} from "../src/accounts.js";
import { defineBackground } from "wxt/utils/define-background";
import { browser, type Browser } from "wxt/browser";
import {
  createPiClient,
  resolveModel,
  listModels,
} from "@lingo-sofa/provider-pi/browser";
import {
  providerCatalogSchema,
  accountMatches,
  oauthRequestSchema,
  oauthStatusSchema,
  providerUpdateSchema,
  replySchema,
  requestSchema,
  settingsSchema,
  usageRecordSchema,
  type UsageRecord,
  type Request,
  type Reply,
  type Settings,
  type BudgetSnapshot,
} from "@lingo-sofa/protocol";
import { TranslationService } from "@lingo-sofa/translation-core";
import { readSettings, records } from "../src/storage.js";

import { pageScope } from "../src/page-scope.js";
import { capabilities } from "@lingo-sofa/provider-pi";
import { syncReadingAccess, automaticPermission } from "../src/site-access.js";

import { NativeConnection } from "../src/native-connection.js";

export default defineBackground(() => {
  const native = new NativeConnection();
  browser.runtime.onInstalled.addListener((details) => {
    void syncReadingAccess().catch(() => undefined);
    if (details.reason === "install")
      void browser.tabs.create({
        url: browser.runtime.getURL("/options.html?setup=reading"),
      });
  });
  browser.permissions.onAdded.addListener(() => {
    void syncReadingAccess().catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener(() => {
    void (async () => {
      await cancelTransports((origin) =>
        browser.permissions.contains({ origins: [`${origin}/*`] }),
      );
      const settings = await readSettings();
      const autoOrigins: string[] = [];
      for (const origin of settings.autoOrigins)
        if (await browser.permissions.contains({ origins: [`${origin}/*`] }))
          autoOrigins.push(origin);
      await browser.storage.local.set({
        settings: { ...settings, autoOrigins },
      });
      await syncReadingAccess();
      for (const tab of await browser.tabs.query({})) {
        if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
        const authorized = await browser.permissions.contains({
          origins: [`${new URL(tab.url).origin}/*`],
        });
        if (!authorized)
          await browser.tabs
            .sendMessage(tab.id, { action: "disable" })
            .catch(() => undefined);
      }
    })().catch(() => undefined);
  });
  // Register synchronously so Chrome wakes this worker on profile startup,
  // even when no extension UI or authorized page is open.
  browser.runtime.onStartup.addListener(() => {
    void ready.catch(() => undefined);
  });
  browser.runtime.onSuspend.addListener(() => native.stop());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.uiTheme) {
      const value = changes.uiTheme.newValue;
      const uiTheme = value === "light" || value === "dark" ? value : "system";
      void browser.tabs
        .query({})
        .then((tabs) =>
          Promise.all(
            tabs
              .filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
              .map((tab) =>
                browser.tabs
                  .sendMessage(tab.id!, {
                    action: "appearance-changed",
                    uiTheme,
                  })
                  .catch(() => undefined),
              ),
          ),
        )
        .catch(() => undefined);
    }
    if (area !== "local" || !changes.settings) return;
    const settings = settingsSchema.safeParse(changes.settings.newValue ?? {});
    if (!settings.success) return;
    if (settings.data.mode === "bridge") native.start();
    else native.stop();
  });
  const inFlight = new Map<string, UsageRecord>();
  const service = new TranslationService({
    onFinish: async (id) => {
      inFlight.delete(id);
      await browser.storage.session.set({ inFlight: [...inFlight.values()] });
    },
    client: async (settings, onMetrics) => {
      const key = await directKey(settings, settings.model);
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
    await directAccounts(settings);
    if (settings.mode === "bridge") native.start();
    await syncReadingAccess();
    const saved = await records(settings);
    const pending = await browser.storage.session.get("inFlight");
    service.ledger.restore([
      ...saved,
      ...(Array.isArray(pending.inFlight)
        ? usageRecordSchema
            .array()
            .parse(pending.inFlight)
            .filter(
              (record) =>
                !saved.some((final) => final.requestId === record.requestId),
            )
        : []),
    ]);
    inFlight.clear();
    service.ledger.prune(Date.now(), settings.retentionDays);
    await (
      settings.persistUsage ? browser.storage.local : browser.storage.session
    ).set({ usage: service.ledger.list() });
    await browser.storage.session.set({ inFlight: [] });
  })();
  const trustedUI = (sender: Browser.runtime.MessageSender) =>
    sender.id === browser.runtime.id &&
    sender.url?.startsWith(browser.runtime.getURL(""));
  async function bridge(request: Request, scope: string): Promise<Reply> {
    const response: unknown = await native.request({
      version: 1,
      scope,
      sourceKind: "web",
      request,
    });
    return replySchema.parse(response);
  }
  const transports = new Map<
    string,
    { scope: string; mode: Settings["mode"]; origin: string }
  >();
  async function dispatch(
    request: Request,
    scope: string,
    settings: Settings,
    origin: string,
  ): Promise<Reply> {
    if (request.kind === "cancel") {
      const transport = transports.get(request.requestId);
      if (transport && transport.scope !== scope)
        throw new Error("Request belongs to a different page");
      return (transport?.mode ?? settings.mode) === "bridge"
        ? bridge(request, scope)
        : service.handle(request, scope, settings, "web");
    }
    if (request.kind === "ask" && settings.mode === "direct") {
      const state = await directAccounts(settings);
      request = { ...request, model: request.model ?? state.ask };
    }
    if (request.kind !== "translate" && request.kind !== "ask")
      return settings.mode === "bridge"
        ? bridge(request, scope)
        : service.handle(request, scope, settings, "web");
    if (
      (await browser.storage.local.get("readingEnabled")).readingEnabled ===
      false
    )
      throw new Error("双语阅读已关闭，请先在悬浮面板中开启");
    if (transports.has(request.requestId))
      throw new Error("Duplicate request ID");
    transports.set(request.requestId, { scope, mode: settings.mode, origin });
    try {
      return await (settings.mode === "bridge"
        ? bridge(request, scope)
        : service.handle(request, scope, settings, "web"));
    } finally {
      transports.delete(request.requestId);
    }
  }
  async function cancelTransports(
    stillAuthorized?: (origin: string) => Promise<boolean>,
  ): Promise<void> {
    await Promise.all(
      [...transports].map(async ([requestId, transport]) => {
        if (stillAuthorized && (await stillAuthorized(transport.origin)))
          return;
        if (transport.mode === "bridge")
          await bridge({ kind: "cancel", requestId }, transport.scope).catch(
            () => undefined,
          );
        else service.queue.cancel(`${transport.scope}|${requestId}`);
      }),
    );
  }
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const permission = automaticPermission(message, sender);
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
        const scope = await pageScope(sender.tab.id!, url, sender.documentId);
        if (
          request.kind === "translate" &&
          request.automatic &&
          !settings.autoOrigins.includes(url.origin)
        )
          throw new Error("此网站尚未启用自动翻译");
        if (request.kind === "usage" || request.kind === "clear-data")
          throw new Error("用量与清理仅供扩展界面使用");
        if (request.kind === "translate") {
          for (const unit of request.units) {
            unit.sourceKind = "web";
            unit.targetLanguage = settings.targetLanguage;
          }
        }
        return dispatch(request, scope, settings, url.origin);
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
        targetLanguage?: unknown;
        model?: unknown;
        enabled?: unknown;
        update?: unknown;
        mode?: unknown;
        oauth?: unknown;
      };
      async function catalog(mode = settings.mode) {
        if (mode === "bridge")
          return providerCatalogSchema.parse(
            await native.request({
              version: 1,
              sourceKind: "web",
              scope: "browser",
              operation: "provider",
            }),
          );
        const stored = await directAccounts(settings);
        const active =
          settings.mode === "direct" ? settings.model : stored.translation;
        const supported = ["deepseek", "openai-compatible"].includes(
          active.provider,
        );
        return {
          capabilities: capabilities(active),
          model: supported ? active : settingsSchema.parse({}).model,
          askModel: stored.ask,
          accounts: stored.accounts.map(({ id, name, model, apiKey }) => ({
            id,
            name,
            model,
            keyConfigured: Boolean(apiKey) || model.authMode === "subscription",
          })),
          keyConfigured:
            supported && Boolean(await directKey(settings, active)),
          piAuth: false,
          providers: listModels(),
        };
      }
      async function notify(next: Settings) {
        for (const tab of await browser.tabs.query({}))
          if (tab.id && tab.url && /^https?:/.test(tab.url))
            await browser.tabs
              .sendMessage(tab.id, {
                action: "settings-changed",
                targetLanguage: next.targetLanguage,
                automatic: next.autoOrigins.includes(new URL(tab.url).origin),
              })
              .catch(() => undefined);
      }
      const topPage =
        sender.tab &&
        sender.frameId === 0 &&
        sender.url &&
        /^https?:/.test(sender.url);
      if (
        data.action === "appearance" &&
        (topPage || sender.url?.startsWith(browser.runtime.getURL("/")))
      ) {
        const { uiTheme } = await browser.storage.local.get("uiTheme");
        return {
          uiTheme:
            uiTheme === "light" || uiTheme === "dark" ? uiTheme : "system",
        };
      }
      if (data.action === "ask-catalog" && topPage) {
        const info = await catalog();
        return info;
      }
      if (data.action === "page-controls" && topPage) {
        const info = await catalog();
        return {
          ok: true,
          maxOutputTokens:
            info.model.maxOutputTokens > 0
              ? Math.min(
                  info.model.maxOutputTokens,
                  info.capabilities?.maxOutputTokens ??
                    info.model.maxOutputTokens,
                )
              : info.capabilities?.maxOutputTokens,
          model: info.model.model,
          providerName:
            info.providers.find(
              (provider) => provider.id === info.model.provider,
            )?.name ??
            (info.model.provider === "openai-compatible"
              ? "OpenAI 兼容"
              : info.model.provider),
          models: info.providers
            .find((provider) => provider.id === info.model.provider)
            ?.models.map((model) => model.id) ?? [info.model.model],
          readingEnabled:
            (await browser.storage.local.get("readingEnabled"))
              .readingEnabled !== false,
          targetLanguage: settings.targetLanguage,
          automatic: settings.autoOrigins.includes(new URL(sender.url!).origin),
        };
      }
      if (data.action === "page-model" && topPage) {
        if (typeof data.model !== "string") throw new Error("Invalid model");
        const info = await catalog();
        if (
          !info.providers
            .find((provider) => provider.id === info.model.provider)
            ?.models.some((model) => model.id === data.model)
        )
          throw new Error("模型不在当前供应商目录中");
        const model = {
          ...info.model,
          model: data.model,
          thinkingLevel: undefined,
          capabilities: undefined,
          prices: null,
        };
        if (settings.mode === "bridge") {
          const reply = replySchema.parse(
            await native.request({
              version: 1,
              sourceKind: "web",
              scope: "browser",
              operation: "provider-update",
              update: { model },
            }),
          );
          if (!reply.ok) throw new Error(reply.error);
        }
        const next: Settings = { ...settings, model };
        if (settings.mode === "direct") {
          const state = await updateDirectAccounts(settings, { model }, true);
          next.model = state.translation;
          next.askModel = state.ask;
        }
        if (
          model.provider !== settings.model.provider ||
          model.endpoint !== settings.model.endpoint
        )
          await browser.storage.session.remove(["apiKey", "balance"]);
        await browser.storage.local.set({ settings: next });
        await notify(next);
        return { ok: true };
      }
      if (data.action === "page-enabled" && topPage) {
        if (typeof data.enabled !== "boolean")
          throw new Error("Invalid reading state");
        // Close the dispatch gate before cancelling paid work; retain usage records.
        await browser.storage.local.set({ readingEnabled: data.enabled });
        if (!data.enabled) await cancelTransports();
        for (const tab of await browser.tabs.query({})) {
          if (tab.id)
            await browser.tabs
              .sendMessage(tab.id, {
                action: "reading-changed",
                readingEnabled: data.enabled,
                automatic: Boolean(
                  tab.url &&
                  settings.autoOrigins.includes(new URL(tab.url).origin),
                ),
              })
              .catch(() => undefined);
        }
        return { ok: true };
      }
      if (data.action === "page-auto" && topPage) {
        if (typeof data.enabled !== "boolean")
          throw new Error("Invalid automatic state");
        const origin = new URL(sender.url!).origin;
        if (data.enabled && !(await permission))
          throw new Error("Chrome 未授予此网站访问权限，自动翻译尚未开启。");
        const current = await readSettings();
        const autoOrigins = data.enabled
          ? [...new Set([...current.autoOrigins, origin])]
          : current.autoOrigins.filter((value) => value !== origin);
        const next = settingsSchema.parse({ ...current, autoOrigins });
        await browser.storage.local.set({ settings: next });
        await syncReadingAccess();
        // Preserve completed inline translations while pausing the current page.
        for (const tab of await browser.tabs.query({}))
          if (tab.id && tab.url && new URL(tab.url).origin === origin)
            await browser.tabs
              .sendMessage(tab.id, {
                action: "automatic-changed",
                automatic: data.enabled,
              })
              .catch(() => undefined);
        return { ok: true };
      }
      if (data.action === "auto-state" && sender.tab && sender.url)
        return {
          readingEnabled:
            (await browser.storage.local.get("readingEnabled"))
              .readingEnabled !== false,
          enabled: settings.autoOrigins.includes(new URL(sender.url).origin),
          targetLanguage: settings.targetLanguage,
        };
      if (
        ["page-language", "open-options"].includes(data.action) &&
        sender.tab &&
        sender.frameId === 0 &&
        sender.url &&
        ["http:", "https:"].includes(new URL(sender.url).protocol)
      ) {
        if (data.action === "open-options")
          await browser.runtime.openOptionsPage();
        else {
          const targetLanguage = settingsSchema.shape.targetLanguage.parse(
            data.targetLanguage,
          );
          await browser.storage.local.set({
            settings: { ...settings, targetLanguage },
          });
          for (const tab of await browser.tabs.query({})) {
            if (
              !tab.id ||
              tab.id === sender.tab.id ||
              !tab.url ||
              !/^https?:/.test(tab.url)
            )
              continue;
            await browser.tabs
              .sendMessage(tab.id, {
                action: "settings-changed",
                targetLanguage,
                automatic: settings.autoOrigins.includes(
                  new URL(tab.url).origin,
                ),
              })
              .catch(() => undefined);
          }
        }
        return { ok: true };
      }
      if (!trustedUI(sender))
        throw new Error(
          "Settings and account data are restricted to extension pages",
        );
      if (data.action === "provider-oauth") {
        const request = oauthRequestSchema.parse(data.oauth);
        return oauthStatusSchema.parse(
          await native.request({
            version: 1,
            sourceKind: "web",
            scope: "browser",
            operation: "oauth",
            request,
          }),
        );
      }
      if (data.action === "provider-catalog")
        return catalog(
          data.mode === "bridge"
            ? "bridge"
            : data.mode === "direct"
              ? "direct"
              : settings.mode,
        );
      if (data.action === "provider-update") {
        const update = providerUpdateSchema.parse(data.update);
        if (data.mode !== "bridge" && update.model.authMode === "subscription")
          throw new Error("ChatGPT 订阅登录需要选择本地助手");
        if (data.mode === "bridge") {
          const reply = replySchema.parse(
            await native.request({
              version: 1,
              sourceKind: "web",
              scope: "browser",
              operation: "provider-update",
              update,
            }),
          );
          if (!reply.ok) throw new Error(reply.error);
          const next = { ...settings, mode: "bridge" as const };
          if (!update.target || update.target === "translation")
            next.model = update.model;
          if (update.target === "ask-default") next.askModel = update.model;
          if (
            update.model.provider !== settings.model.provider ||
            update.model.endpoint !== settings.model.endpoint
          )
            await browser.storage.session.remove(["apiKey", "balance"]);
          await browser.storage.local.set({ settings: next });
          await notify(next);
          return { ok: true };
        }
        resolveModel(update.model);
        const state = await updateDirectAccounts(settings, update);
        const next = {
          ...settings,
          mode: "direct" as const,
          model: state.translation,
          askModel: state.ask,
        };
        await browser.storage.local.set({ settings: next });
        await browser.storage.session.remove("balance");
        await notify(next);
        return { ok: true };
      }

      if (data.action === "reading-access-sync") {
        await syncReadingAccess();
        return { ok: true };
      }
      if (data.action === "state") {
        let bridgeUsage: UsageRecord[] = [];
        let budgets: BudgetSnapshot[] | undefined;
        let shareBudget = false;
        let sharedUsage = false;
        let executionSettings = settings;
        let cacheStats = service.cacheStats();
        let queue = {
          running: service.queue.runningCount,
          pending: service.queue.pendingCount,
        };
        let bridgeError: string | undefined;
        if (settings.mode === "bridge") {
          try {
            const result = await bridge({ kind: "usage" }, "browser");
            if (!result.ok) throw new Error(result.error);
            bridgeUsage = result.usage ?? [];
            sharedUsage = result.sharedUsage ?? false;
            budgets = result.budgets;
            shareBudget = result.shareBudget ?? false;
            executionSettings = result.settings ?? settings;
            queue = result.queue ?? { running: 0, pending: 0 };
            cacheStats = result.cacheStats ?? {
              hits: 0,
              lookups: 0,
              ratio: null,
            };
          } catch {
            bridgeError = "Bridge 用量暂不可用；不会显示为零消耗";
          }
        }
        return {
          settings,
          usage: service.ledger.list(),
          hasKey: Boolean(
            await directKey(settings, settings.model).catch(() => ""),
          ),
          bridgeUsage,
          budgets,
          shareBudget,
          executionSettings,
          cacheStats,
          sharedUsage,
          bridgeError,
          queue,
        };
      }
      if (data.action === "save") {
        const next = settingsSchema.parse(data.settings);
        for (const origin of next.autoOrigins)
          if (
            !(await browser.permissions.contains({ origins: [`${origin}/*`] }))
          )
            throw new Error("自动翻译网站尚未授权");
        if (
          next.mode !== settings.mode ||
          next.persistUsage !== settings.persistUsage
        ) {
          await cancelTransports();
          service.reset();
        }
        if (next.persistUsage !== settings.persistUsage) {
          service.ledger.clear();
          await browser.storage.local.remove("usage");
          await browser.storage.session.remove("usage");
        }
        if (next.mode === "direct") {
          if (next.model.authMode === "subscription")
            throw new Error("订阅登录需要本地助手");
          const existing = await directAccounts(settings);
          if (
            next.model.accountId &&
            !existing.accounts.some(
              (item) =>
                item.id === next.model.accountId &&
                accountMatches(item, next.model),
            )
          )
            next.model.accountId = undefined;
          const state = await updateDirectAccounts(
            settings,
            {
              model: next.model,
              ...(typeof data.apiKey === "string" && data.apiKey.trim()
                ? { apiKey: data.apiKey.trim() }
                : {}),
            },
            true,
          );
          next.model = state.translation;
          if (
            state.accounts.length === 1 &&
            !settings.askModel &&
            data.action === "save"
          ) {
            const initial = await updateDirectAccounts(next, {
              model: state.translation,
              target: "ask-default",
            });
            next.askModel = initial.ask;
          } else next.askModel = state.ask;
        }
        await browser.storage.local.set({ settings: next });
        if (next.mode === "bridge") native.start();
        else native.stop();
        if (
          next.model.provider !== settings.model.provider ||
          next.model.endpoint !== settings.model.endpoint
        )
          await browser.storage.session.remove(["apiKey", "balance"]);
        if (typeof data.apiKey === "string") {
          await browser.storage.session.remove("balance");
          await browser.storage.session.remove("apiKey");
        }
        await syncReadingAccess();
        await notify(next);
        return { ok: true };
      }
      if (data.action === "clear") {
        if (settings.mode === "bridge") {
          const result = await bridge({ kind: "clear-data" }, "browser");
          if (!result.ok) throw new Error(result.error);
        }
        await cancelTransports();
        service.reset();
        service.ledger.clear();
        await browser.storage.local.remove("usage");
        await browser.storage.session.remove(["usage", "inFlight"]);
        return { ok: true };
      }
      if (data.action === "forget-key") {
        const state = await directAccounts(settings);
        const id = settings.model.accountId;
        state.accounts = state.accounts.map((account) => {
          if (
            id
              ? account.id !== id
              : account.model.provider !== settings.model.provider ||
                account.model.endpoint !== settings.model.endpoint
          )
            return account;
          const { apiKey: _key, ...rest } = account;
          void _key;
          return rest;
        });
        await browser.storage.local.set({ providerAccounts: state });
        await cancelTransports();
        service.reset();
        await browser.storage.session.remove(["apiKey", "balance"]);
        return { ok: true };
      }
      if (data.action === "page") {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
          throw new Error("当前页面不支持翻译");
        // Reinjecting WXT creates a new context and invalidates its predecessor.
        // Keep the live reader and its selection when the current document already has one.
        const peer = (await browser.tabs
          .sendMessage(tab.id, { action: "context-token" })
          .catch(() => undefined)) as { documentToken?: unknown } | undefined;
        if (typeof peer?.documentToken !== "string")
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["/content-scripts/content.js"],
          });
        const result = await browser.tabs.sendMessage(tab.id, {
          action: data.command,
          targetLanguage: settings.targetLanguage,
        });
        if (
          data.command === "context" &&
          result &&
          typeof result.documentToken === "string"
        )
          await browser.storage.session.set({
            [`preview:${tab.id}`]: {
              url: tab.url,
              documentToken: result.documentToken,
              scope: `web-qa:${tab.id}:${new URL(tab.url).origin}:${result.documentToken}`,
            },
          });
        return result;
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
        if (request.kind !== data.action)
          throw new Error("操作与请求类型不匹配");
        const saved = await browser.storage.session.get(`preview:${tab.id}`);
        const preview = saved[`preview:${tab.id}`] as
          { url: string; documentToken: string; scope: string } | undefined;
        if (!preview) throw new Error("请先预览文章或选中内容");
        if (request.kind === "ask") {
          if (tab.url !== preview.url)
            throw new Error("页面已切换，请重新预览上下文");
          const current = (await browser.tabs.sendMessage(data.tabId, {
            action: "context-token",
          })) as { documentToken?: string };
          if (current.documentToken !== preview.documentToken)
            throw new Error("页面已刷新，请重新预览上下文");
        }
        const scope = preview.scope;
        return dispatch(request, scope, settings, new URL(tab.url).origin);
      }
      if (data.action === "balance") {
        if (settings.mode === "bridge") return { unavailable: true };
        if (
          settings.model.provider !== "deepseek" ||
          new URL(settings.model.endpoint).origin !== "https://api.deepseek.com"
        )
          return { unavailable: true };
        const key = await directKey(settings, settings.model);
        if (!key) throw new Error("API Key 未配置");
        if (
          !(await browser.permissions.contains({
            origins: ["https://api.deepseek.com/*"],
          }))
        )
          throw new Error("模型端点未授权");
        const previous = await browser.storage.session.get("balance");
        const cached = previous.balance as
          { data: unknown; updatedAt: number } | undefined;
        if (cached && Date.now() - cached.updatedAt < 30_000) return cached;
        const response = await fetch("https://api.deepseek.com/user/balance", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("余额查询失败");
        const balance = {
          data: (await response.json()) as unknown,
          updatedAt: Date.now(),
        };
        await browser.storage.session.set({ balance });
        return balance;
      }
      throw new Error("Unsupported action");
    })().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : "操作失败",
    }));
  });
});
