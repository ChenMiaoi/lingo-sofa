import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  createPiClient,
  resolveModel,
  listModels,
} from "@lingo-sofa/provider-pi/node";
import { TranslationService, budgetStatus } from "@lingo-sofa/translation-core";
import { providerUpdateSchema, type UsageRecord } from "@lingo-sofa/protocol";
import { bridgeEnvelopeSchema, type BridgeConfig } from "./config.js";
import { UsageHistory } from "./history.js";
import { SafePiSessions } from "./sdk.js";
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
  },
) {
  if (token.length < 32)
    throw new Error("Pairing token must have at least 32 characters");
  let configuring = false;
  let currentKey = apiKey;
  let sessions = new SafePiSessions(
    config.settings.model,
    apiKey,
    directory,
    config.usePiAuth
      ? (config.piAuthPath ?? `${homedir()}/.pi/agent/auth.json`)
      : undefined,
  );
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
    budgetScope: (scope) =>
      config.shareBudget ? undefined : `${scope.split("|")[0]}|`,
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
    pricing: (settings) => {
      const resolved = resolveModel(settings.model, Date.now(), true);
      return resolved.costKnown ? resolved.model.cost : null;
    },
    client: async (settings, onMetrics) =>
      createPiClient(settings.model, await sessions.runtime(), onMetrics),
    ask: (key, question, context, signal, onMetrics) =>
      sessions.ask(key, question, context, signal, onMetrics),
    clearSession: (key) => sessions.clear(key),
  });
  service.ledger.restore(history.read());
  service.ledger.prune(Date.now(), config.settings.retentionDays);
  const allowed = new Set([
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com",
    ...config.allowedExtensions.map((id) => `chrome-extension://${id}`),
  ]);
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
    if (!origin || !allowed.has(origin)) {
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
        });
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
      if (request.url === "/v1/provider") {
        reply(200, {
          model: config.settings.model,
          keyConfigured: Boolean(currentKey),
          piAuth: config.usePiAuth,
          providers: listModels(config.usePiAuth),
        });
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
        // Validate the catalog before touching credentials or persistent state.
        resolveModel(update.model);
        if (
          update.model.provider !== "openai-compatible" &&
          !listModels(config.usePiAuth).some(
            (provider) => provider.id === update.model.provider,
          )
        )
          throw new Error(
            "Provider requires explicitly enabled Pi authentication",
          );
        const sameCredentialTarget =
          update.model.provider === config.settings.model.provider &&
          update.model.endpoint === config.settings.model.endpoint;
        const nextKey =
          update.apiKey ?? (sameCredentialTarget ? currentKey : "");
        if (!nextKey && !config.usePiAuth) {
          reply(400, {
            ok: false,
            error: "An API key is required for this provider",
          });
          return;
        }
        if (
          service.queue.runningCount ||
          service.queue.pendingCount ||
          inFlight.size
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
          await saveProviderSettings(directory, {
            model: update.model,
            ...(nextKey ? { apiKey: nextKey } : {}),
          });
          service.reset();
          sessions.dispose();
          config.settings.model = update.model;
          currentKey = nextKey;
          sessions = new SafePiSessions(
            update.model,
            nextKey,
            directory,
            config.usePiAuth
              ? (config.piAuthPath ?? `${homedir()}/.pi/agent/auth.json`)
              : undefined,
          );
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
        envelope.scope === "browser" &&
        envelope.request.kind === "clear-data"
      ) {
        await service.clearScopes(`${origin}|`);
        reply(200, { ok: true });
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
        result.shareBudget = config.shareBudget;
        result.budgets = budgetStatus(
          service.ledger
            .list()
            .filter(
              (record) =>
                config.shareBudget || record.scope.startsWith(`${origin}|`),
            ),
          config.settings,
        );
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
        const stats = sessions.stats(
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
    service.reset();
    sessions.dispose();
  });
  return {
    server,
    service,
    get busy() {
      return (
        configuring ||
        Boolean(
          inFlight.size ||
          service.queue.runningCount ||
          service.queue.pendingCount,
        )
      );
    },
    flush: checkpoint,
    get sessions() {
      return sessions;
    },
  };
}
