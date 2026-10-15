import { React } from "@webpack/common";
export interface UpdateClient {
  checkUpdate(): Promise<{ version: string } | null>;
  downloadUpdate(): Promise<unknown>;
  applyUpdate(): Promise<void>;
}
export function UpdateSettings({
  native: Native,
}: {
  native: UpdateClient | undefined;
}) {
  const [version, setVersion] = React.useState<string | null>(null);
  const [downloaded, setDownloaded] = React.useState(false);
  const [action, setAction] = React.useState<
    "check" | "download" | "apply" | null
  >(null);
  const [failed, setFailed] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const busy = action !== null;
  async function perform(action: "check" | "download" | "apply") {
    if (busy) return;
    setAction(action);
    setFailed(false);
    try {
      if (!Native) throw new Error("本地更新入口不可用");
      if (action === "check") {
        const update = await Native.checkUpdate();
        setVersion(update?.version ?? null);
        setDownloaded(false);
        setNotice(
          update
            ? `发现 LingoSofa ${update.version}`
            : "当前已是最新可用安装版本",
        );
      } else if (action === "download") {
        await Native.downloadUpdate();
        setDownloaded(true);
        setNotice(
          "下载和校验完成。安装时将退出 Discord；请同时关闭使用助手的浏览器。",
        );
      } else {
        await Native.applyUpdate();
        setNotice(
          "Discord 即将退出。安装完成后会自动启动 Discord；请先关闭使用助手的浏览器。",
        );
      }
    } catch (error) {
      setFailed(true);
      setNotice(
        error instanceof Error ? error.message : "更新失败，请稍后重试",
      );
    } finally {
      setAction(null);
    }
  }
  return (
    <section
      className="lingo-sofa-panel lingo-sofa-maintenance"
      aria-label="LingoSofa 更新"
      aria-busy={busy}
    >
      <h3>LingoSofa 更新</h3>
      <p>
        Windows x64：一起更新 LingoSofa、Vencord 和本地助手，保留账户与配置。
      </p>
      <div className="lingo-sofa-update-actions">
        <button
          type="button"
          disabled={busy || !Native}
          onClick={() => void perform("check")}
        >
          {action === "check" ? "正在检查…" : "检查更新"}
        </button>
        {version && !downloaded && (
          <button
            type="button"
            className="lingo-sofa-primary"
            disabled={busy || !Native}
            onClick={() => void perform("download")}
          >
            {action === "download" ? "正在下载并校验…" : `下载 ${version}`}
          </button>
        )}
        {downloaded && (
          <button
            type="button"
            className="lingo-sofa-primary"
            disabled={busy || !Native}
            onClick={() => void perform("apply")}
          >
            {action === "apply" ? "正在准备安装…" : "退出 Discord 并安装更新"}
          </button>
        )}
      </div>
      <p
        className="lingo-sofa-maintenance-status"
        role={failed ? "alert" : "status"}
        aria-live="polite"
      >
        {busy
          ? action === "download"
            ? "正在下载完整安装包并校验，请稍候。"
            : "正在处理更新…"
          : notice ||
            (!Native
              ? "当前客户端无法使用本地更新。"
              : "检查新版本后，可在此下载安装。")}
      </p>
    </section>
  );
}
