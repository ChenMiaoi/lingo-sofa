import { AssistantSetup } from "./AssistantSetup.js";
export function ConnectionPreferences({
  mode,
  setMode,
  onConnected,
}: {
  mode: "bridge" | "direct";
  setMode: (mode: "bridge" | "direct") => void;
  onConnected: () => void;
}) {
  return (
    <>
      <header className="ls-design-heading">
        <h1>连接方式</h1>
        <p>
          选择要配置的服务位置。保存翻译引擎或模型后，后续请求使用对应连接。
        </p>
      </header>
      <section className="ls-design-card" aria-label="连接配置位置">
        <div
          className="connection-modes"
          role="group"
          aria-label="模型连接方式"
        >
          <button
            aria-pressed={mode === "bridge"}
            onClick={() => setMode("bridge")}
          >
            本地助手
          </button>
          <button
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
        <a href="#translation">配置翻译引擎 →</a>
      </section>
      {mode === "bridge" && <AssistantSetup onConnected={onConnected} />}
    </>
  );
}
