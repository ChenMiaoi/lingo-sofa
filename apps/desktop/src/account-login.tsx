import { dragWindow } from "./window-drag";
import React, { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  isImeKey,
  type LoginProvider,
  type LoginState,
  type RequestLogin,
} from "./api";
import type { Perform } from "./view";

export function AccountLogin({
  provider,
  request,
  perform,
  onClose,
  onComplete,
}: {
  provider?: string;
  request: RequestLogin;
  perform: Perform;
  onClose: () => void;
  onComplete: (provider: string) => void;
}) {
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const catalogPending = useRef(true);
  const [state, setState] = useState<LoginState | null>(null);
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusRetry, setStatusRetry] = useState(0);
  const statusPending = useRef(false);
  const [browserError, setBrowserError] = useState("");
  const [opening, setOpening] = useState<"" | "url" | "browser">("");
  const openingPending = useRef<string | null>(null);
  const generation = useRef(0);
  const stateVersion = useRef(0);
  const completed = useRef(new Set<string>());
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLElement>(null);
  const live = useRef(true);
  const current = useRef<LoginState | null>(null);
  const inFlight = useRef(false);
  const browserOpened = useRef<string | null>(null);
  const opened = useRef<string | null>(null);
  const update = (next: LoginState) => {
    current.current = next;
    stateVersion.current++;
    setState(next);
    if (next.phase === "complete" && !completed.current.has(next.attempt)) {
      completed.current.add(next.attempt);
      onComplete(next.provider);
    }
  };
  const start = async (id: string) => {
    if (inFlight.current) return;
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = (await request({
        action: "start",
        provider: id,
      })) as LoginState;
      if (!live.current || generation.current !== version) {
        if (next.attempt)
          await request({ action: "cancel", attempt: next.attempt });
        return;
      }
      update(next);
    } catch (reason) {
      if (live.current && generation.current === version)
        setError(errorMessage(reason));
    } finally {
      if (generation.current === version) {
        inFlight.current = false;
        if (live.current) setBusy(false);
      }
    }
  };
  useEffect(() => {
    let disposed = false;
    catalogPending.current = true;
    setCatalogLoading(true);
    setCatalogError("");
    setProviders([]);
    void request({ action: "providers" })
      .then(
        (result) => {
          if (!disposed && live.current) {
            setProviders(result.providers ?? []);
            setSelected(0);
          }
        },
        (reason) => {
          if (!disposed && live.current) setCatalogError(errorMessage(reason));
        },
      )
      .finally(() => {
        if (!disposed && live.current) {
          catalogPending.current = false;
          setCatalogLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [request, catalogRetry]);
  const retryCatalog = () => {
    if (catalogPending.current) return;
    catalogPending.current = true;
    setCatalogLoading(true);
    setCatalogError("");
    setCatalogRetry((value) => value + 1);
  };
  useEffect(() => {
    live.current = true;
    generation.current++;
    inFlight.current = false;
    openingPending.current = null;
    statusPending.current = false;
    setOpening("");
    setStatusLoading(false);
    setStatusError("");
    setBrowserError("");
    setError("");
    setBusy(false);
    current.current = null;
    setState(null);
    if (provider) void start(provider);
    return () => {
      live.current = false;
      generation.current++;
      const active = current.current;
      if (active && ["waiting", "prompt"].includes(active.phase))
        void request({ action: "cancel", attempt: active.attempt }).catch(
          () => {},
        );
    };
  }, [provider, request]);
  useEffect(() => {
    if (!state || !["waiting", "prompt"].includes(state.phase)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const version = generation.current;
    const valid = () =>
      !disposed &&
      live.current &&
      generation.current === version &&
      current.current?.attempt === state.attempt;
    const schedule = () => {
      timer = setTimeout(() => void poll(), 500);
    };
    const poll = async () => {
      if (!valid()) return;
      if (inFlight.current) {
        schedule();
        return;
      }
      const revision = stateVersion.current;
      try {
        const next = (await request({
          action: "status",
          attempt: state.attempt,
        })) as LoginState;
        if (!valid()) return;
        if (revision !== stateVersion.current) {
          schedule();
          return;
        }
        setStatusError("");
        update(next);
        if (["waiting", "prompt"].includes(next.phase)) schedule();
      } catch (reason) {
        if (valid()) {
          if (revision !== stateVersion.current) schedule();
          else setStatusError(errorMessage(reason));
        }
      } finally {
        if (valid()) {
          statusPending.current = false;
          setStatusLoading(false);
        }
      }
    };
    timer = setTimeout(() => void poll(), statusPending.current ? 0 : 100);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [state?.attempt, state?.phase, request, statusRetry]);
  const retryStatus = () => {
    if (statusPending.current || inFlight.current) return;
    statusPending.current = true;
    setStatusLoading(true);
    setStatusRetry((value) => value + 1);
  };
  const openBrowser = async (kind: "url" | "browser") => {
    const active = current.current;
    if (!active || !["waiting", "prompt"].includes(active.phase)) return;
    const version = generation.current;
    const prompt = active.prompt?.id;
    const key = `${version}/${active.attempt}/${kind}/${prompt ?? ""}`;
    if (openingPending.current === key) return;
    const valid = () =>
      live.current &&
      generation.current === version &&
      openingPending.current === key &&
      current.current?.attempt === active.attempt &&
      ["waiting", "prompt"].includes(current.current.phase) &&
      (kind !== "browser" || current.current?.prompt?.id === prompt);
    openingPending.current = key;
    setOpening(kind);
    setBrowserError("");
    try {
      const ok = await perform(
        kind === "url" ? "open_login_url" : "open_login_browser",
        kind === "url"
          ? { attempt: active.attempt }
          : { attempt: active.attempt, prompt },
      );
      if (valid() && ok === false)
        setBrowserError(
          kind === "url"
            ? "浏览器未打开，请重试。"
            : "独立登录窗口未完成授权，请重试。",
        );
    } catch {
      if (valid())
        setBrowserError(
          kind === "url"
            ? "浏览器未打开，请重试。"
            : "独立登录窗口未完成授权，请重试。",
        );
    } finally {
      if (generation.current === version && openingPending.current === key) {
        openingPending.current = null;
        if (live.current) setOpening("");
      }
    }
  };
  useEffect(() => {
    if (
      !state?.url ||
      opened.current === state.attempt ||
      !["waiting", "prompt"].includes(state.phase)
    )
      return;
    opened.current = state.attempt;
    void openBrowser("url");
  }, [state?.attempt, state?.url, perform]);
  useEffect(() => {
    if (!state?.prompt?.browser) return;
    const id = `${state.attempt}/${state.prompt.id}`;
    if (browserOpened.current === id) return;
    browserOpened.current = id;
    void openBrowser("browser");
  }, [state?.attempt, state?.prompt?.id, perform]);
  useEffect(() => {
    field.current?.focus();
    setValue("");
  }, [state?.phase, state?.prompt?.id]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(".selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const matches = providers.filter((entry) =>
    `${entry.id} ${entry.name}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const close = () => {
    live.current = false;
    onClose();
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKey(event)) return;
      event.preventDefault();
      live.current = false;
      onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const submit = async () => {
    if (
      !state?.prompt ||
      inFlight.current ||
      (!state.prompt.allowEmpty && !value.trim())
    )
      return;
    const version = generation.current;
    const attempt = state.attempt;
    const prompt = state.prompt.id;
    const valid = () =>
      live.current &&
      generation.current === version &&
      current.current?.attempt === attempt &&
      current.current?.prompt?.id === prompt;
    stateVersion.current++;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = (await request({
        action: "input",
        attempt: state.attempt,
        prompt: state.prompt.id,
        value,
      })) as LoginState;
      if (valid()) {
        setValue("");
        update(next);
      }
    } catch (reason) {
      if (valid()) setError(errorMessage(reason));
    } finally {
      if (generation.current === version) {
        inFlight.current = false;
        if (live.current) setBusy(false);
      }
    }
  };
  return (
    <main className="launcher account-login">
      <header className="command-header" onMouseDown={dragWindow}>
        <span className="model-picker-prefix">/login</span>
        {!state || (state.prompt && !state.prompt.browser) ? (
          <input
            ref={field}
            aria-label={state?.prompt ? "登录授权输入" : "搜索订阅服务商"}
            type={state?.prompt?.secret ? "password" : "text"}
            autoComplete="off"
            aria-describedby={state?.prompt ? "login-prompt" : undefined}
            disabled={busy}
            placeholder={state?.prompt ? "输入授权信息…" : "搜索订阅账户…"}
            value={state?.prompt ? value : query}
            onChange={(event) => {
              if (state?.prompt) setValue(event.target.value);
              else {
                setQuery(event.target.value);
                setSelected(0);
              }
            }}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent) || event.shiftKey) return;
              if (!state && ["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setSelected(
                  (index) =>
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      Math.max(matches.length, 1)) %
                    Math.max(matches.length, 1),
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (state?.prompt) void submit();
                else if (matches[selected]) void start(matches[selected]!.id);
              }
            }}
          />
        ) : (
          <span className="context-origin">订阅账户授权</span>
        )}
        <button className="text-button" onClick={close}>
          返回
        </button>
      </header>
      <section className="action-list" aria-label="订阅账户登录" ref={list}>
        {catalogLoading ? (
          <p className="quiet-status" role="status">
            正在加载登录服务商…
          </p>
        ) : catalogError ? (
          <div className="quiet-status" role="status">
            <p>服务商列表加载失败。{catalogError}</p>
            <button onClick={retryCatalog}>重试服务商列表</button>
          </div>
        ) : !state && !matches.length ? (
          <div className="quiet-status" role="status">
            <p>
              {providers.length
                ? "没有匹配的登录服务商。"
                : "暂无可用的登录服务商。"}
            </p>
            {providers.length > 0 && query.trim() && (
              <button
                onClick={() => {
                  setQuery("");
                  setSelected(0);
                  field.current?.focus();
                }}
              >
                清空搜索
              </button>
            )}
          </div>
        ) : null}
        {!state ? (
          <>
            <div className="list-caption">
              <span>选择服务商登录</span>
              <span>↑↓ 选择 · Enter 登录</span>
            </div>
            {matches.map((entry, index) => (
              <button
                className={`action ${index === selected ? "selected" : ""}`}
                key={entry.id}
                disabled={busy}
                onMouseEnter={() => setSelected(index)}
                onClick={() => void start(entry.id)}
              >
                <span className="action-copy">
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.provider}
                    {entry.modelsSupported === false
                      ? " · 当前暂无可用文本模型"
                      : ""}
                  </small>
                </span>
                {index === selected && <span className="enter-key">↵</span>}
              </button>
            ))}
          </>
        ) : (
          <div className="login-attempt">
            <h2>
              {providers.find((entry) => entry.provider === state.provider)
                ?.name ?? state.provider}
            </h2>
            <p>
              {state.phase === "error"
                ? "授权未完成。原凭证已保留，可重新登录。"
                : state.phase === "cancelled"
                  ? "登录已取消。"
                  : state.phase === "complete"
                    ? "授权完成。"
                    : state.prompt && !state.prompt.browser
                      ? "输入授权信息"
                      : "请在浏览器完成授权。"}
            </p>
            {state.instructions && (
              <p className="login-instructions">{state.instructions}</p>
            )}
            {state.prompt && (
              <p id="login-prompt" className="login-prompt">
                {state.prompt.message}
              </p>
            )}
            {statusError && (
              <div className="login-recovery" role="status">
                <p>授权状态读取失败。{statusError}</p>
                <button disabled={statusLoading || busy} onClick={retryStatus}>
                  重试授权状态
                </button>
                {statusLoading && <span>正在读取…</span>}
              </div>
            )}
            {browserError && (
              <p className="login-error" role="status">
                {browserError}
              </p>
            )}
            <div className="login-actions">
              {state.url && ["waiting", "prompt"].includes(state.phase) && (
                <button
                  disabled={!!opening}
                  onClick={() => void openBrowser("url")}
                >
                  {opening === "url" ? "正在打开…" : "打开授权页面"}
                </button>
              )}
              {state.prompt?.browser && (
                <button
                  disabled={!!opening}
                  onClick={() => void openBrowser("browser")}
                >
                  {opening === "browser" ? "正在打开…" : "打开独立登录窗口"}
                </button>
              )}
              {state.prompt && !state.prompt.browser && (
                <button
                  disabled={busy || (!state.prompt.allowEmpty && !value.trim())}
                  onClick={() => void submit()}
                >
                  提交授权
                </button>
              )}
              {["error", "cancelled"].includes(state.phase) && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setState(null);
                    current.current = null;
                    setError("");
                    setStatusError("");
                    setBrowserError("");
                  }}
                >
                  重新选择账户
                </button>
              )}
            </div>
          </div>
        )}
      </section>
      <footer className="launcher-footer">
        <span role="status">
          {error ||
            (busy
              ? "正在处理登录…"
              : "授权令牌加密保存在本机 · Esc 取消并返回")}
        </span>
      </footer>
    </main>
  );
}
