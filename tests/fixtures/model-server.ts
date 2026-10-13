import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export async function modelServer(
  options: { reply?: string; status?: number; delay?: number } = {},
) {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { messages: { content: string }[] };
    requests.push(body);
    if (options.status) {
      response.writeHead(options.status);
      response.end(JSON.stringify({ error: { message: "fixture failure" } }));
      return;
    }
    let answer = options.reply;
    if (answer === undefined) {
      const prompt = body.messages.at(-1)!.content;
      try {
        const units = JSON.parse(prompt) as { id: string; text: string }[];
        answer = JSON.stringify(
          units.map((unit) => ({ id: unit.id, text: `译文 ${unit.text}` })),
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
    chunk({}, "stop", {
      prompt_tokens: 32,
      completion_tokens: 12,
      total_tokens: 44,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
