import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runWorker } from "../../apps/omp-worker/src/runtime";
import type { AuthCredential } from "@oh-my-pi/pi-ai";
const provider = "deepseek";
const desktopBudget = process.argv.includes("--desktop-budget");
let httpCalls = 0;
let refreshes = 0;
await runWorker({
  provider: "deepseek",
  modelId: "w0-model",
  accounts: process.argv.includes("--api-only")
    ? ["deepseek"]
    : ["deepseek", "test-oauth"],
  origin: "http://127.0.0.1",
  outputCap: 512,
  compaction: desktopBudget
    ? { keepRecentTokens: 4096, reserveTokens: 2048 }
    : { keepRecentTokens: 128, reserveTokens: 512 },
  authOptions: ({ snapshots, persist }) => ({
    async refreshOAuthCredential(account, _id, current) {
      const observedRevision = snapshots.get(account)?.revision;
      if (observedRevision === undefined) throw new Error("unknown_account");
      refreshes++;
      await Bun.sleep(250);
      const credential = {
        ...current,
        access: "W0-new-access",
        refresh: "W0-new-refresh",
        expires: Date.now() + 3600000,
      };
      await persist(account, credential, observedRevision);
      return credential;
    },
  }),
  setup: async ({ auth, registry, transport, snapshots, cwd }) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const credential = snapshots.get("deepseek")?.credential;
        if (
          credential?.type !== "api_key" ||
          request.headers.get("authorization") !== `Bearer ${credential.key}`
        ) {
          return Response.json(
            { error: { message: "W0 credential binding failed" } },
            { status: 401 },
          );
        }
        await writeFile(join(cwd, "synthetic-http-count"), String(++httpCalls));
        const body = (await request.json()) as {
          messages: unknown[];
          model: string;
        };
        if (process.argv.includes("--record-messages")) {
          await writeFile(
            join(cwd, "synthetic-messages.json"),
            JSON.stringify(body.messages),
          );
        }
        const scenario = JSON.stringify(body.messages.at(-1));
        const slow = scenario.includes("W0_SLOW");
        const disconnect = scenario.includes("W0_DISCONNECT");
        const partial = scenario.includes("W0_PARTIAL");
        const text = scenario.includes("What is the project code")
          ? "W0-ALPHA"
          : "沙发译文 🛋️";
        const chunk = {
          id: "deepseek",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        };
        const finish = {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        const usageChunk = {
          ...chunk,
          choices: [],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 8,
            total_tokens: 88,
            prompt_tokens_details: { cached_tokens: 12 },
          },
        };
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ ...chunk, ...(partial ? { usage: usageChunk.usage } : {}) })}\n\n`,
                ),
              );
              if (disconnect) {
                await Bun.sleep(150);
                controller.error(new Error("synthetic_disconnect"));
                return;
              }
              if (slow) await Bun.sleep(5000);
              try {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(finish)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`,
                  ),
                );
                controller.close();
              } catch {
                /* The caller can cancel while the fixture is waiting. */
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    registry.registerProvider("deepseek", {
      api: "lingo-worker",
      apiKey: "LINGO_RUNTIME_ACCOUNT",
      baseUrl: `http://127.0.0.1:${server!.port}/v1`,
      streamSimple: transport,
      models: [
        {
          id: "w0-model",
          name: "W0 fixture",
          input: ["text"],
          reasoning: false,
          supportsTools: false,
          contextWindow: desktopBudget ? 1048576 : 8192,
          maxTokens: 512,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    registry.registerProvider("test-oauth", {
      oauth: {
        name: "W0 synthetic OAuth",
        getApiKey: (credential) => credential.access,
        async login() {
          return {
            access: "W0-old-access",
            refresh: "W0-old-refresh",
            expires: Date.now() - 120000,
          };
        },
      },
    });

    return {
      close: () => server.stop(true),
      stats: () => ({ httpCalls, refreshes }),
      handle: async (frame) => {
        switch (frame.method) {
          case "model.verify":
            if (process.argv.includes("--slow-catalog")) await Bun.sleep(600);
            return { model: "w0-model" };
          case "auth.set": {
            const credential = frame.payload.credential as AuthCredential;
            if (
              !credential ||
              credential.type !== "api_key" ||
              typeof credential.key !== "string"
            )
              throw new Error("invalid_credential");
            await auth.credentials.set("deepseek", credential);
            auth.keys.setRuntime(provider, credential.key);
            return { committed: true };
          }
          case "auth.login":
            await auth.oauth.login("test-oauth", {
              onAuth: () => undefined,
              onPrompt: async () => "unused",
            });
            return { committed: true };
          case "auth.refresh": {
            const keys = await Promise.all([
              auth.keys.get("test-oauth", "refresh-a"),
              auth.keys.get("test-oauth", "refresh-b"),
            ]);
            return {
              resolved: keys.every(Boolean),
              anyResolved: keys.some(Boolean),
              refreshes,
              revision: snapshots.get("test-oauth")?.revision,
            };
          }
          case "auth.logout":
            await auth.credentials.remove("test-oauth");
            return { committed: true };

          default:
            throw new Error("method_not_allowed");
        }
      },
    };
  },
});
