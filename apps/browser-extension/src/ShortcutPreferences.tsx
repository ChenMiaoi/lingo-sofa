import { settingRow as row } from "./SettingRow.js";
export function ShortcutPreferences() {
  return (
    <div className="ls-design-card">
      {row(
        "快速打开 Ask",
        "选中文字，或将鼠标移到正文段落旁；只打开窗口。",
        <kbd>Alt Shift A</kbd>,
        "ask-shortcut",
      )}
      {row("打开悬浮菜单", "显示翻译、Ask 与设置入口。", <kbd>Alt L</kbd>)}
      {row("收起面板或对话", "关闭后焦点回到入口。", <kbd>Esc</kbd>)}
      {row(
        "移动悬浮入口",
        "先用 Tab 聚焦入口，再使用方向键。",
        <kbd>↑ / ↓</kbd>,
      )}
      {row("Ask 发送消息", "Shift Enter 换行。", <kbd>Enter</kbd>)}
    </div>
  );
}
