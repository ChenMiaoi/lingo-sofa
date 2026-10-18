import { useState } from "react";
import { TranslationCachePreferences } from "./TranslationCachePreferences.js";
import { settingRow as row } from "./SettingRow.js";
import type { SettingsPreferences } from "./useSettingsPreferences.js";
import {
  cleanupLabels,
  type CleanupResult,
  type CleanupTarget,
} from "./data-cleanup.js";
export function PrivacyPreferences({
  preferences,
}: {
  preferences: SettingsPreferences;
}) {
  const { settings, busy, update, clearData } = preferences;
  const [confirmClear, setConfirmClear] = useState(false);
  const [results, setResults] = useState<CleanupResult[]>([]);
  const failed = results.filter((item) => !item.ok).map((item) => item.target);
  async function clear(targets?: CleanupTarget[]) {
    const next = await clearData(targets);
    if (!next) return;
    setConfirmClear(false);
    setResults(
      targets
        ? results.map(
            (item) =>
              next.find((updated) => updated.target === item.target) ?? item,
          )
        : next,
    );
  }
  return (
    <>
      <TranslationCachePreferences />
      {settings?.mode === "bridge" && (
        <p className="ls-info-note">
          下方保存偏好用于浏览器本地记录。本地助手的记录保留策略由助手管理，可在用量页查看当前保留范围。
        </p>
      )}
      <div className="ls-design-card">
        {row(
          "上下文范围",
          "Ask 仅发送所选内容与本次对话。",
          <span className="ls-readonly-value">由你明确选择</span>,
          "privacy-context",
        )}
        {row(
          "持久保存用量",
          "关闭时仅在当前浏览器会话中保存。切换会保留现有记录，不中断请求。",
          <select
            aria-label="持久保存用量"
            value={String(settings?.persistUsage ?? false)}
            disabled={busy || !settings}
            onChange={(event) =>
              void update({
                persistUsage: event.target.value === "true",
              })
            }
          >
            <option value="false">关闭</option>
            <option value="true">开启</option>
          </select>,
          "persist-usage",
        )}
        {row(
          "历史保留天数",
          "仅在开启持久保存时生效，到期记录自动清理。",
          <select
            aria-label="历史保留天数"
            value={settings?.retentionDays ?? 30}
            disabled={busy || !settings || !settings.persistUsage}
            onChange={(event) =>
              void update({
                retentionDays: Number(event.target.value),
              })
            }
          >
            {[...new Set([7, 30, 90, settings?.retentionDays ?? 30])]
              .sort((a, b) => a - b)
              .map((days) => (
                <option key={days} value={days}>
                  {days} 天
                </option>
              ))}
          </select>,
          "retention-days",
        )}
        {row(
          "统计时区",
          "用于划分每日与每月的用量记录。",
          <select
            aria-label="统计时区"
            value={settings?.timeZone ?? "Asia/Shanghai"}
            disabled={busy || !settings}
            onChange={(event) => void update({ timeZone: event.target.value })}
          >
            {[
              ...new Set([
                settings?.timeZone ?? "Asia/Shanghai",
                Intl.DateTimeFormat().resolvedOptions().timeZone,
                "Asia/Shanghai",
                "UTC",
                "America/Los_Angeles",
                "Europe/London",
              ]),
            ].map((zone) => (
              <option key={zone}>{zone}</option>
            ))}
          </select>,
          "time-zone",
        )}
      </div>
      <section
        className="ls-design-card ls-data-clear"
        aria-label="清理本地数据"
        data-setting="clear-data"
      >
        <h2>清理数据</h2>
        <p>
          清除当前执行模式下的译文缓存、问答会话与用量记录，正在执行的请求也会停止。此操作无法撤销。
        </p>
        <p className="ls-muted">
          范围：浏览器译文缓存、浏览器会话与用量
          {settings?.mode === "bridge"
            ? "，以及本地助手中的浏览器会话与用量"
            : ""}
          。
        </p>
        {!!results.length && (
          <ul className="ls-cleanup-results" aria-label="数据清理结果">
            {results.map((item) => (
              <li
                key={item.target}
                data-result={item.ok ? "success" : "failed"}
              >
                <strong>
                  {cleanupLabels[item.target]} · {item.ok ? "已清除" : "未完成"}
                </strong>
                {item.error && <small>{item.error}</small>}
              </li>
            ))}
          </ul>
        )}
        <div className="ls-actions">
          {!!failed.length && (
            <button disabled={busy} onClick={() => void clear(failed)}>
              仅重试未完成项目
            </button>
          )}
          {confirmClear ? (
            <>
              <button
                disabled={busy}
                className="ls-danger-button"
                onClick={() => void clear()}
              >
                确认清除
              </button>
              <button disabled={busy} onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="ls-danger-button"
              onClick={() => setConfirmClear(true)}
            >
              清除缓存、会话与用量
            </button>
          )}
        </div>
      </section>
    </>
  );
}
