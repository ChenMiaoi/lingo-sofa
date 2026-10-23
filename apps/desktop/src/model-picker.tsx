import { listIndex } from "./keyboard";
import { dragWindow } from "./window-drag";
import React, { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  isImeKey,
  type ModelCatalog,
  type ModelInfo,
  type View,
} from "./api";
import type { LoadModelCatalog } from "./model-providers";
import type { Perform } from "./view";

type Choice = ModelInfo & { provider: string };

export function ModelPicker({
  model,
  search,
  loadCatalog,
  perform,
  onClose,
  onLogin,
}: {
  model: View;
  search: string;
  loadCatalog: LoadModelCatalog;
  perform: Perform;
  onClose: (applied?: boolean) => void;
  onLogin: (provider?: string) => void;
}) {
  const [query, setQuery] = useState(search);
  const [providerList, setProviderList] = useState<ModelCatalog["providers"]>(
    [],
  );
  const [browsingProviders, setBrowsingProviders] = useState(
    !model.configuredProviders.length,
  );
  const [provider, setProvider] = useState<string | null>(null);
  const [credentialFor, setCredentialFor] = useState<Choice | null>(null);
  const [key, setKey] = useState("");
  const savedProviders = useRef(new Set<string>());
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);
  const reloadPending = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const providers = JSON.stringify(model.configuredProviders);
  useEffect(() => {
    input.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    reloadPending.current = true;
    setChoices([]);
    setError("");
    setCatalogError("");
    if (browsingProviders) {
      setProviderList([]);
      void loadCatalog()
        .then((catalog) => {
          if (!disposed)
            setProviderList(
              catalog.providers.filter((entry) => entry.supported),
            );
        })
        .catch((reason) => {
          if (!disposed) setCatalogError(errorMessage(reason));
        })
        .finally(() => {
          if (!disposed) {
            reloadPending.current = false;
            setLoading(false);
            setReloading(false);
          }
        });
      return () => {
        disposed = true;
      };
    }
    const ids: string[] = provider ? [provider] : JSON.parse(providers);
    void Promise.all(
      ids.map(async (provider) => {
        let offset = 0;
        try {
          while (!disposed) {
            const page = await loadCatalog(provider, offset);
            if (disposed) return;
            if (page.supported === false) return;
            setChoices((previous) => [
              ...previous,
              ...page.models.map((entry) => ({ ...entry, provider })),
            ]);
            offset += page.models.length;
            if (offset >= page.total) return;
            if (!page.models.length)
              throw new Error("模型目录加载不完整，请重试。");
          }
        } catch (reason) {
          if (!disposed) setCatalogError(errorMessage(reason));
        }
      }),
    ).finally(() => {
      if (!disposed) {
        reloadPending.current = false;
        setLoading(false);
        setReloading(false);
      }
    });
    return () => {
      disposed = true;
    };
  }, [providers, loadCatalog, provider, browsingProviders, reloadAttempt]);
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = choices
    .filter((choice) => {
      const text =
        `${choice.provider}/${choice.id} ${choice.name}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => {
      const current = (choice: Choice) =>
        choice.provider === model.defaultModel.provider &&
        choice.id === model.defaultModel.modelId;
      return (
        Number(current(b)) - Number(current(a)) ||
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
      );
    });
  const providerMatches = providerList.filter((entry) =>
    terms.every((term) =>
      `${entry.id} ${entry.name}`.toLowerCase().includes(term),
    ),
  );
  const credentialProvider = providerList.find(
    (entry) => entry.id === credentialFor?.provider,
  );
  const count = browsingProviders ? providerMatches.length : matches.length;
  const loadedCount = browsingProviders ? providerList.length : choices.length;
  const index = Math.min(selected, Math.max(count - 1, 0));
  useEffect(() => {
    if (credentialFor) keyInput.current?.focus();
    else input.current?.focus();
  }, [credentialFor, browsingProviders]);
  const back = () => {
    if (inFlight.current) return;
    setError("");
    if (credentialFor) {
      setCredentialFor(null);
      setKey("");
    } else if (provider) {
      setProvider(null);
      setBrowsingProviders(true);
      setQuery("");
    } else onClose();
  };
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(".selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [index, choices, query]);
  const choose = async (choice?: Choice) => {
    if (inFlight.current) return;
    if (!choice) return;
    const configured =
      model.configuredProviders.includes(choice.provider) ||
      savedProviders.current.has(choice.provider);
    if (!configured && !credentialFor) {
      const info = providerList.find((entry) => entry.id === choice.provider);
      if (info?.apiKey === false && info.login) {
        onLogin(info.login);
        return;
      }
      setCredentialFor(choice);
      setKey("");
      return;
    }
    if (!configured && !key.trim()) return;
    if (
      configured &&
      choice.provider === model.defaultModel.provider &&
      choice.id === model.defaultModel.modelId
    ) {
      onClose(true);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      if (!configured) {
        const saved = await perform("save_provider", {
          provider: choice.provider,
          key: key.trim(),
        });
        if (!mounted.current) return;
        if (saved === false) {
          setError("凭证保存失败，请重试。");
          return;
        }
        savedProviders.current.add(choice.provider);
        setKey("");
      }
      const applied = await perform("select_model", {
        model: { provider: choice.provider, modelId: choice.id },
      });
      if (!mounted.current) return;
      if (applied === false) setError("切换失败，请重试；原默认模型已保留。");
      else onClose(true);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <main
      className="launcher model-picker selection-page"
      onKeyDown={(event) => {
        if (isImeKey(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}
    >
      <header className="command-header" onMouseDown={dragWindow}>
        <span className="model-picker-prefix">/model</span>
        {credentialFor ? (
          <input
            ref={keyInput}
            type="password"
            autoComplete="off"
            aria-label="服务商 API Key"
            placeholder="API Key（本机加密）"
            value={key}
            disabled={saving}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (
                isImeKey(event.nativeEvent) ||
                event.shiftKey ||
                event.key !== "Enter"
              )
                return;
              event.preventDefault();
              void choose(credentialFor);
            }}
          />
        ) : (
          <input
            ref={input}
            aria-label={browsingProviders ? "搜索服务商" : "搜索模型"}
            placeholder={
              browsingProviders ? "搜索服务商…" : "搜索模型名称、ID 或服务商…"
            }
            value={query}
            disabled={saving}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent) || event.shiftKey) return;
              const next = listIndex(event.key, index, count);
              if (next !== null) {
                event.preventDefault();
                setSelected(next);
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (browsingProviders) {
                  const choice = providerMatches[index];
                  if (choice) {
                    setProvider(choice.id);
                    setBrowsingProviders(false);
                    setQuery("");
                    setSelected(0);
                  }
                } else void choose(matches[index]);
              }
            }}
          />
        )}
        {!credentialFor && !browsingProviders && (
          <button
            className="text-button"
            disabled={saving}
            onClick={() => {
              setProvider(null);
              setBrowsingProviders(true);
              setQuery("");
              setSelected(0);
            }}
          >
            服务商
          </button>
        )}
        <button className="text-button" disabled={saving} onClick={back}>
          返回
        </button>
      </header>
      <div className="context-bar">
        <span className="context-origin">
          {credentialFor
            ? `${credentialFor.provider}/${credentialFor.id}`
            : `当前：${model.defaultModel.provider}/${model.defaultModel.modelId}`}
        </span>
      </div>
      <section
        className="action-list"
        aria-label={
          credentialFor
            ? "模型凭证"
            : browsingProviders
              ? "选择服务商"
              : "选择模型"
        }
        ref={list}
      >
        <div className="list-caption">
          <span>
            {credentialFor
              ? "配置凭证"
              : browsingProviders
                ? "选择服务商"
                : (provider ?? "已配置服务商的模型")}
          </span>
          <span>
            {!credentialFor &&
              (catalogError
                ? `${loadedCount ? `已加载 ${loadedCount} 项 · ` : ""}目录未完整`
                : `${count} 项${loading ? " · 加载中…" : ""}`)}
          </span>
        </div>
        {!credentialFor && (catalogError || reloading) && (
          <div className="quiet-status">
            <p role="status">
              {loading
                ? reloading
                  ? "正在重新加载目录…"
                  : "目录未完整，正在加载其余条目…"
                : `${loadedCount ? "目录未完整，已有条目可用。" : "目录加载失败。"} ${catalogError}`}
            </p>
            <button
              className="text-button"
              disabled={loading || saving}
              onClick={() => {
                if (reloadPending.current || inFlight.current) return;
                reloadPending.current = true;
                setReloading(true);
                setLoading(true);
                setReloadAttempt((value) => value + 1);
                input.current?.focus();
              }}
            >
              重试加载
            </button>
          </div>
        )}
        {credentialFor ? (
          <p className="quiet-status">
            {credentialFor.name} · {credentialFor.provider}/{credentialFor.id}
            {credentialProvider?.login &&
              credentialProvider.loginMethod !== "api-key" && (
                <button onClick={() => onLogin(credentialProvider.login)}>
                  改用订阅账户登录
                </button>
              )}
          </p>
        ) : browsingProviders ? (
          providerMatches.map((entry, position) => (
            <button
              key={entry.id}
              className={`action ${position === index ? "selected" : ""}`}
              onMouseMove={(event) => {
                if (event.movementX || event.movementY) setSelected(position);
              }}
              onClick={() => {
                setProvider(entry.id);
                setBrowsingProviders(false);
                setQuery("");
                setSelected(0);
              }}
            >
              <span className="action-copy">
                <strong>{entry.name}</strong>
                <small>
                  {entry.id} ·{" "}
                  {model.configuredProviders.includes(entry.id)
                    ? "已配置"
                    : entry.apiKey === false
                      ? "选择模型后订阅登录"
                      : "选择模型后输入 API Key"}
                </small>
              </span>
              {position === index && (
                <span className="enter-key" aria-hidden="true">
                  ↵
                </span>
              )}
            </button>
          ))
        ) : (
          matches.map((choice, position) => (
            <button
              key={`${choice.provider}/${choice.id}`}
              className={`action ${position === index ? "selected" : ""}`}
              disabled={saving}
              onMouseMove={(event) => {
                if (event.movementX || event.movementY) setSelected(position);
              }}
              onClick={() => void choose(choice)}
            >
              <span className="action-copy">
                <strong title={choice.name}>{choice.name}</strong>
                <small>
                  {choice.provider}/{choice.id}
                </small>
              </span>
              {choice.provider === model.defaultModel.provider &&
                choice.id === model.defaultModel.modelId && (
                  <span className="current-badge">当前</span>
                )}
              {position === index && (
                <span className="enter-key" aria-hidden="true">
                  ↵
                </span>
              )}
            </button>
          ))
        )}
        {!credentialFor && !count && !catalogError && !reloading && (
          <div className="quiet-status">
            <p>
              {loading
                ? "正在加载模型目录…"
                : browsingProviders
                  ? "没有匹配的服务商。"
                  : "没有匹配的模型。"}
            </p>
            {!loading && query.trim() && (
              <button
                onClick={() => {
                  setQuery("");
                  setSelected(0);
                  input.current?.focus();
                }}
              >
                清空搜索
              </button>
            )}
          </div>
        )}
      </section>
      <footer className="launcher-footer">
        <span role="status">
          {error ||
            (saving
              ? "正在切换模型…"
              : credentialFor
                ? "Enter 保存并切换 · Esc 返回"
                : browsingProviders
                  ? "↑↓ 选择服务商 · Enter 查看模型 · Esc 返回"
                  : "Enter 切换 · Esc 返回；切换结束会话，文本发往所选服务商。")}
        </span>
      </footer>
    </main>
  );
}
