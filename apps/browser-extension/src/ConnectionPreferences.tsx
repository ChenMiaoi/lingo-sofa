import { useCallback, useState } from "react";
import { AssistantSetup } from "./AssistantSetup.js";
import { AccountMigration } from "./AccountMigration.js";
import { sendSettingsMessage } from "./settings-message.js";

export function ConnectionPreferences({
  activeMode,
  onConnected,
}: {
  activeMode: "bridge" | "direct" | undefined;
  onConnected: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const detected = useCallback(() => setConnected(true), []);
  return (
    <>
      <header className="ls-design-heading">
        <h1>共享账户</h1>
        <p>模型账户统一保存在本地助手，在浏览器和 Discord 修改后共同生效。</p>
      </header>
      <section className="ls-design-card" aria-label="共享模型账户">
        <p className="ls-active-connection" role="status">
          {activeMode === "bridge"
            ? "当前使用：共享本地助手"
            : "免 Key 翻译可独立使用；大模型需要共享助手"}
        </p>
        <p>助手未连接时不会读取旧 Key 或自动改用另一份模型账户。</p>
        {activeMode !== "bridge" && (
          <button
            className="ls-solid-button"
            disabled={!connected || busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void sendSettingsMessage({ action: "account-use-shared" })
                .then(onConnected)
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "连接失败，请重试",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "正在连接…" : "使用共享账户"}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        <a href="#translation">配置翻译引擎 →</a>
      </section>
      <AssistantSetup onConnected={detected} />
      <AccountMigration full onMigrated={onConnected} />
    </>
  );
}
