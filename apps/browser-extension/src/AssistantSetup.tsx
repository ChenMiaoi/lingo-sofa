import * as React from "react";
import { browser } from "wxt/browser";
import { providerCatalogSchema } from "@lingo-sofa/protocol";
import { assistantDownloads } from "@lingo-sofa/local-runtime/release";

import {
  assistantAuthorizationCommand,
  type AssistantPlatform,
} from "./assistant-command";

export function AssistantSetup() {
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [platform, setPlatform] = React.useState<AssistantPlatform>("win");
  React.useEffect(() => {
    void browser.runtime
      .getPlatformInfo()
      .then(({ os }) => {
        setPlatform(os === "mac" ? "mac" : os === "win" ? "win" : "linux");
      })
      .catch(() => {});
  }, []);
  const command = assistantAuthorizationCommand(platform, browser.runtime.id);
  function copy(value: string, success: string) {
    void navigator.clipboard.writeText(value).then(
      () => setStatus(success),
      () => setStatus("无法复制，请手动选择并复制"),
    );
  }
  async function check() {
    setBusy(true);
    setStatus("正在检测本地助手…");
    try {
      const reply = await browser.runtime.sendMessage({
        action: "provider-catalog",
        mode: "bridge",
      });
      if (reply?.ok === false) throw new Error(reply.error ?? "助手连接失败");
      providerCatalogSchema.parse(reply);
      setStatus("已连接共享本地助手");
    } catch {
      setStatus(
        "无法连接助手。已安装助手请先授权此浏览器；尚未安装请下载助手。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="本地助手安装" className="settings-card">
      <h2>共享本地助手</h2>
      <p>
        浏览器、Discord
        与其他客户端共用此电脑上的一个助手。首次使用只需安装一次，无需另装
        Node。
      </p>
      <h3>已有本地助手？快速授权此浏览器</h3>
      <p>
        从 Discord 安装过助手也适用，无需重复下载。扩展 ID：
        <code>{browser.runtime.id}</code>
      </p>
      <label>
        终端平台{" "}
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
      <ol>
        <li>
          复制下方命令，关闭浏览器与 Discord，等待助手退出（通常约 60 秒）。
        </li>
        <li>
          在所选系统的终端粘贴并运行命令，完成后重新打开浏览器，点击“检测连接”。
        </li>
      </ol>
      <textarea
        aria-label="浏览器授权命令"
        readOnly
        value={command}
        rows={5}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      <button type="button" onClick={() => copy(command, "授权命令已复制")}>
        复制授权命令
      </button>
      <p>
        命令使用助手自带的运行环境，保留已有账户和用量。自定义安装目录沿用
        LINGO_SOFA_HOME。旧版助手若提示找不到授权入口，请更新助手后再授权。
      </p>
      <details>
        <summary>尚未安装助手？下载并安装</summary>
        <ol>
          <li>
            <a href={assistantDownloads} target="_blank" rel="noreferrer">
              下载本地助手
            </a>
            ，选择与你的系统和芯片对应的安装包。
          </li>
          <li>复制扩展 ID，关闭浏览器与 Discord，等待助手退出。</li>
          <li>
            解压助手包，Windows 打开 Install.cmd；macOS 打开
            Install.command；Linux 在终端运行 sh Install.command。在提示中粘贴
            ID。
          </li>
          <li>完成后重新打开浏览器，点击“检测连接”。无需另装 Node。</li>
        </ol>
      </details>
      <button
        type="button"
        onClick={() => copy(browser.runtime.id, "扩展 ID 已复制")}
      >
        复制扩展 ID
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void check()}>
        检测连接
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
