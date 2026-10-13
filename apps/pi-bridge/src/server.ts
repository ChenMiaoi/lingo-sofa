import { homedir } from "node:os";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createPiClient, resolveModel } from "@lingo-sofa/provider-pi/node";
import { TranslationService } from "@lingo-sofa/translation-core";
import type { UsageRecord } from "@lingo-sofa/protocol";
import { bridgeEnvelopeSchema, type BridgeConfig } from "./config.js";
import { SafePiSessions } from "./sdk.js";

export function createBridge(
  config: BridgeConfig,
  apiKey: string,
  token: string,
  expiresAt: number,
  directory: string,
) {
  if (token.length < 32)
    throw new Error("Pairing token must have at least 32 characters");
  const sessions = new SafePiSessions(
    config.settings.model,
    apiKey,
    directory,
    config.usePiAuth
      ? (config.piAuthPath ?? `${homedir()}/.pi/agent/auth.json`)
      : undefined,
  );
  const service = new TranslationService({
    pricing: (settings) => {
      const resolved = resolveModel(settings.model);
      return resolved.costKnown ? resolved.model.cost : null;
    },
    client: async (settings, onMetrics) =>
      createPiClient(settings.model, await sessions.runtime(), onMetrics),
    ask: (key, question, context, signal, onMetrics) =>
      sessions.ask(key, question, context, signal, onMetrics),
    clearSession: (key) => sessions.clear(key),
  });
  const allowed = new Set([
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com",
    ...config.allowedExtensions.map((id) => `chrome-extension://${id}`),
  ]);
  const rate = new Map<string, { count: number; until: number }>();
  const server = createServer(async (request, response) => {
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
      const result = await service.handle(
        envelope.request,
        `${origin}|${envelope.scope}`,
        { ...config.settings, mode: "bridge" },
        expectedKind,
      );
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
  return { server, service, sessions };
}
