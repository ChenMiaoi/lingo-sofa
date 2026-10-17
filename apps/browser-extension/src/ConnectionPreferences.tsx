import { useCallback, useEffect, useState } from "react";
import type { ProviderCatalog } from "@lingo-sofa/protocol";
import type { AISettingsClient } from "@lingo-sofa/ui-shared";
import { AssistantSetup } from "./AssistantSetup.js";
export function ConnectionPreferences({
  mode,
  activeMode,
  setMode,
  onConnected,
  client,
}: {
  mode: "bridge" | "direct";
  activeMode: "bridge" | "direct" | undefined;
  setMode: (mode: "bridge" | "direct") => void;
  onConnected: () => void;
  client: AISettingsClient;
}) {
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const connected = useCallback(() => {
    setRevision((value) => value + 1);
    onConnected();
  }, [onConnected]);
  useEffect(() => {
    let active = true;
    setCatalog(undefined);
    setError("");
    if (activeMode && mode !== activeMode)
      void client.providers().then(
        (value) => {
          if (active) setCatalog(value);
        },
        () => {
          if (active) setError("暂时无法读取此连接的配置，请检查连接后重试。");
        },
      );
    return () => {
      active = false;
    };
  }, [mode, activeMode, client, revision]);
  const label = (value: "bridge" | "direct") =>
    value === "bridge" ? "本地助手" : "模型直连";
  const pending = activeMode !== undefined && mode !== activeMode;
  return (
    <>
      <header className="ls-design-heading">
        <h1>连接方式</h1>
        <p>选择配置位置，再确认用于后续翻译与问答。</p>
      </header>
      <section className="ls-design-card" aria-label="连接配置位置">
        <p className="ls-active-connection" role="status">
          当前使用：
          <strong>{activeMode ? label(activeMode) : "正在读取…"}</strong>
        </p>
        <h2>配置位置</h2>
        <div
          className="connection-modes"
          role="group"
          aria-label="模型连接方式"
        >
          <button
            disabled={busy}
            aria-pressed={mode === "bridge"}
            onClick={() => setMode("bridge")}
          >
            本地助手
          </button>
          <button
            disabled={busy}
            aria-pressed={mode === "direct"}
            onClick={() => setMode("direct")}
          >
            模型直连
          </button>
        </div>
        <p>
          {mode === "bridge"
            ? "供应商配置保存在本机助手，浏览器与 Discord 共用。"
            : "直连供应商配置仅保存在此浏览器的本地存储。"}
        </p>
        {pending && (
          <div className="ls-connection-pending">
            <p>
              正在配置{label(mode)}
              ，尚未切换。确认后使用此处已有的翻译引擎与问答模型。
            </p>
            <button
              className="ls-solid-button"
              disabled={busy || !catalog}
              onClick={() => {
                if (!catalog) return;
                setBusy(true);
                setError("");
                void client
                  .configureProvider({
                    target: "translation-engine",
                    engine: catalog.translationEngine ?? "llm",
                  })
                  .then(onConnected)
                  .catch((reason: unknown) => {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "切换失败，请重试。",
                    );
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "正在切换…" : `使用${label(mode)}`}
            </button>
          </div>
        )}
        {error && (
          <div>
            <p role="alert">{error}</p>
            {!catalog && (
              <button onClick={() => setRevision((value) => value + 1)}>
                重新读取配置
              </button>
            )}
          </div>
        )}
        <a href="#translation">配置翻译引擎 →</a>
      </section>
      {mode === "bridge" && <AssistantSetup onConnected={connected} />}
    </>
  );
}
