import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { readingOrigins } from "./site-access.js";

export function ReadingAccess() {
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void browser.permissions
      .contains({ origins: readingOrigins })
      .then((granted) => setNeeded(!granted))
      .catch(() => setNeeded(true));
  }, []);
  if (!needed) return null;
  return (
    <section className="permission-card" aria-label="网页悬浮入口授权">
      <h2>让悬浮球自动出现在网页上</h2>
      <p className="muted">
        首次允许网页访问后，打开网页即可使用悬浮入口。显示入口不会发送正文；自动翻译由你在各网站的悬浮面板中开启。
      </p>
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
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
