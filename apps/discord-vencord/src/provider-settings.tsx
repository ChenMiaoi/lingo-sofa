import { React } from "@webpack/common";
import type { ProviderCatalog, ModelConfig } from "@lingo-sofa/protocol";
import type { DiscordBridgeClient } from "./client.js";
export function ProviderSettings({
  client,
  onSaved,
}: {
  client: Pick<DiscordBridgeClient, "providers" | "configureProvider">;
  onSaved: () => void;
}) {
  const [catalog, setCatalog] = React.useState<ProviderCatalog | null>(null);
  const [model, setModel] = React.useState<ModelConfig | null>(null);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const load = React.useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await client.providers();
      setCatalog(next);
      setModel(next.model);
    } catch {
      setError(
        "请启动本地助手并更新配对，再点击重新连接。旧版助手可从悬浮入口的更多操作中配对。",
      );
    } finally {
      setBusy(false);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  const change = (next: ModelConfig) => {
    setModel(next);
    setSaved(false);
    setError("");
  };
  const provider = catalog?.providers.find(
    (item) => item.id === model?.provider,
  );
  const custom = model?.provider === "openai-compatible";
  return (
    <section className="lingo-sofa-panel lingo-sofa-provider">
      <header className="lingo-sofa-provider-header">
        <span className="lingo-sofa-provider-mark" aria-hidden>
          译
        </span>
        <div>
          <h2>连接你的 AI</h2>
          <p>选择供应商，开始在原文下方阅读译文。</p>
        </div>
        <span className="lingo-sofa-connection-status">
          {catalog ? "本地助手已连接" : "等待连接"}
        </span>
      </header>
      {error && <p role="alert">{error}</p>}
      {!catalog || !model ? (
        <button disabled={busy} onClick={() => void load()}>
          {busy ? "连接中…" : "重新连接"}
        </button>
      ) : (
        <>
          <div className="lingo-sofa-provider-fields">
            <label>
              供应商
              <select
                aria-label="供应商"
                value={model.provider}
                onChange={(event) => {
                  const id = event.target.value;
                  const first = catalog.providers.find((item) => item.id === id)
                    ?.models[0];
                  setKey("");
                  change({
                    ...model,
                    provider: id,
                    model: first?.id ?? "",
                    endpoint: first?.endpoint ?? "https://api.example.com/v1",
                    prices: null,
                  });
                }}
              >
                {catalog.providers
                  .filter((item) => item.models.length)
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
              {custom ? (
                <input
                  aria-label="模型"
                  value={model.model}
                  placeholder="输入模型 ID"
                  onChange={(event) =>
                    change({ ...model, model: event.target.value })
                  }
                />
              ) : (
                <select
                  aria-label="模型"
                  value={model.model}
                  onChange={(event) => {
                    const selected = provider?.models.find(
                      (item) => item.id === event.target.value,
                    );
                    if (selected)
                      change({
                        ...model,
                        model: selected.id,
                        endpoint: selected.endpoint,
                        prices: null,
                      });
                  }}
                >
                  {provider?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          {custom && (
            <label>
              API 地址
              <input
                type="url"
                value={model.endpoint}
                onChange={(event) =>
                  change({ ...model, endpoint: event.target.value })
                }
                placeholder="https://…/v1"
              />
            </label>
          )}
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={
                catalog.keyConfigured &&
                model.provider === catalog.model.provider &&
                model.endpoint === catalog.model.endpoint
                  ? "已配置 · 留空保留现有 Key"
                  : catalog.piAuth
                    ? "可使用本地 Pi 登录，或输入 API Key"
                    : "输入该供应商的 API Key"
              }
              onChange={(event) => {
                setKey(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="lingo-sofa-control-hint">
            Key 仅保存在本机助手中，不写入 Discord
            设置。配置应用于该助手的所有连接端；供应商变更会清理 Ask Pi
            对话，用量和预算继续保留。
          </p>
          <footer className="lingo-sofa-provider-footer">
            <span role="status">
              {saved
                ? "已保存，下次翻译使用新的配置"
                : "所有频道均可使用 · 翻译语言在悬浮入口设置"}
            </span>
            <button
              className="lingo-sofa-primary"
              disabled={
                busy ||
                !model.model.trim() ||
                (!key.trim() &&
                  !catalog.piAuth &&
                  !(
                    catalog.keyConfigured &&
                    model.provider === catalog.model.provider &&
                    model.endpoint === catalog.model.endpoint
                  ))
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const reply = await client.configureProvider({
                    model,
                    ...(key.trim() ? { apiKey: key.trim() } : {}),
                  });
                  if (!reply.ok) throw new Error(reply.error);
                  onSaved();
                  setKey("");
                  const next = await client.providers();
                  setCatalog(next);
                  setModel(next.model);
                  setSaved(true);
                } catch {
                  setError(
                    "保存失败。请检查模型、地址与 Key；若翻译正在进行，请完成后重试。",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
