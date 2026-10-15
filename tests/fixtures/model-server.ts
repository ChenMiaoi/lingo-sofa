import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export async function modelServer(
  options: {
    reply?: string;
    status?: number;
    delay?: number;
    echoMetadata?: boolean;
    markdown?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputTokens?: number | ((call: number) => number);
  } = {},
) {
  const requests: unknown[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            ...["fixture", "fixture-next"].map((id) => ({
              id,
              context_window: options.contextWindow ?? 32768,
              max_output_tokens: options.maxOutputTokens ?? 8192,
            })),
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    if (!raw) {
      response.writeHead(400);
      response.end("Missing fixture request");
      return;
    }
    const body = JSON.parse(raw) as {
      messages: { content: string | { type: string; text?: string }[] }[];
    };
    requests.push(body);
    authorizations.push(request.headers.authorization);
    if (options.status) {
      response.writeHead(options.status);
      response.end(JSON.stringify({ error: { message: "fixture failure" } }));
      return;
    }
    let answer = options.reply;
    if (answer === undefined) {
      const content = body.messages.at(-1)!.content;
      const prompt =
        typeof content === "string"
          ? content
          : content
              .filter((item) => item.type === "text")
              .map((item) => item.text ?? "")
              .join("");
      try {
        const units = JSON.parse(prompt) as {
          id: string;
          text: string;
          targetLanguage?: string;
          context?: string;
        }[];
        answer = JSON.stringify(
          units.map((unit) => ({
            id: unit.id,
            text: `${options.markdown ? "**译文**" : "译文"} ${unit.text}`,
            ...(options.echoMetadata
              ? { targetLanguage: unit.targetLanguage, context: unit.context }
              : {}),
          })),
        );
      } catch {
        answer = "这是模拟回答。";
      }
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (
      delta: object,
      finish_reason: string | null = null,
      usage?: object,
    ) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    chunk({ role: "assistant", content: answer.slice(0, 2) });
    await new Promise((resolve) => setTimeout(resolve, options.delay ?? 20));
    if (response.destroyed) return;
    chunk({ content: answer.slice(2) });
    const inputTokens =
      typeof options.inputTokens === "function"
        ? options.inputTokens(requests.length)
        : (options.inputTokens ?? 32);
    chunk({}, "stop", {
      prompt_tokens: inputTokens,
      completion_tokens: 12,
      total_tokens: inputTokens + 12,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    authorizations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
