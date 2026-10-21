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
  const [state, setState] = useState<LoginState | null>(null);
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLElement>(null);
  const live = useRef(true);
  const current = useRef<LoginState | null>(null);
  const inFlight = useRef(false);
  const browserOpened = useRef<string | null>(null);
  const opened = useRef<string | null>(null);
  const update = (next: LoginState) => {
    current.current = next;
    setState(next);
  };
  const start = async (id: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = (await request({
        action: "start",
        provider: id,
      })) as LoginState;
      if (!live.current) {
        if (next.attempt)
          await request({ action: "cancel", attempt: next.attempt });
        return;
      }
      update(next);
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void request({ action: "providers" }).then(
      (result) => {
        if (live.current) setProviders(result.providers ?? []);
      },
      (reason) => {
        if (live.current) setError(errorMessage(reason));
      },
    );
    if (provider) void start(provider);
    return () => {
      live.current = false;
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
    const poll = async () => {
      try {
        const next = (await request({
          action: "status",
          attempt: state.attempt,
        })) as LoginState;
        if (disposed || !live.current) return;
        update(next);
        if (next.phase === "complete") {
          onComplete(next.provider);
          return;
        }
        if (["waiting", "prompt"].includes(next.phase))
          timer = setTimeout(() => void poll(), 500);
      } catch (reason) {
        if (!disposed && live.current) setError(errorMessage(reason));
      }
    };
    timer = setTimeout(() => void poll(), 100);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [state?.attempt, state?.phase, request]);
  useEffect(() => {
    if (
      !state?.url ||
      opened.current === state.attempt ||
      !["waiting", "prompt"].includes(state.phase)
    )
      return;
    opened.current = state.attempt;
    void perform("open_login_url", { attempt: state.attempt }).then(
      (ok) => {
        if (ok === false && live.current)
          setError("浏览器未打开，可按下方按钮重试。");
      },
      () => {
        if (live.current) setError("浏览器未打开，可按下方按钮重试。");
      },
    );
  }, [state?.attempt, state?.url, perform]);
  useEffect(() => {
    if (!state?.prompt?.browser) return;
    const id = `${state.attempt}/${state.prompt.id}`;
    if (browserOpened.current === id) return;
    browserOpened.current = id;
    void perform("open_login_browser", {
      attempt: state.attempt,
      prompt: state.prompt.id,
    }).then(
      (ok) => {
        if (ok === false && live.current) {
          setError("独立登录窗口未完成授权，请重试。");
        }
      },
      () => {
        if (live.current) {
          setError("独立登录窗口未完成授权，请重试。");
        }
      },
    );
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
    `${entry.id} ${entry.name}`.toLowerCase().includes(query.toLowerCase()),
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
      if (live.current) {
        setValue("");
        update(next);
      }
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <main className="launcher account-login">
      <header className="command-header" data-tauri-drag-region>
        <span className="model-picker-prefix">/login</span>
        {!state || (state.prompt && !state.prompt.browser) ? (
          <input
            ref={field}
            aria-label={state?.prompt ? "登录授权输入" : "搜索订阅服务商"}
            type={state?.prompt?.secret ? "password" : "text"}
            autoComplete="off"
            disabled={busy}
            placeholder={state?.prompt?.message ?? "搜索订阅账户…"}
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
          <div className="quiet-status">
            <p>
              {providers.find((entry) => entry.provider === state.provider)
                ?.name ?? state.provider}
            </p>
            <p>
              {state.phase === "error"
                ? "授权未完成。原凭证已保留，可重新登录。"
                : state.phase === "cancelled"
                  ? "登录已取消。"
                  : "请在浏览器完成授权，完成后会自动返回模型选择。"}
            </p>
            {state.instructions && <p>{state.instructions}</p>}
            {state.prompt && <p>{state.prompt.message}</p>}
            {state.url && ["waiting", "prompt"].includes(state.phase) && (
              <button
                onClick={() =>
                  void perform("open_login_url", { attempt: state.attempt })
                }
              >
                打开授权页面
              </button>
            )}
            {state.prompt?.browser && (
              <button
                onClick={() =>
                  void perform("open_login_browser", {
                    attempt: state.attempt,
                    prompt: state.prompt!.id,
                  })
                }
              >
                打开独立登录窗口
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
                }}
              >
                重新选择账户
              </button>
            )}
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
