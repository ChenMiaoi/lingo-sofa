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
}: {
  model: View;
  perform: Perform;
  loadCatalog: LoadModelCatalog;
  active: boolean;
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
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void loadCatalog()
      .then((catalog) => {
        if (!disposed) setProviders(catalog.providers);
      })
      .catch((error) => {
        if (!disposed) setError(errorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [active, loadCatalog, refresh]);
  useEffect(() => {
    if (!active) return;
    const id = ++request.current;
    setLoading(true);
    setError("");
    setModels([]);
    setTotal(0);
    void loadCatalog(provider, 0)
      .then((catalog) => {
        if (id !== request.current) return;
        setModels(catalog.models);
        setTotal(catalog.total);
      })
      .catch((error) => {
        if (id === request.current) setError(errorMessage(error));
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [active, provider, loadCatalog, refresh]);
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
  const canConfigure = providerInfo?.supported ?? false;
  const saveKey = async (value: string) => {
    setSaving(true);
    try {
      await perform("save_provider", { provider, key: value });
      setKey("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="settings-group model-providers"
      aria-label="模型与服务商"
    >
      <div className="default-model-summary">
        <span>当前默认模型</span>
        <strong>
          {model.defaultModel.provider} / {model.defaultModel.modelId}
        </strong>
        <small>
          {model.keyConfigured ? "已配置凭证" : "请为该服务商配置 API Key"}
        </small>
      </div>
      {model.configuredProviders.length > 0 && (
        <div className="configured-providers" aria-label="已配置服务商">
          {model.configuredProviders.map((id) => (
            <button
              key={id}
              aria-pressed={provider === id}
              disabled={saving}
              onClick={() => chooseProvider(id)}
            >
              {providers.find((entry) => entry.id === id)?.name ?? id}
              {id === model.defaultModel.provider ? " · 默认" : " · 已配置"}
            </button>
          ))}
        </div>
      )}
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
              {!providers.some((entry) => entry.id === provider) && (
                <option value={provider}>{provider}</option>
              )}
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
              disabled={saving || loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              刷新列表
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
      <div className="model-setting-row">
        <label htmlFor="default-model">默认模型</label>
        <div className="setting-control">
          <select
            id="default-model"
            value={selectedModel}
            disabled={saving || loading || !canConfigure}
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
                {entry.name} · {entry.id}
              </option>
            ))}
          </select>
          {models.length < total && (
            <button
              disabled={loading}
              onClick={async () => {
                const id = request.current;
                setLoading(true);
                try {
                  const catalog = await loadCatalog(provider, models.length);
                  if (id === request.current) {
                    setModels((previous) => [...previous, ...catalog.models]);
                    setTotal(catalog.total);
                  }
                } catch (error) {
                  if (id === request.current) setError(errorMessage(error));
                } finally {
                  if (id === request.current) setLoading(false);
                }
              }}
            >
              加载更多模型（{models.length}/{total}）
            </button>
          )}
          <div className="model-buttons">
            <button
              disabled={
                !configured ||
                !canConfigure ||
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
      <p className="model-scope-note">
        支持 API Key 服务商；OAuth、云平台特殊凭证与自定义地址暂未接入。
      </p>
      <p>
        切换默认模型会结束当前会话。后续翻译与提问将把文本发送至所选服务商。
      </p>
      <p role="status">
        {error || (loading ? "正在加载模型目录…" : `${total} 个可选模型`)}
      </p>
    </section>
  );
}
