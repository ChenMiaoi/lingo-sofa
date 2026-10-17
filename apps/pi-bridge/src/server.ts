import { AskSessions } from "./ask-sessions.js";
import { ProviderAccounts } from "./accounts.js";
import { type ModelConfig } from "@lingo-sofa/protocol";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolveModel, listModels } from "@lingo-sofa/provider-pi/node";
import { capabilities } from "@lingo-sofa/provider-pi";
import { createWebTranslator } from "@lingo-sofa/provider-web";
import {
  TranslationService,
  summarizeModels,
} from "@lingo-sofa/translation-core";
import {
  oauthRequestSchema,
  providerUpdateSchema,
  type UsageRecord,
} from "@lingo-sofa/protocol";
import { bridgeEnvelopeSchema, type BridgeConfig } from "./config.js";
import { UsageHistory } from "./history.js";
import { SafePiSessions } from "./sdk.js";
import { BridgeOAuth } from "./oauth.js";
import { saveProviderSettings } from "./provider-settings.js";
import { ClientLeases } from "@lingo-sofa/local-runtime/leases";

export function createBridge(
  config: BridgeConfig,
  apiKey: string,
  token: string,
  expiresAt: number,
  directory: string,
  runtime?: {
    instanceId: string;
    server: Server;
    leases: ClientLeases;
    accepting?: boolean;
    readAllowedExtensions?: () => Promise<readonly string[]>;
    appVersion?: string;
    updateRequested?: boolean;
  },
) {
  if (token.length < 32)
    throw new Error("Pairing token must have at least 32 characters");
  const accounts = new ProviderAccounts(
    directory,
    config.settings.model,
    apiKey,
    config.usePiAuth,
    config.settings.translationEngine,
  );
  const oauth = new BridgeOAuth(directory, undefined, () => {
    service.reset();
    sessions.dispose();
    askSessions.dispose();
  });
  let configuring = false;
  let currentKey = apiKey;
  let sessions = new SafePiSessions(
    config.settings.model,
    apiKey,
    directory,
    config.settings.model.authMode === "subscription"
      ? oauth.authPath
      : config.usePiAuth && config.settings.model.provider !== "openai"
        ? (config.piAuthPath ?? `${homedir()}/.pi/agent/auth.json`)
        : undefined,
  );
  const authPath = (model: ModelConfig) =>
    model.authMode === "subscription"
      ? oauth.authPath
      : config.usePiAuth && model.provider !== "openai"
        ? (config.piAuthPath ?? `${homedir()}/.pi/agent/auth.json`)
        : undefined;
  const askSessions = new AskSessions(
    (model, key) => new SafePiSessions(model, key, directory, authPath(model)),
  );
  const initialized = accounts.ready.then(() => {
    config.settings.model = accounts.translation;
    config.settings.askModel = accounts.ask;
    config.settings.translationEngine = accounts.translationEngine;
    currentKey = accounts.key(accounts.translation);
    sessions.dispose();
    sessions = new SafePiSessions(
      accounts.translation,
      currentKey,
      directory,
      authPath(accounts.translation),
    );
  });
  void initialized.catch(() => undefined);
  function credential(model: ModelConfig) {
    resolveModel(model);
    const key = accounts.key(model);
    if (model.authMode === "subscription") {
      if (
        model.provider !== "openai" ||
        model.endpoint !== "https://api.openai.com/v1" ||
        !oauth.status().connected
      )
        throw new Error("请先登录 ChatGPT");
      return "";
    }
    if (key) return key;
    if (
      config.usePiAuth &&
      model.provider !== "openai" &&
      listModels(true).some(
        (provider) =>
          provider.id === model.provider &&
          provider.models.some(
            (item) =>
              item.id === model.model && item.endpoint === model.endpoint,
          ),
      )
    )
      return "";
    throw new Error("请先添加所选供应商账户");
  }
  const history = new UsageHistory(directory, config.settings.persistUsage);
  const inFlight = new Map<string, UsageRecord>();
  const checkpoint = () =>
    history.save([
      ...new Map(
        [...inFlight.values(), ...service.ledger.list()].map((record) => [
          record.requestId,
          record,
        ]),
      ).values(),
    ]);
  const service = new TranslationService({
    translator: (settings) =>
      createWebTranslator(
        settings.translationEngine === "google" ? "google" : "bing",
        fetch,
      ),
    sessionCalls: true,
    onBegin: async (record) => {
      inFlight.set(record.requestId, record);
      await checkpoint();
    },
    onFinish: async (id) => {
      inFlight.delete(id);
      await checkpoint();
    },
    onRecords: async () => {
      service.ledger.prune(Date.now(), config.settings.retentionDays);
      await checkpoint();
    },
    client: async (settings, onMetrics, call) =>
      sessions.translationClient(
        call!.scope,
        JSON.stringify(call!.translationLanguages ?? [settings.targetLanguage]),
        settings.glossary,
        onMetrics,
        call,
      ),
    ask: (key, question, context, signal, onMetrics, call) =>
      askSessions.ask(
        key,
        call!.model!,
        credential(call!.model!),
        question,
        context,
        signal,
        onMetrics,
        call,
      ),
    clearTranslationScope: (scope, prefix) =>
      sessions.clearTranslations(scope, prefix),
    clearAllSessions: () => {
      sessions.dispose();
      askSessions.dispose();
    },
    clearSession: (key) => askSessions.clear(key),
  });
  service.ledger.restore(history.read());
  service.ledger.prune(Date.now(), config.settings.retentionDays);
  const discordOrigins = new Set([
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com",
  ]);
  async function allowedOrigin(origin: string) {
    if (discordOrigins.has(origin)) return true;
    const extension = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
    if (!extension) return false;
    try {
      // Reload only browser authorization; active sessions and model settings stay intact.
      const extensions = runtime?.readAllowedExtensions
        ? await runtime.readAllowedExtensions()
        : config.allowedExtensions;
      return extensions.includes(extension);
    } catch {
      // A missing or invalid authorization file must never grant browser access.
      return false;
    }
  }
  const rate = new Map<string, { count: number; until: number }>();
  const server = runtime?.server ?? createServer();
  server.on("request", async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    const origin = request.headers.origin;
    if (!origin || !(await allowedOrigin(origin))) {
      reply(403, { ok: false, error: "Origin rejected" });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "POST");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      reply(204, null);
      return;
    }
    const auth = request.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (
      Date.now() >= expiresAt ||
      Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      reply(401, {
        ok: false,
        error: "Pairing token is missing, invalid or expired",
      });
      return;
    }
    if (
      request.headers.host !== `127.0.0.1:${config.port}` &&
      request.headers.host !== `localhost:${config.port}`
    ) {
      reply(403, { ok: false, error: "Host rejected" });
      return;
    }
    const limit = rate.get(origin);
    const bucket =
      limit && limit.until > Date.now()
        ? limit
        : { count: 0, until: Date.now() + 60_000 };
    rate.set(origin, bucket);
    if (++bucket.count > 120) {
      response.setHeader("Retry-After", "60");
      reply(429, { ok: false, error: "Bridge request limit reached" });
      return;
    }
    if (request.method !== "POST") {
      reply(405, { ok: false, error: "Use POST" });
      return;
    }
    if (runtime?.accepting === false) {
      reply(503, {
        ok: false,
        error: "Local service is finishing active requests",
      });
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > 256_000) {
          reply(413, { ok: false, error: "Request too large" });
          return;
        }
        chunks.push(buffer);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (runtime && request.url === "/v1/runtime/status") {
        reply(200, {
          version: 1,
          instanceId: runtime.instanceId,
          clients: runtime.leases.count,
          ...(runtime.appVersion ? { appVersion: runtime.appVersion } : {}),
        });
        return;
      }
      if (runtime && request.url === "/v1/runtime/prepare-update") {
        if (!discordOrigins.has(origin)) {
          reply(403, { ok: false, error: "Update requires a local installer" });
          return;
        }
        runtime.updateRequested = true;
        reply(200, { ok: true, clients: runtime.leases.count });
        return;
      }
      if (runtime && request.url === "/v1/runtime/lease") {
        const lease = raw as { id?: unknown; action?: unknown } | null;
        if (
          !lease ||
          typeof lease.id !== "string" ||
          !/^[\da-f-]{36}$/.test(lease.id)
        )
          throw new Error("Invalid runtime client");
        if (lease.action === "renew") runtime.leases.renew(origin, lease.id);
        else if (lease.action === "release")
          runtime.leases.release(origin, lease.id);
        else throw new Error("Invalid runtime action");
        reply(200, { ok: true });
        return;
      }
      await initialized;
      if (request.url === "/v1/provider") {
        if (
          config.settings.translationEngine === "llm" &&
          (config.settings.model.authMode !== "subscription" ||
            oauth.status().connected)
        )
          await sessions.runtime();
        reply(200, {
          capabilities: capabilities(
            config.settings.model,
            resolveModel(config.settings.model).model,
          ),
          model: config.settings.model,
          translationEngine: config.settings.translationEngine,
          askModel: accounts.ask,
          accounts: accounts.list(),
          keyConfigured: Boolean(currentKey),
          oauth: oauth.status(),
          piAuth: config.usePiAuth,
          providers: listModels(config.usePiAuth),
        });
        return;
      }
      if (request.url === "/v1/oauth") {
        const operation = oauthRequestSchema.parse(raw);
        if (
          operation.action !== "status" &&
          operation.action !== "cancel" &&
          (configuring || service.queue.size || inFlight.size)
        ) {
          reply(409, {
            ok: false,
            error: "请等待当前请求完成后再更改登录状态",
          });
          return;
        }
        if (operation.action === "status") reply(200, oauth.status());
        else if (operation.action === "start") reply(200, await oauth.start());
        else if (operation.action === "cancel")
          reply(200, await oauth.cancel());
        else {
          configuring = true;
          try {
            service.reset();
            sessions.dispose();
            reply(200, await oauth.logout());
          } finally {
            configuring = false;
          }
        }
        return;
      }
      if (configuring) {
        reply(409, {
          ok: false,
          error: "Provider configuration is being saved",
        });
        return;
      }
      if (request.url === "/v1/provider/update") {
        const update = providerUpdateSchema.parse(raw);
        if (update.target === "translation-engine") {
          if (service.translationBusy) {
            reply(409, { ok: false, error: "请等待当前翻译完成后再切换引擎" });
            return;
          }
          if (update.engine === "llm") credential(accounts.translation);
          configuring = true;
          try {
            await accounts.commit(accounts.plan(update));
            config.settings.translationEngine = update.engine;
            reply(200, { ok: true });
          } finally {
            configuring = false;
          }
          return;
        }
        // Validate the catalog before touching credentials or persistent state.
        if (update.target !== "remove-account") resolveModel(update.model);
        if (
          update.target !== "remove-account" &&
          update.model.provider !== "openai-compatible" &&
          !listModels(config.usePiAuth).some(
            (provider) => provider.id === update.model.provider,
          )
        )
          throw new Error(
            "Provider requires explicitly enabled Pi authentication",
          );
        const plan = accounts.plan(update);
        const selected =
          update.target === "ask-default"
            ? plan.ask
            : update.target === "account"
              ? update.newAccount || update.apiKey
                ? plan.accounts.at(-1)!.model
                : (plan.accounts.find(
                    (item) => item.id === update.model.accountId,
                  )?.model ?? update.model)
              : update.target === "remove-account"
                ? update.model
                : plan.translation;
        const nextKey =
          update.target === "remove-account"
            ? ""
            : accounts.keyFrom(plan, selected);
        const changesTranslation =
          !update.target ||
          update.target === "translation" ||
          accounts.keyFrom(plan, plan.translation) !== currentKey;
        const subscription = update.model.authMode === "subscription";
        if (
          update.target !== "remove-account" &&
          subscription &&
          (update.model.provider !== "openai" ||
            update.model.endpoint !== "https://api.openai.com/v1" ||
            !oauth.status().connected)
        ) {
          reply(400, {
            ok: false,
            error: "请先登录 ChatGPT；订阅仅支持 OpenAI 官方端点",
          });
          return;
        }
        if (
          update.target !== "remove-account" &&
          !subscription &&
          !nextKey &&
          (!config.usePiAuth || update.model.provider === "openai")
        ) {
          reply(400, {
            ok: false,
            error: "An API key is required for this provider",
          });
          return;
        }
        if (
          oauth.busy ||
          (changesTranslation &&
            (service.translationBusy ||
              (service.queue.size > 0 && !service.askBusy)))
        ) {
          reply(409, {
            ok: false,
            error:
              "Wait for current requests to finish before changing provider",
          });
          return;
        }
        configuring = true;
        try {
          if (!update.target || update.target === "translation") {
            await saveProviderSettings(directory, {
              model: plan.translation,
              ...(nextKey ? { apiKey: nextKey } : {}),
            });
          }
          await accounts.commit(plan);
          config.settings.translationEngine = plan.translationEngine;
          config.settings.askModel = plan.ask;
          if (changesTranslation) {
            // Paid Ask work and other conversations remain intact.
            sessions.dispose();
            config.settings.model = plan.translation;
            currentKey = accounts.key(plan.translation);
            sessions = new SafePiSessions(
              plan.translation,
              currentKey,
              directory,
              authPath(plan.translation),
            );
          }
          reply(200, { ok: true });
        } finally {
          configuring = false;
        }
        return;
      }
      if (request.url === "/v1/usage") {
        if (
          !raw ||
          typeof raw !== "object" ||
          !("scope" in raw) ||
          typeof raw.scope !== "string" ||
          raw.scope.length > 512
        )
          throw new Error("Invalid usage scope");
        const scope = `${origin}|${raw.scope}`;
        service.ledger.prune(Date.now(), config.settings.retentionDays);
        const usage: UsageRecord[] = service.ledger
          .list()
          .filter((record) => config.shareUsage || record.scope === scope);
        reply(200, { ok: true, usage, expiresAt, version: 1 });
        return;
      }
      if (request.url !== "/v1/request") {
        reply(404, { ok: false, error: "Unknown route" });
        return;
      }
      const envelope = bridgeEnvelopeSchema.parse(raw);
      const expectedKind = origin.startsWith("chrome-extension://")
        ? "web"
        : "discord";
      if (envelope.sourceKind !== expectedKind)
        throw new Error("Source boundary mismatch");
      if (
        expectedKind === "web" &&
        envelope.scope === "browser:summary" &&
        envelope.request.kind === "usage"
      ) {
        service.ledger.prune(Date.now(), config.settings.retentionDays);
        reply(200, {
          ok: true,
          usageSummary: summarizeModels(service.ledger.list()),
          settings: config.settings,
        });
        return;
      }
      if (
        expectedKind === "web" &&
        envelope.scope === "browser" &&
        envelope.request.kind === "clear-data"
      ) {
        await service.clearScopes(`${origin}|`);
        reply(200, { ok: true });
        return;
      }
      if (
        oauth.busy &&
        (envelope.request.kind === "ask" ||
          (envelope.request.kind === "translate" &&
            config.settings.translationEngine === "llm"))
      ) {
        reply(409, { ok: false, error: "请完成或取消 ChatGPT 登录后再翻译" });
        return;
      }
      service.ledger.prune(Date.now(), config.settings.retentionDays);
      const result = await service.handle(
        envelope.request,
        `${origin}|${envelope.scope}`,
        { ...config.settings, mode: "bridge" },
        expectedKind,
      );
      if (result.ok && envelope.request.kind === "usage") {
        if (config.shareUsage) result.usage = service.ledger.list();
        else if (expectedKind === "web" && envelope.scope === "browser")
          result.usage = service.ledger
            .list()
            .filter((record) => record.scope.startsWith(`${origin}|`));
        result.sharedUsage = config.shareUsage;
        result.settings = config.settings;
        // Retain empty legacy response fields for installed clients during upgrades.
        result.shareBudget = false;
        result.budgets = [];
        result.cacheStats = config.shareUsage
          ? service.cacheStats()
          : service.cacheStats(
              expectedKind === "web" && envelope.scope === "browser"
                ? `${origin}|`
                : `${origin}|${envelope.scope}`,
              expectedKind === "web" && envelope.scope === "browser",
            );
        result.queue = {
          running: service.queue.runningCount,
          pending: service.queue.pendingCount,
        };
      }
      if (result.ok && envelope.request.kind === "ask") {
        const stats = askSessions.stats(
          `${origin}|${envelope.scope}|${envelope.request.sessionId}`,
        );
        if (stats)
          result.sessionStats = {
            tokens: stats.tokens.total,
            messages: stats.totalMessages,
            cost: stats.cost,
          };
      }
      reply(200, result);
    } catch {
      reply(400, { ok: false, error: "Invalid request or unavailable Bridge" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.on("close", () => {
    void oauth.cancel();
    service.reset();
    sessions.dispose();
    askSessions.dispose();
  });
  return {
    server,
    service,
    get busy() {
      return (
        oauth.busy ||
        configuring ||
        Boolean(
          inFlight.size ||
          service.queue.runningCount ||
          service.queue.pendingCount,
        )
      );
    },
    cancelOAuth: () => oauth.cancel(),
    flush: checkpoint,
    get askSessions() {
      return askSessions;
    },
    get sessions() {
      return sessions;
    },
  };
}
