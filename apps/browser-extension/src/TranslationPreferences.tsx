import * as React from "react";
import { createAISettings, type AISettingsClient } from "@lingo-sofa/ui-shared";
import { BilingualPreview } from "./BilingualPreview.js";
import { settingRow as row } from "./SettingRow.js";
import type { SettingsPreferences } from "./useSettingsPreferences.js";
const AISettings = createAISettings(() => React);
export function TranslationPreferences({
  preferences,
  ready,
  client,
}: {
  preferences: SettingsPreferences;
  ready: boolean;
  client: AISettingsClient;
}) {
  const { settings, busy, update } = preferences;
  return (
    <>
      {ready && <AISettings client={client} section="translation" embedded />}
      <div className="ls-reading-settings">
        <div className="ls-design-card">
          {row(
            "目标语言",
            "原文语言自动识别。",
            <select
              aria-label="目标语言"
              value={settings?.targetLanguage ?? "简体中文"}
              disabled={busy || !settings}
              onChange={(event) =>
                void update({ targetLanguage: event.target.value })
              }
            >
              {Array.from(
                new Set([
                  settings?.targetLanguage ?? "简体中文",
                  "简体中文",
                  "繁體中文",
                  "English",
                  "日本語",
                  "한국어",
                  "Français",
                  "Deutsch",
                  "Español",
                ]),
              ).map((language) => (
                <option key={language}>{language}</option>
              ))}
            </select>,
          )}
          {row(
            "显示方式",
            "适用于单行、段落与整页翻译。",
            <span className="ls-readonly-value">双语 · 译文在下</span>,
          )}
        </div>
        <BilingualPreview language={settings?.targetLanguage ?? "简体中文"} />
      </div>
      <div className="ls-reading-start">
        <div>
          <strong>试试双语阅读</strong>
          <p>在网页中点击工具栏的 LingoSofa，再选择“翻译页面”。</p>
        </div>
        <a href="https://example.com" target="_blank" rel="noreferrer">
          打开示例网页 ↗
        </a>
      </div>
      <div className="ls-design-card">
        <h2>网站规则</h2>
        <p>在网页的 LingoSofa 面板中，可为当前网站开启自动翻译。</p>
        {settings?.autoOrigins.length ? (
          settings.autoOrigins.map((origin) =>
            row(
              origin,
              "已开启自动翻译",
              <button
                key={origin}
                disabled={busy}
                onClick={() =>
                  void update({
                    autoOrigins: settings.autoOrigins.filter(
                      (value) => value !== origin,
                    ),
                  })
                }
              >
                关闭自动翻译
              </button>,
            ),
          )
        ) : (
          <p className="ls-muted">自动翻译默认关闭，尚未添加网站。</p>
        )}
        {row(
          "Discord 消息",
          "译文插入同一条消息内，位于原文下方。",
          <span className="ls-readonly-value">在频道面板中设置</span>,
        )}
      </div>
      <p className="ls-info-note">
        ⓘ Ask 只接收明确选择的内容，不会自动读取整个频道。
      </p>
    </>
  );
}
