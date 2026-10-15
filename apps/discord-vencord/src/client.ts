import {
  providerCatalogSchema,
  oauthRequestSchema,
  oauthStatusSchema,
  type ProviderUpdate,
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
  connect?: () => Promise<{ port: number; token: string } | null>;
}
export class DiscordBridgeClient {
  constructor(private readonly options: BridgeClientOptions) {}
  private async post(
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const connection = await this.options.connect?.();
    const token = connection?.token ?? this.options.token();
    if (token.length < 32)
      throw new Error("本地助手尚未连接，请检查助手安装后重试");
    const port = connection?.port ?? this.options.port();
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
          ? "本地助手连接已失效，请重试；原请求不会自动重发"
          : response.status === 409
            ? "有请求正在进行，请完成后再保存供应商"
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
  async oauth(action: "start" | "status" | "cancel" | "logout") {
    return oauthStatusSchema.parse(
      await this.post("/v1/oauth", oauthRequestSchema.parse({ action })),
    );
  }
  async providers() {
    return providerCatalogSchema.parse(await this.post("/v1/provider", {}));
  }
  async configureProvider(value: ProviderUpdate) {
    return replySchema.parse(await this.post("/v1/provider/update", value));
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
