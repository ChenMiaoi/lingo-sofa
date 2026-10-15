import { providerAuthStyles } from "./provider-auth-styles.js";
import type { OAuthStatus } from "@lingo-sofa/protocol";
/** Host-injected React keeps the Discord renderer on its own React instance. */
// React 18 (Discord) and React 19 (extension) have different branded Effect types.
// Describe only the public hooks used here so neither host needs a second React runtime.
interface HostReact {
  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void];
  useEffect(
    effect: () => void | (() => void),
    dependencies: readonly unknown[],
  ): void;
  useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: readonly unknown[],
  ): T;
  useRef<T>(initial: T): { current: T };
  createElement: (...args: never[]) => unknown;
}
export function createProviderAuth(React: HostReact) {
  return function ProviderAuth({
    mode,
    onMode,
    request,
    disabled = false,
    onStatus,
  }: {
    mode: "api_key" | "subscription";
    onMode: (mode: "api_key" | "subscription") => void;
    request: (
      action: "start" | "status" | "cancel" | "logout",
    ) => Promise<OAuthStatus>;
    disabled?: boolean;
    onStatus?: (status: OAuthStatus) => void;
  }) {
    const [status, setStatus] = React.useState<OAuthStatus>({
      connected: false,
      phase: "idle",
    });
    React.useEffect(() => {
      onStatus?.(status);
    }, [status, onStatus]);
    const generation = React.useRef(0);
    const acting = React.useRef(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const refresh = React.useCallback(async () => {
      try {
        setStatus(await request("status"));
      } catch {
        setError("无法读取 ChatGPT 登录状态，请检查本地助手。");
      }
    }, [request]);
    React.useEffect(() => {
      let active = true;
      const poll = async () => {
        try {
          const version = generation.current;
          const next = await request("status");
          if (active && !acting.current && version === generation.current)
            setStatus(next);
        } catch {
          /* Preserve the last known connection while the Bridge reconnects. */
        }
      };
      void poll();
      const timer = setInterval(() => void poll(), 1500);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [request]);
    async function act(action: "start" | "cancel" | "logout") {
      if (acting.current) return;
      acting.current = true;
      generation.current++;
      setBusy(true);
      setError("");
      try {
        setStatus(await request(action));
      } catch {
        setError("操作未完成，请检查本地助手后重试。");
      } finally {
        acting.current = false;
        generation.current++;
        setBusy(false);
      }
    }
    return (
      <section className="lingo-sofa-auth" aria-label="OpenAI 登录方式">
        <style>{providerAuthStyles}</style>
        <div
          role="group"
          aria-label="OpenAI 登录方式"
          className="lingo-sofa-auth-modes"
        >
          <button
            type="button"
            aria-pressed={mode === "subscription"}
            disabled={disabled || busy}
            onClick={() => onMode("subscription")}
          >
            ChatGPT 订阅
          </button>
          <button
            type="button"
            aria-pressed={mode === "api_key"}
            disabled={disabled || busy}
            onClick={() => onMode("api_key")}
          >
            API Key
          </button>
        </div>
        {mode === "subscription" && (
          <div className="lingo-sofa-auth-account">
            <div>
              <strong>使用你的 ChatGPT 订阅</strong>
              <p role="status">
                {status.connected
                  ? "已连接 · 网页与 Discord 共用"
                  : status.phase === "pending"
                    ? "等待浏览器授权…"
                    : "尚未连接 ChatGPT"}
              </p>
            </div>
            <p className="lingo-sofa-auth-note">
              在 OpenAI 页面登录并授权。凭据仅保存在本机助手；使用量按实际
              Tokens 显示 API 等值费用。
            </p>
            {status.authorizationUrl && status.phase === "pending" && (
              <a
                href={status.authorizationUrl}
                target="_blank"
                rel="noreferrer"
              >
                继续前往 ChatGPT 授权 ↗
              </a>
            )}
            <div className="lingo-sofa-auth-actions">
              {status.phase === "pending" ? (
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act("cancel")}
                >
                  取消登录
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act("start")}
                >
                  {status.connected ? "重新连接 ChatGPT" : "使用 ChatGPT 登录"}
                </button>
              )}
              {status.connected && (
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act("logout")}
                >
                  退出本机登录
                </button>
              )}
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => void refresh()}
              >
                刷新状态
              </button>
            </div>
            <small>
              退出仅移除本机凭据；远端授权可在 ChatGPT
              设置中管理。登录后保存配置才启用订阅翻译。
            </small>
            {(error || status.error) && (
              <p role="alert">{error || status.error}</p>
            )}
          </div>
        )}
      </section>
    );
  };
}
