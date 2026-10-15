import * as React from "react";
import { browser } from "wxt/browser";
import { assistantConnectionSchema } from "@lingo-sofa/protocol";
import { assistantDownloads } from "@lingo-sofa/local-runtime/release";
import {
  assistantAuthorizationCommand,
  type AssistantPlatform,
} from "./assistant-command";

type Connection = "checking" | "connected" | "offline";
export function AssistantSetup({ onConnected }: { onConnected?: () => void }) {
  const [connection, setConnection] = React.useState<Connection>("checking");
  const [installed, setInstalled] = React.useState<boolean | null>(null);
  const [version, setVersion] = React.useState<string>();
  const [notice, setNotice] = React.useState("");
  const [platform, setPlatform] = React.useState<AssistantPlatform>("win");
  const wasConnected = React.useRef(false);
  const check = React.useCallback(async () => {
    setConnection("checking");
    setNotice("");
    try {
      const reply = assistantConnectionSchema.parse(
        await browser.runtime.sendMessage({ action: "assistant-status" }),
      );
      if (reply.installed !== null) setInstalled(reply.installed);
      setVersion(reply.version);
      setConnection(reply.connected ? "connected" : "offline");
      if (reply.connected && !wasConnected.current) onConnected?.();
      wasConnected.current = reply.connected;
    } catch {
      wasConnected.current = false;
      setConnection("offline");
      setNotice("检测暂不可用，可按下方指引连接后重试。");
    }
  }, [onConnected]);
  React.useEffect(() => {
    void Promise.all([
      browser.runtime.getPlatformInfo(),
      browser.storage.local.get("assistantInstalled"),
    ])
      .then(([{ os }, saved]) => {
        setPlatform(os === "mac" ? "mac" : os === "win" ? "win" : "linux");
        if (typeof saved.assistantInstalled === "boolean")
          setInstalled(saved.assistantInstalled);
      })
      .catch(() => undefined)
      .then(() => check());
    const focus = () => {
      void check();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [check]);
  function choose(value: boolean) {
    setInstalled(value);
    setNotice("");
    void browser.storage.local
      .set({ assistantInstalled: value })
      .catch(() => setNotice("选择未能保存，下次打开时请重新选择。"));
  }
  function copy(value: string, success: string) {
    void navigator.clipboard.writeText(value).then(
      () => setNotice(success),
      () => setNotice("无法复制，请手动选择代码复制"),
    );
  }
  const command = assistantAuthorizationCommand(platform, browser.runtime.id);
  if (connection !== "offline")
    return (
      <section
        className="assistant-connection"
        aria-label="本地助手状态"
        aria-busy={connection === "checking"}
      >
        <div>
          <span className={`assistant-dot ${connection}`} />
          <strong>
            {connection === "checking" ? "正在检测本地助手…" : "本地助手已连接"}
          </strong>
          {connection === "connected" && (
            <small>{version ? `助手 v${version}` : "助手版本未提供"}</small>
          )}
        </div>
        {connection === "connected" && (
          <button type="button" onClick={() => void check()}>
            重新检测
          </button>
        )}
      </section>
    );
  return (
    <section
      aria-label="本地助手安装"
      className="settings-card assistant-setup"
    >
      <header className="assistant-heading">
        <div>
          <span className="assistant-eyebrow">本机连接</span>
          <h2>
            {installed === false
              ? "安装本地助手"
              : installed === true
                ? "连接已有助手"
                : "连接本地助手"}
          </h2>
        </div>
        <span className="assistant-state">未连接</span>
      </header>
      <p className="assistant-intro">
        浏览器与 Discord 共用一个助手和模型账户。
      </p>
      {installed === null ? (
        <>
          <p>尚无法确认这台电脑是否已安装助手，请选择你的情况。</p>
          <div className="assistant-choices">
            <button type="button" onClick={() => choose(true)}>
              <strong>已安装助手</strong>
              <small>包括从 Discord 安装，只需授权连接</small>
            </button>
            <button type="button" onClick={() => choose(false)}>
              <strong>首次安装</strong>
              <small>下载一次，之后所有客户端共用</small>
            </button>
          </div>
        </>
      ) : installed ? (
        <>
          <ol className="assistant-steps">
            <li>复制命令，在终端粘贴运行，无需关闭浏览器或 Discord。</li>
            <li>运行完成后，回到此页点击“检测连接”。</li>
          </ol>
          <div className="assistant-code">
            <div className="assistant-code-toolbar">
              <label>
                终端平台
                <select
                  value={platform}
                  onChange={(event) =>
                    setPlatform(event.target.value as AssistantPlatform)
                  }
                >
                  <option value="win">Windows · PowerShell</option>
                  <option value="mac">macOS · 终端</option>
                  <option value="linux">Linux · 终端</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => copy(command, "授权命令已复制")}
              >
                复制命令
              </button>
            </div>
            <pre tabIndex={0} aria-label="浏览器授权命令">
              <code>{command}</code>
            </pre>
          </div>
          <p className="assistant-note">
            命令已包含扩展 ID，使用助手自带的运行环境，保留账户与用量。
          </p>
          <details className="assistant-help">
            <summary>运行命令遇到问题？</summary>
            <p>
              提示找不到授权入口或要求关闭客户端时，请先升级旧版助手。自定义目录需在终端设置
              LINGO_SOFA_HOME。
            </p>
            <p>
              扩展 ID：<code>{browser.runtime.id}</code>
            </p>
            <button
              type="button"
              onClick={() => copy(browser.runtime.id, "扩展 ID 已复制")}
            >
              复制扩展 ID
            </button>
            <button type="button" onClick={() => choose(false)}>
              这台电脑尚未安装助手
            </button>
          </details>
        </>
      ) : (
        <>
          <ol className="assistant-steps">
            <li>
              <a href={assistantDownloads} target="_blank" rel="noreferrer">
                下载本地助手 ↗
              </a>
              <span>
                选择与你的系统和芯片对应的安装包，自带 Node，无需额外安装。
              </span>
            </li>
            <li>
              <strong>复制扩展 ID</strong>
              <div className="assistant-id">
                <code>{browser.runtime.id}</code>
                <button
                  type="button"
                  onClick={() => copy(browser.runtime.id, "扩展 ID 已复制")}
                >
                  复制 ID
                </button>
              </div>
            </li>
            <li>
              <strong>解压助手包并运行安装入口</strong>
              <span>
                Windows：Install.cmd；macOS：Install.command；Linux：sh
                Install.command。在提示中粘贴扩展 ID。
              </span>
            </li>
            <li>完成后回到此页，点击“检测连接”。</li>
          </ol>
          <p className="assistant-note">
            如果是升级已有助手，需要在安装器准备完成后退出连接的客户端。
          </p>
          <button
            type="button"
            className="assistant-text-action"
            onClick={() => choose(true)}
          >
            已经安装了？直接授权连接
          </button>
        </>
      )}
      <footer className="assistant-footer">
        <button type="button" className="primary" onClick={() => void check()}>
          检测连接
        </button>
        <p role="status" aria-live="polite">
          {notice}
        </p>
      </footer>
    </section>
  );
}
