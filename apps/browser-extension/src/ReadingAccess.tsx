import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { readingOrigins } from "./site-access.js";

export function ReadingAccess({
  compact = false,
  detailed = true,
}: {
  compact?: boolean;
  detailed?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(detailed);
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => {
      void browser.permissions
        .contains({ origins: readingOrigins })
        .then((granted) => setNeeded(!granted))
        .catch(() => setNeeded(true));
    };
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, []);
  if (!needed) return null;
  if (compact)
    return (
      <a
        className="quick-reading-access"
        href={browser.runtime.getURL("/options.html?setup=reading")}
        target="_blank"
        rel="noreferrer"
      >
        让悬浮球自动显示 ↗
      </a>
    );
  if (dismissed)
    return (
      <button
        className="reading-access-restore"
        onClick={() => setDismissed(false)}
      >
        设置网页悬浮球
      </button>
    );
  return (
    <section
      className={
        expanded ? "permission-card" : "permission-card permission-banner"
      }
      aria-label="网页悬浮入口授权"
    >
      {expanded ? (
        <h2>让悬浮球自动出现在网页上</h2>
      ) : (
        <strong>随时在网页上打开翻译与问答</strong>
      )}
      {expanded && (
        <p className="muted">
          首次允许网页访问后，打开网页即可使用悬浮入口。显示入口不会发送正文；自动翻译由你在各网站的悬浮面板中开启。
        </p>
      )}
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          // Start the native permission request directly inside this click.
          const request = browser.permissions.request({
            origins: readingOrigins,
          });
          setBusy(true);
          setError("");
          void request
            .then(async (granted) => {
              if (!granted)
                throw new Error(
                  "尚未获得网页访问权限，你仍可点击扩展图标临时打开当前页的入口。",
                );
              const reply = await browser.runtime.sendMessage({
                action: "reading-access-sync",
              });
              if (!reply.ok) throw new Error(reply.error);
              setNeeded(false);
            })
            .catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "网页授权失败，请重试",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        启用网页悬浮球
      </button>
      {!expanded && <button onClick={() => setExpanded(true)}>了解权限</button>}
      {!detailed && (
        <button disabled={busy} onClick={() => setDismissed(true)}>
          稍后
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
