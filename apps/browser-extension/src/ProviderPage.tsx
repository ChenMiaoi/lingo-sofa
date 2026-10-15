import { ReadingAccess } from "./ReadingAccess.js";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import {
  providerCatalogSchema,
  providerUpdateSchema,
  type ProviderCatalog,
  type ModelConfig,
  type Settings,
} from "@lingo-sofa/protocol";

async function send(message: unknown) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败");
  return reply;
}
export function ProviderPage() {
  const [mode, setMode] = useState<"direct" | "bridge">("bridge");
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(nextMode: "direct" | "bridge") {
    setBusy(true);
    setError("");
    setCatalog(null);
    setKey("");
    try {
      const next = providerCatalogSchema.parse(
        await send({ action: "provider-catalog", mode: nextMode }),
      );
      setCatalog(next);
      setModel(next.model);
    } catch {
      setError("连接不可用，请检查本地助手安装后重试，或选择模型直连。");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void send({ action: "state" })
      .then((state: { settings: Settings }) => {
        setMode(state.settings.mode);
        void load(state.settings.mode);
      })
      .catch(() => setError("扩展设置读取失败，请重新打开。"));
  }, []);
  const provider = catalog?.providers.find(
    (provider) => provider.id === model?.provider,
  );
  const custom = model?.provider === "openai-compatible";
  const configured =
    catalog?.keyConfigured &&
    model?.provider === catalog.model.provider &&
    model?.endpoint === catalog.model.endpoint;
  return (
    <main className="provider-page">
      <header className="brand-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden>
            译
          </span>
          <div>
            <h1>LingoSofa</h1>
            <p>原文下方，直接阅读译文。</p>
          </div>
        </div>
        <a href="options.html?view=activity">用量与高级</a>
      </header>
      <ReadingAccess />
      <section className="provider-card">
        <header className="provider-heading">
          <span className="brand-mark" aria-hidden>
            译
          </span>
          <div>
            <h2>连接你的 AI</h2>
            <p>选择供应商，开始在原文下方阅读译文。</p>
          </div>
          <span className="mode-badge">
            {catalog
              ? mode === "bridge"
                ? "本地助手已连接"
                : catalog.keyConfigured
                  ? "Key 已配置"
                  : "尚未配置 Key"
              : "等待连接"}
          </span>
        </header>
        <div
          className="connection-modes"
          role="group"
          aria-label="模型连接方式"
        >
          <button
            aria-pressed={mode === "direct"}
            disabled={busy}
            onClick={() => {
              setMode("direct");
              void load("direct");
            }}
          >
            模型直连
          </button>
          <button
            aria-pressed={mode === "bridge"}
            disabled={busy}
            onClick={() => {
              setMode("bridge");
              void load("bridge");
            }}
          >
            本地助手
          </button>
        </div>
        <p className="muted">
          {mode === "bridge"
            ? "翻译按页面保留上下文，自动压缩历史；Ask Pi 使用独立会话。"
            : "模型直连使用独立请求；选择本地助手可连续保留翻译上下文并自动压缩。"}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!catalog || !model ? (
          <button disabled={busy} onClick={() => void load(mode)}>
            {busy ? "连接中…" : "重新连接"}
          </button>
        ) : (
          <>
            <div className="provider-fields">
              <label>
                供应商
                <select
                  aria-label="供应商"
                  value={model.provider}
                  disabled={busy}
                  onChange={(event) => {
                    const id = event.target.value;
                    const first = catalog.providers.find(
                      (provider) => provider.id === id,
                    )?.models[0];
                    setModel({
                      ...model,
                      provider: id,
                      model: first?.id ?? "",
                      endpoint: first?.endpoint ?? "https://api.example.com/v1",
                      prices: null,
                    });
                    setKey("");
                    setNotice("");
                  }}
                >
                  {catalog.providers
                    .filter((provider) => provider.models.length)
                    .map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  <option value="openai-compatible">
                    自定义 · OpenAI 兼容
                  </option>
                </select>
              </label>
              <label>
                模型
                {custom ? (
                  <input
                    aria-label="模型"
                    value={model.model}
                    disabled={busy}
                    placeholder="输入模型 ID"
                    onChange={(event) =>
                      setModel({ ...model, model: event.target.value })
                    }
                  />
                ) : (
                  <select
                    aria-label="模型"
                    value={model.model}
                    disabled={busy}
                    onChange={(event) => {
                      const selected = provider?.models.find(
                        (model) => model.id === event.target.value,
                      );
                      if (selected)
                        setModel({
                          ...model,
                          model: selected.id,
                          endpoint: selected.endpoint,
                          prices: null,
                        });
                    }}
                  >
                    {!provider?.models.some(
                      (item) => item.id === model.model,
                    ) && <option value={model.model}>{model.model}</option>}
                    {provider?.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
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
                  disabled={busy}
                  onChange={(event) =>
                    setModel({ ...model, endpoint: event.target.value })
                  }
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
                disabled={busy}
                placeholder={
                  configured
                    ? "已配置 · 留空保留现有 Key"
                    : catalog.piAuth
                      ? "使用本地 Pi 登录，或输入 API Key"
                      : "输入该供应商的 API Key"
                }
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <p className="muted">
              {mode === "direct"
                ? "Key 仅在本次浏览器会话保留，网页无法读取。直连支持 DeepSeek 与 OpenAI 兼容接口；其他供应商使用本地助手。"
                : "Key 仅保存在本机助手中，不写入扩展设置。模型配置应用于该助手的所有连接端。"}
            </p>
            <footer className="provider-footer">
              <span role="status">
                {notice || "语言、模型切换和自动翻译在悬浮入口设置"}
              </span>
              <button
                className="primary"
                disabled={
                  busy ||
                  !model.model.trim() ||
                  (!key.trim() && !configured && !catalog.piAuth)
                }
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  setNotice("");
                  try {
                    const update = providerUpdateSchema.parse({
                      model,
                      ...(key.trim() ? { apiKey: key.trim() } : {}),
                    });
                    if (
                      mode === "direct" &&
                      !(await browser.permissions.request({
                        origins: [`${new URL(model.endpoint).origin}/*`],
                      }))
                    )
                      throw new Error("需要允许访问所选模型地址。");
                    await send({
                      action: "provider-update",
                      mode,
                      update,
                    });
                    setKey("");
                    const next = providerCatalogSchema.parse(
                      await send({ action: "provider-catalog", mode }),
                    );
                    setCatalog(next);
                    setModel(next.model);
                    setNotice("已保存，下次翻译使用新的配置");
                  } catch (reason) {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "保存失败，请检查连接与 Key。",
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
    </main>
  );
}
