import { subscriptionProviders } from "./subscription-login";
import type * as AI from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";

type Model = AI.Model<AI.Api>;
type SupportedModel = Model & { contextWindow: number; maxTokens: number };
type Transport = NonNullable<
  Parameters<ModelRegistry["registerProvider"]>[1]["streamSimple"]
>;
const supportedApis = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-gemini-cli",
  "openrouter",
  "ollama-chat",
]);

/** The SDK owns provider metadata, model limits and native wire protocols. */
export class WorkerModels {
  private readonly models: Model[];
  private readonly logins: ReturnType<typeof subscriptionProviders>;
  private readonly wrapped = new Map<string, SupportedModel>();
  constructor(
    private readonly registry: ModelRegistry,
    private readonly ai: typeof AI,
    private readonly transport: Transport,
    private readonly allowOrigin: (origin: string) => void,
    private readonly outputCap: number,
  ) {
    this.models = registry
      .getAll()
      .filter((model) => model.input.includes("text"));
    this.logins = subscriptionProviders(
      ai,
      new Set(this.models.map((model) => model.provider)),
    );
  }
  private supported(model: Model): model is SupportedModel {
    try {
      return (
        supportedApis.has(model.api) &&
        (this.ai.listProvidersWithEnvKey().includes(model.provider) ||
          this.logins.some((entry) => entry.provider === model.provider)) &&
        new URL(model.baseUrl).protocol === "https:" &&
        !/[{}]/.test(model.baseUrl) &&
        typeof model.contextWindow === "number" &&
        model.contextWindow >= 8192 &&
        typeof model.maxTokens === "number" &&
        model.maxTokens >= 128
      );
    } catch {
      return false;
    }
  }
  list(provider?: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new Error("invalid_catalog_page");
    if (!provider) {
      const providers = [...new Set(this.models.map((model) => model.provider))]
        .sort()
        .map((id) => {
          const models = this.models.filter((model) => model.provider === id);
          return {
            id,
            name: this.ai.getProviderDefinition(id)?.name ?? id,
            apiKey:
              id !== "openai-codex" &&
              this.ai.listProvidersWithEnvKey().includes(id),
            login: this.logins.find((entry) => entry.provider === id)?.id,
            loginMethod: this.logins.find((entry) => entry.provider === id)
              ?.method,
            supported: models.some((model) => this.supported(model)),
            modelCount: models.filter((model) => this.supported(model)).length,
          };
        });
      return { providers, models: [], total: 0 };
    }
    const all = this.models.filter(
      (model) => model.provider === provider && this.supported(model),
    );
    return {
      providers: [],
      supported: all.length > 0,
      apiKey:
        provider !== "openai-codex" &&
        this.ai.listProvidersWithEnvKey().includes(provider),
      total: all.length,
      models: all.slice(offset, offset + 100).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
      })),
    };
  }
  resolve(provider: string, modelId: string) {
    const model = this.models.find(
      (model): model is SupportedModel =>
        model.provider === provider &&
        model.id === modelId &&
        this.supported(model),
    );
    if (!model) throw new Error("model_not_verified");
    return model;
  }
  activate(provider: string, modelId: string) {
    const model = this.resolve(provider, modelId);
    this.allowOrigin(new URL(model.baseUrl).origin);
    this.wrapped.set(`${provider}/${modelId}`, model);
    this.registry.registerProvider(provider, {
      api: "lingo-worker",
      apiKey: "LINGO_RUNTIME_ACCOUNT",
      baseUrl: model.baseUrl,
      streamSimple: this.transport,
      models: [
        {
          ...model,
          api: "lingo-worker",
          supportsTools: model.supportsTools,
          compactionModel: undefined,
          contextPromotionTarget: undefined,
          remoteCompaction: undefined,
          maxTokens: Math.min(model.maxTokens, this.outputCap),
        },
      ],
    });
    return {
      id: model.id,
      name: model.name,
      provider,
      modelId,
      contextWindow: model.contextWindow,
      requestOutputCap: Math.min(model.maxTokens, this.outputCap),
      credentialSource: "rust-vault",
    };
  }
  native(model: Model) {
    const native = this.wrapped.get(`${model.provider}/${model.id}`);
    if (!native) throw new Error("model_not_verified");
    return native;
  }
}
