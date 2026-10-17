import { providerConnectionLabel } from "./provider-label.js";
import { thinkingNames } from "./preference-labels.js";
import {
  accountMatches,
  type ModelConfig,
  type ProviderCatalog,
} from "@lingo-sofa/protocol";

type HostReact = {
  createElement: (...args: never[]) => unknown;
  useState<T>(initial: T): [T, (value: T) => void];
};

/** Share the controls while letting each host own saving and credentials. */
export function createModelPreferences(getReact: () => HostReact) {
  return function ModelPreferences({
    catalog,
    model,
    onChange,
    disabled = false,
    showAccounts = true,
    showEffort = true,
  }: {
    catalog: ProviderCatalog;
    model: ModelConfig;
    onChange: (model: ModelConfig) => void;
    disabled?: boolean;
    showAccounts?: boolean;
    showEffort?: boolean;
  }) {
    const React = getReact();
    const [query, setQuery] = React.useState("");
    const provider = catalog.providers.find(
      (item) => item.id === model.provider,
    );
    const active = provider?.models.find((item) => item.id === model.model);
    const matches = (value: string) =>
      value.toLowerCase().includes(query.trim().toLowerCase());
    const levels = active?.thinkingLevels ?? [];
    function choose(providerId: string, id: string) {
      const selected = catalog.providers
        .find((item) => item.id === providerId)
        ?.models.find((item) => item.id === id);
      setQuery("");
      onChange({
        ...model,
        accountId: providerId === model.provider ? model.accountId : undefined,
        provider: providerId,
        model: id,
        authMode: providerId === model.provider ? model.authMode : "api_key",
        endpoint:
          providerId === model.provider && model.accountId
            ? model.endpoint
            : (selected?.endpoint ?? "https://api.example.com/v1"),
        thinkingLevel: undefined,
        capabilities: undefined,
        prices: null,
      });
    }
    return (
      <fieldset disabled={disabled} className="model-preferences">
        <legend>模型偏好</legend>
        {showAccounts && !!catalog.accounts?.length && (
          <label>
            已配置供应商
            <select
              aria-label="已配置供应商"
              value={
                model.accountId ??
                catalog.accounts.find((item) => accountMatches(item, model))
                  ?.id ??
                ""
              }
              onChange={(event) => {
                const account = catalog.accounts.find(
                  (item) => item.id === event.target.value,
                );
                if (account) {
                  setQuery("");
                  onChange({ ...account.model, accountId: account.id });
                }
              }}
            >
              <option value="">选择已配置供应商</option>
              {catalog.accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {providerConnectionLabel(item, catalog)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          查找供应商或模型
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或模型 ID"
          />
        </label>
        <label>
          供应商
          <select
            aria-label="供应商"
            value={model.provider}
            onChange={(event) => {
              const id = event.target.value;
              choose(
                id,
                catalog.providers.find((item) => item.id === id)?.models[0]
                  ?.id ?? "",
              );
            }}
          >
            {catalog.providers
              .filter(
                (item) =>
                  item.models.length &&
                  (item.id === model.provider ||
                    matches(`${item.name} ${item.id}`) ||
                    item.models.some((entry) => matches(entry.id))),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            <option value="openai-compatible">自定义 · OpenAI 兼容</option>
          </select>
        </label>
        <label>
          模型
          {model.provider === "openai-compatible" ? (
            <input
              aria-label="模型"
              value={model.model}
              placeholder="输入模型 ID"
              onChange={(event) =>
                onChange({
                  ...model,
                  model: event.target.value,
                  thinkingLevel: undefined,
                  capabilities: undefined,
                  prices: null,
                })
              }
            />
          ) : (
            <select
              aria-label="模型"
              value={model.model}
              onChange={(event) => choose(model.provider, event.target.value)}
            >
              {!active && (
                <option value={model.model}>{model.model} · 当前模型</option>
              )}
              {provider?.models
                .filter(
                  (item) =>
                    item.id === model.model ||
                    matches(item.id) ||
                    matches(`${provider.name} ${provider.id}`),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
            </select>
          )}
        </label>
        {showEffort && (
          <>
            <label>
              思考强度 · Effort
              <select
                aria-label="思考强度"
                disabled={!levels.length}
                value={model.thinkingLevel ?? ""}
                onChange={(event) =>
                  onChange({
                    ...model,
                    thinkingLevel: (event.target.value ||
                      undefined) as ModelConfig["thinkingLevel"],
                  })
                }
              >
                <option value="">默认</option>
                {model.thinkingLevel &&
                  !levels.includes(model.thinkingLevel) && (
                    <option value={model.thinkingLevel} disabled>
                      {model.thinkingLevel} · 不可用
                    </option>
                  )}
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {thinkingNames[level] ?? level}
                  </option>
                ))}
              </select>
            </label>
            {!levels.length && <small>当前模型未声明可调节的思考强度。</small>}
          </>
        )}
      </fieldset>
    );
  };
}
