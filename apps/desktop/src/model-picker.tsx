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
}: {
  model: View;
  search: string;
  loadCatalog: LoadModelCatalog;
  perform: Perform;
  onClose: (applied?: boolean) => void;
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
    setChoices([]);
    setError("");
    if (browsingProviders) {
      void loadCatalog()
        .then((catalog) => {
          if (!disposed)
            setProviderList(
              catalog.providers.filter((entry) => entry.supported),
            );
        })
        .catch((reason) => {
          if (!disposed) setError(errorMessage(reason));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
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
          if (!disposed) setError(errorMessage(reason));
        }
      }),
    ).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [providers, loadCatalog, provider, browsingProviders]);
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
  const count = browsingProviders ? providerMatches.length : matches.length;
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
      className="launcher model-picker"
      onKeyDown={(event) => {
        if (isImeKey(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}
    >
      <header className="command-header" data-tauri-drag-region>
        <span className="model-picker-prefix">/model</span>
        {credentialFor ? (
          <input
            ref={keyInput}
            type="password"
            autoComplete="off"
            aria-label="服务商 API Key"
            placeholder={`输入 ${credentialFor.provider} API Key，Enter 保存并切换`}
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
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const total = Math.max(count, 1);
                setSelected(
                  (index + (event.key === "ArrowDown" ? 1 : -1) + total) %
                    total,
                );
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
            ? `为 ${credentialFor.provider}/${credentialFor.id} 配置凭证，仅加密保存在本机`
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
              ? "输入凭证后直接切换"
              : browsingProviders
                ? "选择服务商"
                : (provider ?? "已配置服务商的模型")}
          </span>
          <span>
            {!credentialFor && `${count} 项${loading ? " · 加载中…" : ""}`}
          </span>
        </div>
        {credentialFor ? (
          <p className="quiet-status">
            {credentialFor.name} · {credentialFor.provider}/{credentialFor.id}
            <br />
            Enter 保存并切换 · Esc 返回模型列表
          </p>
        ) : browsingProviders ? (
          providerMatches.map((entry, position) => (
            <button
              key={entry.id}
              className={`action ${position === index ? "selected" : ""}`}
              onMouseEnter={() => setSelected(position)}
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
                    : "选择模型后输入 API Key"}
                </small>
              </span>
              {position === index && <span className="enter-key">↵</span>}
            </button>
          ))
        ) : (
          matches.map((choice, position) => (
            <button
              key={`${choice.provider}/${choice.id}`}
              className={`action ${position === index ? "selected" : ""}`}
              disabled={saving}
              onMouseEnter={() => setSelected(position)}
              onClick={() => void choose(choice)}
            >
              <span className="action-copy">
                <strong>
                  {choice.name}
                  {choice.provider === model.defaultModel.provider &&
                  choice.id === model.defaultModel.modelId
                    ? " · 当前"
                    : ""}
                </strong>
                <small>
                  {choice.provider}/{choice.id}
                </small>
              </span>
              {position === index && <span className="enter-key">↵</span>}
            </button>
          ))
        )}
        {!credentialFor && !count && (
          <p className="quiet-status">
            {loading
              ? "正在加载模型目录…"
              : browsingProviders
                ? "没有匹配的服务商。"
                : "没有匹配的模型，试试其他名称或服务商。"}
          </p>
        )}
      </section>
      <footer className="launcher-footer">
        <span role="status">
          {error ||
            (saving
              ? "正在切换模型…"
              : credentialFor
                ? "凭证只用于所选服务商，不会发送给模型。"
                : browsingProviders
                  ? "↑↓ 选择服务商 · Enter 查看模型 · Esc 返回"
                  : "↑↓ 选择 · Enter 切换 · Esc 返回；切换会结束当前会话")}
        </span>
      </footer>
    </main>
  );
}
