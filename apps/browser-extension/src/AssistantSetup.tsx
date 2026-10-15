import * as React from "react";
import { browser } from "wxt/browser";
import { providerCatalogSchema } from "@lingo-sofa/protocol";
import { assistantDownloads } from "@lingo-sofa/local-runtime/release";

export function AssistantSetup() {
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
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
      setStatus("无法连接助手，请完成安装后重试。");
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
      <details>
        <summary>首次安装或授权此浏览器</summary>
        <ol>
          <li>
            <a href={assistantDownloads} target="_blank" rel="noreferrer">
              下载本地助手
            </a>
            ，选择与你的系统和芯片对应的安装包。
          </li>
          <li>
            复制此扩展 ID：<code>{browser.runtime.id}</code>。解压后打开
            Install.command（macOS / Linux）或
            Install.cmd（Windows），在提示中粘贴 ID。
          </li>
          <li>
            安装或新增浏览器授权前，关闭浏览器与
            Discord，等待助手退出，再运行安装程序。完成后重新打开浏览器检测连接。
          </li>
        </ol>
        <p>
          已从 Discord
          安装过助手？仍需运行一次安装程序授权此扩展，已有账户和用量会保留。
        </p>
      </details>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(browser.runtime.id).then(
            () => setStatus("扩展 ID 已复制"),
            () => setStatus("无法复制，请手动选择扩展 ID"),
          );
        }}
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
