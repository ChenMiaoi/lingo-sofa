import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { readingOrigins } from "./site-access.js";

export function ReadingAccess({
  compact = false,
  detailed = true,
  prominent = true,
}: {
  compact?: boolean;
  detailed?: boolean;
  prominent?: boolean;
}) {
  const [dismissed, setDismissed] = useState<boolean>();
  const [expanded, setExpanded] = useState(detailed);
  const [opened, setOpened] = useState(false);
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (compact) return;
    void browser.storage.local
      .get("readingAccessPromptDismissed")
      .then((value) =>
        setDismissed(value.readingAccessPromptDismissed === true),
      )
      .catch(() => setDismissed(false));
  }, [compact]);
  useEffect(() => {
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void browser.permissions
        .contains({ origins: readingOrigins })
        .then((granted) => {
          if (request === revision) setNeeded(!granted);
        })
        .catch(() => {
          if (request === revision) setNeeded(true);
        });
    };
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      revision++;
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
        在所有网站自动显示悬浮球 ↗
      </a>
    );
  if (dismissed === undefined) return null;
  if (!detailed && !opened && (dismissed || !prominent))
    return (
      <button
        className="reading-access-restore"
        onClick={() => {
          setOpened(true);
          setExpanded(false);
        }}
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
        <button
          disabled={busy}
          onClick={() => {
            void browser.storage.local
              .set({ readingAccessPromptDismissed: true })
              .then(() => {
                setDismissed(true);
                setOpened(false);
                setError("");
              })
              .catch(() => setError("无法保存此选择，请重试。"));
          }}
        >
          稍后
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
