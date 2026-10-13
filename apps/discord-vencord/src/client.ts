import {
  replySchema,
  usageRecordSchema,
  type Request,
  type Reply,
  type UsageRecord,
} from "@lingo-sofa/protocol";
export interface BridgeClientOptions {
  port: () => number;
  token: () => string;
  origin?: string;
  fetcher?: typeof fetch;
}
export class DiscordBridgeClient {
  constructor(private readonly options: BridgeClientOptions) {}
  private async post(
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = this.options.token();
    if (token.length < 32)
      throw new Error("请先在 LingoSofa 设置中配对本地 Bridge");
    const port = this.options.port();
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid Bridge port");
    const response = await (this.options.fetcher ?? fetch)(
      `http://127.0.0.1:${port}${route}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(this.options.origin ? { Origin: this.options.origin } : {}),
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(50_000)])
          : AbortSignal.timeout(50_000),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "配对令牌已失效，请重新配对"
          : "Bridge 不可用或请求被限制",
      );
    return (await response.json()) as unknown;
  }
  async request(
    scope: string,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Reply> {
    return replySchema.parse(
      await this.post(
        "/v1/request",
        { version: 1, sourceKind: "discord", scope, request },
        signal,
      ),
    );
  }
  async usage(scope: string): Promise<UsageRecord[]> {
    const reply = (await this.post("/v1/usage", { scope })) as {
      ok: boolean;
      usage?: UsageRecord[];
    };
    if (!reply.ok || !reply.usage) throw new Error("无法读取 Bridge 用量");
    return usageRecordSchema.array().parse(reply.usage);
  }
}
