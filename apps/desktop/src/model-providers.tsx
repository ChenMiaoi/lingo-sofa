import React, { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  type ModelCatalog,
  type ModelInfo,
  type View,
} from "./api";
import type { Perform } from "./view";

export type LoadModelCatalog = (
  provider?: string,
  offset?: number,
) => Promise<ModelCatalog>;

export function ModelProviders({
  model,
  perform,
  loadCatalog,
  active,
  onLogin,
}: {
  model: View;
  perform: Perform;
  loadCatalog: LoadModelCatalog;
  active: boolean;
  onLogin: (provider?: string) => void;
}) {
  const [providers, setProviders] = useState<ModelCatalog["providers"]>([]);
  const [provider, setProvider] = useState(model.defaultModel.provider);
  const [selectedModel, setSelectedModel] = useState(
    model.defaultModel.modelId,
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [modelError, setModelError] = useState<{
    message: string;
    offset: number;
  } | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerRefresh, setProviderRefresh] = useState(0);
  const [modelRefresh, setModelRefresh] = useState(0);
  const request = useRef(0);
  const pendingPage = useRef<number | null>(null);
  const modelScope = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setProviderLoading(true);
    setProviderError("");
    void loadCatalog()
      .then((catalog) => {
        if (!disposed) setProviders(catalog.providers);
      })
      .catch((error) => {
        if (!disposed) setProviderError(errorMessage(error));
      })
      .finally(() => {
        if (!disposed) setProviderLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [active, loadCatalog, providerRefresh]);
  useEffect(() => {
    if (!active) return;
    const id = ++request.current;
    pendingPage.current = id;
    setLoading(true);
    setModelError(null);
    if (modelScope.current !== provider) {
      modelScope.current = provider;
      setModels([]);
      setTotal(0);
    }
    void loadCatalog(provider, 0)
      .then((catalog) => {
        if (id !== request.current) return;
        setModels(catalog.models);
        setTotal(catalog.total);
      })
      .catch((error) => {
        if (id === request.current)
          setModelError({ message: errorMessage(error), offset: 0 });
      })
      .finally(() => {
        if (id === request.current) {
          pendingPage.current = null;
          setLoading(false);
        }
      });
    return () => {
      request.current++;
    };
  }, [active, provider, loadCatalog, modelRefresh]);
  const loadMore = async () => {
    const id = request.current;
    if (pendingPage.current === id || modelError?.offset === 0) return;
    pendingPage.current = id;
    const offset = models.length;
    setLoading(true);
    setModelError(null);
    try {
      const catalog = await loadCatalog(provider, offset);
      if (id === request.current) {
        setModels((previous) => [...previous, ...catalog.models]);
        setTotal(catalog.total);
      }
    } catch (error) {
      if (id === request.current)
        setModelError({ message: errorMessage(error), offset });
    } finally {
      if (id === request.current) {
        pendingPage.current = null;
        setLoading(false);
      }
    }
  };
  const chooseProvider = (value: string) => {
    setProvider(value);
    setKey("");
    setSelectedModel(
      value === model.defaultModel.provider ? model.defaultModel.modelId : "",
    );
  };
  const configured = model.configuredProviders.includes(provider);
  const current =
    model.defaultModel.provider === provider &&
    model.defaultModel.modelId === selectedModel;
  const providerInfo = providers.find((entry) => entry.id === provider);
  const canSelect = providerInfo?.supported ?? false;
  const canConfigure = providerInfo?.apiKey ?? canSelect;
  const saveKey = async (value: string) => {
    setSaving(true);
    try {
      const saved = await perform("save_provider", { provider, key: value });
      if (saved !== false) setKey("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="settings-group model-providers"
      aria-label="模型与服务商"
    >
      <div className="model-page-heading">
        <div className="default-model-summary">
          <span>当前默认</span>
          <strong
            title={`${model.defaultModel.provider} / ${model.defaultModel.modelId}`}
          >
            {model.defaultModel.provider} / {model.defaultModel.modelId}
          </strong>
        </div>
        <button className="text-button" onClick={() => onLogin()}>
          订阅账户登录
        </button>
      </div>
      <div className="model-setting-row">
        <label htmlFor="provider">服务商</label>
        <div className="setting-control">
          <div className="provider-row">
            <select
              id="provider"
              value={provider}
              disabled={saving}
              onChange={(event) => chooseProvider(event.target.value)}
            >
              {[...new Set([provider, ...model.configuredProviders])]
                .filter((id) => !providers.some((entry) => entry.id === id))
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              {providers.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={
                    !entry.supported &&
                    !model.configuredProviders.includes(entry.id)
                  }
                >
                  {entry.name}
                  {model.configuredProviders.includes(entry.id)
                    ? " · 已配置"
                    : ""}
                  {entry.supported ? "" : " · 暂不支持此认证方式"}
                </option>
              ))}
            </select>
            <button
              disabled={saving || loading || providerLoading}
              onClick={() => {
                setProviderRefresh((value) => value + 1);
                setModelRefresh((value) => value + 1);
              }}
            >
              刷新列表
            </button>
          </div>
          {providerLoading ? (
            <p role="status">正在加载服务商目录…</p>
          ) : (
            providerError && (
              <div>
                <p role="status">服务商目录加载失败：{providerError}</p>
                <button
                  disabled={saving}
                  onClick={() => setProviderRefresh((value) => value + 1)}
                >
                  重试服务商列表
                </button>
              </div>
            )
          )}
        </div>
      </div>
      <div className="model-setting-row">
        <label htmlFor="default-model">默认模型</label>
        <div className="setting-control">
          <select
            id="default-model"
            value={selectedModel}
            disabled={saving || loading || !canSelect}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            <option value="">选择模型</option>
            {selectedModel &&
              !models.some((entry) => entry.id === selectedModel) && (
                <option value={selectedModel}>
                  {selectedModel} · 当前保存
                </option>
              )}
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name === entry.id
                  ? entry.id
                  : `${entry.name} · ${entry.id}`}
              </option>
            ))}
          </select>
          {models.length < total && !modelError && (
            <button disabled={loading} onClick={() => void loadMore()}>
              加载更多模型（{models.length}/{total}）
            </button>
          )}
          {modelError && (
            <div>
              <p role="status">模型目录加载失败：{modelError.message}</p>
              <button
                disabled={saving || loading}
                onClick={() => {
                  if (modelError.offset === 0)
                    setModelRefresh((value) => value + 1);
                  else void loadMore();
                }}
              >
                重试模型列表
              </button>
            </div>
          )}
          <div className="model-buttons">
            <button
              disabled={
                !configured ||
                !canSelect ||
                !selectedModel ||
                current ||
                saving ||
                loading
              }
              onClick={async () => {
                setSaving(true);
                try {
                  await perform("select_model", {
                    model: { provider, modelId: selectedModel },
                  });
                } finally {
                  setSaving(false);
                }
              }}
            >
              设为默认模型
            </button>
          </div>
        </div>
      </div>
      <div className="model-setting-row">
        <label htmlFor="api-key">API Key</label>
        <div className="setting-control">
          <div className="key-row">
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              placeholder="输入 API Key，仅加密保存在本机"
              value={key}
              disabled={saving || !canConfigure}
              onChange={(event) => setKey(event.target.value)}
            />
            <button
              disabled={!key.trim() || saving || !canConfigure}
              onClick={() => void saveKey(key.trim())}
            >
              保存凭证
            </button>
          </div>
          <div className="credential-actions">
            <span>{configured ? "已加密保存" : "尚未配置"}</span>
            {configured && (
              <button
                className="text-button"
                disabled={saving}
                onClick={() => void saveKey("")}
              >
                移除该服务商凭证
              </button>
            )}
          </div>
        </div>
      </div>
      <p>切换将结束当前会话；文本发往所选服务商。</p>
      <p role="status">
        {loading || providerLoading
          ? `目录加载中…已加载 ${models.length} 个模型`
          : providerError || modelError
            ? `目录尚未完整，已加载 ${models.length} 个模型`
            : `${total} 个可选模型`}
      </p>
    </section>
  );
}
