import { historyPage } from "../src/history-page.js";
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
  runtimeStatusSchema,
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
import {
  createWebTranslator,
  webTranslationOrigins,
} from "@lingo-sofa/provider-web";
import { readSettings, records } from "../src/storage.js";
import { UsageStorage } from "../src/usage-storage.js";
import { runDataCleanup } from "../src/data-cleanup.js";

import { pageScope, pageDocumentPrefix } from "../src/page-scope.js";
import { mergeAvailableUsage } from "../src/page-usage-data.js";
import {
  parseFloatingPatch,
  readFloatingPreferences,
} from "../src/floating-preferences.js";
import { capabilities } from "@lingo-sofa/provider-pi";
import { syncReadingAccess, automaticPermission } from "../src/site-access.js";

import { NativeConnection } from "../src/native-connection.js";
import {
  LocalTranslationCache,
  cachePreferences,
} from "../src/translation-cache.js";

export default defineBackground(() => {
  const native = new NativeConnection();
  const usageStorage = new UsageStorage(browser.storage, readSettings);
  const translationCache = new LocalTranslationCache({
    read: async () =>
      (await browser.storage.local.get("translationCache")).translationCache,
    write: async (entries) => {
      await browser.storage.local.set({ translationCache: entries });
    },
  });
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
    translator: (settings) =>
      createWebTranslator(
        settings.translationEngine === "google" ? "google" : "bing",
        async (url, init) => {
          const engine =
            settings.translationEngine === "google" ? "google" : "bing";
          if (
            !(await browser.permissions.contains({
              origins: [webTranslationOrigins[engine]],
            }))
          )
            throw new Error(
              "缺少翻译引擎访问权限，请在设置中重新选择并授权此引擎",
            );
          return fetch(url, init);
        },
      ),
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
      await usageStorage.write(() => service.ledger.list());
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
    const initialAccounts = await directAccounts(settings);
    if (
      settings.mode === "direct" &&
      settings.translationEngine !== initialAccounts.translationEngine
    )
      await browser.storage.local.set({
        settings: {
          ...settings,
          translationEngine: initialAccounts.translationEngine,
        },
      });
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
    await usageStorage.write(() => service.ledger.list());
    await browser.storage.session.set({ inFlight: [] });
  })();
  const trustedUI = (sender: Browser.runtime.MessageSender) =>
    sender.id === browser.runtime.id &&
    sender.url?.startsWith(browser.runtime.getURL(""));
  async function bridge(
    request: Request,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const response: unknown = await native.request(
      {
        version: 1,
        scope,
        sourceKind: "web",
        request,
      },
      signal,
    );
    return replySchema.parse(response);
  }
  async function allUsage(settings: Settings) {
    try {
      const result = await bridge({ kind: "usage" }, "browser:summary");
      if (!result.ok || !result.usageSummary)
        throw new Error("请更新本地助手，以读取全部客户端的用量汇总。");
      return mergeAvailableUsage(
        service.ledger.summary("direct"),
        settings.mode,
        result.usageSummary,
      );
    } catch (error) {
      if (settings.mode === "bridge") throw error;
      return mergeAvailableUsage(service.ledger.summary("direct"), "direct");
    }
  }
  const transports = new Map<
    string,
    {
      scope: string;
      mode: Settings["mode"];
      origin: string;
      controller: AbortController;
    }
  >();
  async function dispatch(
    request: Request,
    scope: string,
    settings: Settings,
    origin: string,
  ): Promise<Reply> {
    if (settings.mode === "direct") {
      const state = await directAccounts(settings);
      settings = {
        ...settings,
        translationEngine: state.translationEngine,
        model: state.translation,
        askModel: state.ask,
      };
    }
    if (request.kind === "cancel") {
      const transport = transports.get(request.requestId);
      if (transport && transport.scope !== scope)
        throw new Error("Request belongs to a different page");
      transport?.controller.abort();
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
    const controller = new AbortController();
    transports.set(request.requestId, {
      scope,
      mode: settings.mode,
      origin,
      controller,
    });
    try {
      if (request.kind === "ask")
        return await (settings.mode === "bridge"
          ? bridge(request, scope)
          : service.handle(request, scope, settings, "web"));
      const cacheVersion = translationCache.version;
      const preferences = cachePreferences(
        (await browser.storage.local.get("translationCachePreferences"))
          .translationCachePreferences,
      );
      let executionSettings = settings;
      if (settings.mode === "bridge" && preferences.enabled) {
        const state = await bridge({ kind: "usage" }, "browser:summary");
        if (!state.ok || !state.settings)
          throw new Error("无法读取本地助手模型配置");
        executionSettings = state.settings;
      }
      const lookup = await translationCache.lookup(
        request.units,
        `${settings.mode}|${origin}`,
        executionSettings,
        preferences,
        cacheVersion,
      );
      controller.signal.throwIfAborted();
      const missing = request.units.filter(
        (_unit, index) => lookup.texts[index] === undefined,
      );
      const result = missing.length
        ? await (settings.mode === "bridge"
            ? bridge({ ...request, units: missing }, scope, controller.signal)
            : service.handle(
                { ...request, units: missing },
                scope,
                settings,
                "web",
              ))
        : { ok: true as const, results: [] };
      if (!result.ok) return result;
      controller.signal.throwIfAborted();
      // Storage failures never discard a successful translation or replay a paid call.
      await translationCache
        .store(lookup, request.units, result.results ?? [], preferences)
        .catch(() => undefined);
      return {
        ...result,
        results: request.units.map((unit, index) =>
          lookup.texts[index] !== undefined
            ? {
                id: unit.id,
                revision: unit.revision,
                text: lookup.texts[index]!,
                billing: {
                  source: "cache" as const,
                  batchSize: 1,
                  tokens: 0,
                  cost: 0,
                },
              }
            : result.results!.find(
                (item) =>
                  item.id === unit.id && item.revision === unit.revision,
              )!,
        ),
      };
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
        transport.controller.abort();
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
        const url = new URL(
          (await browser.tabs.get(sender.tab.id!)).url ?? sender.url,
        );
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Unsupported page");
        let scope = await pageScope(sender.tab.id!, url, sender.documentId);
        if (request.kind === "cancel") {
          const transport = transports.get(request.requestId);
          // SPA navigation changes accounting scope, but cancellation still belongs
          // to the original request within this trusted tab and document.
          if (
            transport?.scope.startsWith(
              pageDocumentPrefix(sender.tab.id!, url, sender.documentId),
            )
          )
            scope = transport.scope;
        }
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
        preferences?: unknown;
        historyQuery?: unknown;
        targets?: unknown;
        section?: unknown;
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
          translationEngine: stored.translationEngine,
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
      async function notify(next: Settings, credentialsChanged = false) {
        // Page listeners restart translation; storage and reporting preferences must not do so.
        const readingFields = [
          "mode",
          "translationEngine",
          "model",
          "targetLanguage",
          "autoOrigins",
          "glossary",
        ] as const;
        if (
          !credentialsChanged &&
          readingFields.every(
            (key) =>
              JSON.stringify(settings[key]) === JSON.stringify(next[key]),
          )
        )
          return;
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
      if (data.action === "floating-preferences" && topPage) {
        const stored = await browser.storage.local.get("floatingDock");
        return {
          ok: true,
          preferences: readFloatingPreferences(stored.floatingDock),
        };
      }
      if (data.action === "floating-preferences-update" && topPage) {
        const patch = parseFloatingPatch(data.preferences);
        const stored = await browser.storage.local.get("floatingDock");
        await browser.storage.local.set({
          floatingDock: {
            ...readFloatingPreferences(stored.floatingDock),
            ...patch,
          },
        });
        return { ok: true };
      }
      if (data.action === "usage-summary" && (topPage || trustedUI(sender))) {
        return { ok: true, ...(await allUsage(settings)) };
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
          model:
            info.translationEngine && info.translationEngine !== "llm"
              ? `engine:${info.translationEngine}`
              : info.model.model,
          providerName:
            info.translationEngine && info.translationEngine !== "llm"
              ? "免 Key 翻译"
              : (info.providers.find(
                  (provider) => provider.id === info.model.provider,
                )?.name ??
                (info.model.provider === "openai-compatible"
                  ? "OpenAI 兼容"
                  : info.model.provider)),
          models: [
            "engine:bing",
            "engine:google",
            ...(info.providers
              .find((provider) => provider.id === info.model.provider)
              ?.models.map((model) => model.id) ?? [info.model.model]),
          ],
          readingEnabled:
            (await browser.storage.local.get("readingEnabled"))
              .readingEnabled !== false,
          targetLanguage: settings.targetLanguage,
          automatic: settings.autoOrigins.includes(new URL(sender.url!).origin),
        };
      }
      if (data.action === "page-model" && topPage) {
        if (typeof data.model !== "string") throw new Error("Invalid model");
        if (data.model === "engine:bing" || data.model === "engine:google") {
          const engine =
            data.model === "engine:google"
              ? ("google" as const)
              : ("bing" as const);
          if (settings.mode === "bridge") {
            const result = replySchema.parse(
              await native.request({
                version: 1,
                sourceKind: "web",
                scope: "browser",
                operation: "provider-update",
                update: { target: "translation-engine", engine },
              }),
            );
            if (!result.ok) throw new Error(result.error);
          } else {
            if (
              !(await browser.permissions.contains({
                origins: [webTranslationOrigins[engine]],
              }))
            )
              throw new Error("请先在翻译偏好中选择并授权此引擎");
            await updateDirectAccounts(settings, {
              target: "translation-engine",
              engine,
            });
          }
          const next = { ...settings, translationEngine: engine };
          await browser.storage.local.set({ settings: next });
          await notify(next);
          return { ok: true };
        }
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
        const next: Settings = { ...settings, model, translationEngine: "llm" };
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
        if (data.action === "open-options") {
          if (data.section === "usage")
            await browser.tabs.create({
              url: browser.runtime.getURL("/options.html#usage"),
            });
          else await browser.runtime.openOptionsPage();
        } else {
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
      if (data.action === "assistant-status") {
        try {
          const reply = await native.request({
            version: 1,
            sourceKind: "web",
            scope: "browser",
            operation: "runtime-status",
          });
          const runtime = runtimeStatusSchema.safeParse(reply);
          if (!runtime.success) await catalog("bridge");
          await browser.storage.local.set({ assistantInstalled: true });
          return {
            connected: true,
            installed: true,
            ...(runtime.success && runtime.data.appVersion
              ? { version: runtime.data.appVersion }
              : {}),
          };
        } catch {
          const saved = await browser.storage.local.get("assistantInstalled");
          return {
            connected: false,
            installed:
              saved.assistantInstalled === false
                ? false
                : saved.assistantInstalled === true || native.installed === true
                  ? true
                  : null,
          };
        }
      }
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
        if (
          data.mode !== "bridge" &&
          update.target !== "translation-engine" &&
          update.model.authMode === "subscription"
        )
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
          if (update.target === "translation-engine")
            next.translationEngine = update.engine;
          if (!update.target || update.target === "translation") {
            next.model = update.model;
            next.translationEngine = "llm";
          }
          if (update.target === "ask-default") next.askModel = update.model;
          if (
            update.target !== "translation-engine" &&
            (update.model.provider !== settings.model.provider ||
              update.model.endpoint !== settings.model.endpoint)
          )
            await browser.storage.session.remove(["apiKey", "balance"]);
          await browser.storage.local.set({ settings: next });
          await notify(
            next,
            update.target !== "translation-engine" && Boolean(update.apiKey),
          );
          return { ok: true };
        }
        if (update.target !== "translation-engine") resolveModel(update.model);
        else if (
          update.engine === "llm" &&
          !(await directKey(settings, settings.model))
        )
          throw new Error("请先添加大模型账户，再选择大模型翻译");
        const state = await updateDirectAccounts(settings, update);
        const next = {
          ...settings,
          mode: "direct" as const,
          model: state.translation,
          translationEngine: state.translationEngine,
          askModel: state.ask,
        };
        await browser.storage.local.set({ settings: next });
        await browser.storage.session.remove("balance");
        await notify(
          next,
          update.target !== "translation-engine" && Boolean(update.apiKey),
        );
        return { ok: true };
      }

      if (data.action === "reading-access-sync") {
        await syncReadingAccess();
        return { ok: true };
      }
      if (data.action === "state") {
        const summaryOnly =
          "includeUsageSummary" in data &&
          data.includeUsageSummary === true &&
          data.historyQuery === undefined;
        let bridgeUsage: UsageRecord[] = [];
        let budgets: BudgetSnapshot[] | undefined;
        let shareBudget = false;
        let sharedUsage = false;
        let usageSummary;
        let summaryError;
        let executionSettings = settings;
        let cacheStats: ReturnType<typeof service.cacheStats> | undefined =
          service.cacheStats();
        let queue: { running: number; pending: number } | undefined = {
          running: service.queue.runningCount,
          pending: service.queue.pendingCount,
        };
        let bridgeError: string | undefined;
        if (
          settings.mode === "bridge" &&
          !("localOnly" in data && data.localOnly === true)
        ) {
          try {
            const result = await bridge(
              { kind: "usage" },
              summaryOnly ? "browser:summary" : "browser",
            );
            if (!result.ok) throw new Error(result.error);
            if (summaryOnly)
              usageSummary = mergeAvailableUsage(
                service.ledger.summary("direct"),
                settings.mode,
                result.usageSummary,
              );
            bridgeUsage = result.usage ?? [];
            sharedUsage = result.sharedUsage ?? false;
            budgets = result.budgets;
            shareBudget = result.shareBudget ?? false;
            executionSettings = result.settings ?? settings;
            queue = result.queue;
            cacheStats = result.cacheStats;
          } catch (error) {
            bridgeError =
              error instanceof Error && error.message.includes("更新本地助手")
                ? error.message
                : "本地助手用量暂不可用；不会显示为零消耗";
          }
        }
        if (
          !bridgeError &&
          !usageSummary &&
          "includeUsageSummary" in data &&
          data.includeUsageSummary === true
        ) {
          try {
            usageSummary = await allUsage(settings);
          } catch (error) {
            summaryError =
              error instanceof Error ? error.message : "无法读取全部用量";
          }
        }
        const usage = summaryOnly ? [] : service.ledger.list();
        const page =
          data.historyQuery === undefined
            ? undefined
            : historyPage(
                bridgeError
                  ? []
                  : settings.mode === "bridge"
                    ? bridgeUsage
                    : usage,
                data.historyQuery,
                executionSettings.timeZone,
              );
        return {
          settings,
          historyPage: page,
          allUsage: usageSummary,
          summaryError,
          usage: page ? [] : usage,
          hasKey: Boolean(
            await directKey(settings, settings.model).catch(() => ""),
          ),
          bridgeUsage: page ? [] : bridgeUsage,
          budgets,
          shareBudget,
          executionSettings,
          cacheStats,
          translationCacheStats: translationCache.stats(),
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
          const state =
            JSON.stringify(next.model) !==
              JSON.stringify(existing.translation) ||
            (typeof data.apiKey === "string" && data.apiKey.trim())
              ? await updateDirectAccounts(
                  settings,
                  {
                    model: next.model,
                    ...(typeof data.apiKey === "string" && data.apiKey.trim()
                      ? { apiKey: data.apiKey.trim() }
                      : {}),
                  },
                  true,
                )
              : existing;
          next.model = state.translation;
          next.translationEngine = state.translationEngine;
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
        if (next.mode !== settings.mode) {
          await cancelTransports();
          service.reset();
        }
        await usageStorage.saveSettings(next, () => service.ledger.list());
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
        await notify(
          next,
          typeof data.apiKey === "string" && Boolean(data.apiKey.trim()),
        );
        return { ok: true };
      }
      if (data.action === "clear") {
        const results = await runDataCleanup(
          {
            "browser-data": async () => {
              await cancelTransports();
              service.reset();
              await usageStorage.clear();
              service.ledger.clear();
            },
            "translation-cache": () => translationCache.clear(),
            ...(settings.mode === "bridge"
              ? {
                  "assistant-data": async () => {
                    const result = await bridge(
                      { kind: "clear-data" },
                      "browser",
                    );
                    if (!result.ok) throw new Error(result.error);
                  },
                }
              : {}),
          },
          data.targets,
        );
        return { ok: true, results };
      }
      if (data.action === "translation-cache-state") {
        const stored = await browser.storage.local.get(
          "translationCachePreferences",
        );
        return {
          ok: true,
          preferences: cachePreferences(stored.translationCachePreferences),
          ...translationCache.stats(),
        };
      }
      if (data.action === "translation-cache-update") {
        const patch = data.preferences as {
          enabled?: unknown;
          days?: unknown;
        } | null;
        if (
          !patch ||
          typeof patch.enabled !== "boolean" ||
          typeof patch.days !== "number" ||
          ![1, 7, 30].includes(patch.days)
        )
          throw new Error("Invalid translation cache preferences");
        const previous = cachePreferences(
          (await browser.storage.local.get("translationCachePreferences"))
            .translationCachePreferences,
        );
        await translationCache.prune(previous.days);
        await translationCache.clear();
        await browser.storage.local.set({
          translationCachePreferences: {
            enabled: patch.enabled,
            days: patch.days,
          },
        });
        return { ok: true };
      }
      if (data.action === "translation-cache-clear") {
        await translationCache.clear();
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
      if (data.action === "page-status") {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
          return { supported: false };
        const url = new URL(tab.url);
        const status = await browser.tabs
          .sendMessage(tab.id, { action: "page-status" })
          .catch(() => undefined);
        if (status)
          return {
            ...status,
            supported: true,
            origin: url.origin,
            hostname: url.hostname,
          };
        // Read only availability. Opening the popup never starts the reader or sends page text.
        const probe = await browser.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: () => {
              const selection = document.getSelection();
              const node = selection?.anchorNode;
              const element =
                node instanceof Element ? node : node?.parentElement;
              return {
                hasSelection:
                  Boolean(selection?.toString().trim()) &&
                  !element?.closest("input,textarea,pre,[contenteditable]"),
                translated: false,
                pending: false,
              };
            },
          })
          .catch(() => []);
        const stored = await browser.storage.local.get("readingEnabled");
        return {
          ...probe[0]?.result,
          supported: true,
          origin: url.origin,
          hostname: url.hostname,
          readingEnabled: stored.readingEnabled !== false,
        };
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
