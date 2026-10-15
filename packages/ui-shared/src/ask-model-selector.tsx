import { providerConnectionLabel } from "./provider-label.js";
import { aiWorkspaceStyles } from "./ai-workspace-styles.js";
import type { ModelConfig, ProviderCatalog } from "@lingo-sofa/protocol";
import { createModelPreferences } from "./model-preferences.js";
import type { HostReact } from "./provider-auth.js";

export function createAskModelSelector(getReact: () => HostReact) {
  const ModelPreferences = createModelPreferences(getReact);
  const effortNames: Record<string, string> = {
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "更高",
    max: "最高",
  };
  return function AskModelSelector({
    load,
    model,
    onChange,
    disabled = false,
  }: {
    load: () => Promise<ProviderCatalog>;
    model: ModelConfig | undefined;
    onChange: (model: ModelConfig) => void;
    disabled?: boolean;
  }) {
    const React = getReact();
    const [catalog, setCatalog] = React.useState<ProviderCatalog | null>(null);
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      let alive = true;
      void load()
        .then((next) => {
          if (!alive) return;
          setCatalog(next);
          if (!model) onChange(next.askModel ?? next.model);
        })
        .catch(() => {
          if (alive) setError("无法读取模型，请检查连接并重新打开会话。");
        });
      return () => {
        alive = false;
      };
    }, [load]);
    const account = catalog?.accounts.find(
      (item) => item.id === model?.accountId,
    );
    return (
      <div className="ls-ask-model">
        <style>{aiWorkspaceStyles}</style>
        <details>
          <summary aria-label="选择本次对话模型">
            <strong title={model?.model}>{model?.model ?? "加载模型…"}</strong>
            <span>{effortNames[model?.thinkingLevel ?? ""] ?? "默认"} · ⌄</span>
          </summary>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setError("");
              void load()
                .then((next) => {
                  setCatalog(next);
                  if (!model) onChange(next.askModel ?? next.model);
                })
                .catch(() => setError("无法刷新供应商，请检查连接。"));
            }}
          >
            刷新供应商与模型
          </button>
          {catalog && model && (
            <ModelPreferences
              catalog={catalog}
              model={model}
              disabled={disabled}
              onChange={onChange}
            />
          )}
        </details>
        {error && <p role="alert">{error}</p>}
        {model && (
          <small>
            发送至{" "}
            {account && catalog
              ? providerConnectionLabel(account, catalog)
              : model.provider}{" "}
            · {model.provider}。切换仅影响本次对话，将携带本会话历史。
          </small>
        )}
      </div>
    );
  };
}
