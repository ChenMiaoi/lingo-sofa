import { settingRow as row } from "./SettingRow.js";
import type { SettingsPreferences } from "./useSettingsPreferences.js";
export function AppearancePreferences({
  preferences,
}: {
  preferences: SettingsPreferences;
}) {
  const { theme, busy, saveTheme, settings } = preferences;
  return (
    <div className="ls-design-card">
      {row(
        "颜色主题",
        "跟随系统，或选择浅色与深色。",
        <select
          aria-label="颜色主题"
          value={theme}
          disabled={busy || !settings}
          onChange={(event) =>
            void saveTheme(event.target.value as typeof theme)
          }
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>,
      )}
    </div>
  );
}
