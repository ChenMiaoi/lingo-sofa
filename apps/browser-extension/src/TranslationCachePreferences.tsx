import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  cachePreferences,
  type CachePreferences,
} from "./translation-cache.js";

export function TranslationCachePreferences() {
  const [preferences, setPreferences] = useState<CachePreferences>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const initial = revision.current;
    void browser.runtime
      .sendMessage({ action: "translation-cache-state" })
      .then((reply) => {
        if (!reply.ok) throw new Error(reply.error);
        if (active && revision.current === initial)
          setPreferences(cachePreferences(reply.preferences));
      })
      .catch(() => {
        if (active && revision.current === initial)
          setError("无法读取译文缓存设置");
      });
    const changed = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area === "local" && changes.translationCachePreferences) {
        revision.current++;
        setPreferences(
          cachePreferences(changes.translationCachePreferences.newValue),
        );
      }
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function save(patch: Partial<CachePreferences>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const before = revision.current;
      const reply = await browser.runtime.sendMessage({
        action: "translation-cache-update",
        preferences: patch,
      });
      if (!reply.ok) throw new Error(reply.error);
      if (revision.current === before)
        setPreferences(cachePreferences(reply.preferences));
      setMessage("缓存设置已保存，旧缓存已清理。");
    } catch {
      setError("缓存设置保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="ls-design-card"
      aria-label="本地译文缓存"
      data-setting="translation-cache"
    >
      <h2>本地译文缓存</h2>
      <p>
        重复打开网页时直接复用译文，减少 API 请求。仅保存在本浏览器，最多 1,000
        段、约 2 MB；到期或容量不足时清理。
      </p>
      <div className="ls-setting-row">
        <div>
          <strong>跨页面复用译文</strong>
          <small>
            按网站、账户、模型、语言、正文与上下文匹配；问答不缓存。
          </small>
        </div>
        <select
          aria-label="跨页面复用译文"
          disabled={busy || !preferences}
          value={String(preferences?.enabled ?? true)}
          onChange={(event) =>
            void save({
              enabled: event.target.value === "true",
            })
          }
        >
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      </div>
      <div className="ls-setting-row">
        <div>
          <strong>译文保留时长</strong>
          <small>
            从翻译完成开始计时，重复查看不会延长。修改设置会清理旧缓存。
          </small>
        </div>
        <select
          aria-label="译文保留时长"
          disabled={busy || !preferences?.enabled}
          value={preferences?.days ?? 7}
          onChange={(event) => void save({ days: Number(event.target.value) })}
        >
          {[1, 7, 30].map((days) => (
            <option key={days} value={days}>
              {days} 天
            </option>
          ))}
        </select>
      </div>
      <p>
        缓存中包含译文。关闭或清理会删除本浏览器保存的缓存，用量记录另行保留。
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          setMessage("");
          void browser.runtime
            .sendMessage({ action: "translation-cache-clear" })
            .then((reply) => {
              if (!reply.ok) throw new Error(reply.error);
              setMessage("本浏览器译文缓存已清除。");
            })
            .catch(() => setError("缓存清理失败，请重试。"))
            .finally(() => setBusy(false));
        }}
      >
        清除本浏览器译文缓存
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
