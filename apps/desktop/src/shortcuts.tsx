import React, { useState } from "react";
import {
  defaultShortcuts,
  type ShortcutBindings,
  type ShortcutSnapshot,
} from "./api";
import type { Perform } from "./view";

const fields = [
  ["input", "唤出输入面板"],
  ["selection", "翻译当前选区"],
  ["clipboard", "翻译剪贴板"],
] as const;

export function ShortcutSettings({
  snapshot,
  notice,
  perform,
}: {
  snapshot: ShortcutSnapshot;
  notice: string;
  perform: Perform;
}) {
  const [draft, setDraft] = useState<ShortcutBindings>(snapshot.bindings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <section className="shortcut-settings" aria-label="全局快捷键">
      <h2>全局快捷键</h2>
      <p id="shortcut-help">
        填写组合，例如 Ctrl+Alt+Q。支持字母、数字、Space 和 F1–F24，须包含 Ctrl
        或 Alt。
      </p>
      {fields.map(([name, label], index) => (
        <div className="shortcut-row" key={name}>
          <label htmlFor={`shortcut-${name}`}>{label}</label>
          <input
            id={`shortcut-${name}`}
            aria-describedby="shortcut-help"
            maxLength={48}
            value={draft[name]}
            spellCheck={false}
            disabled={saving}
            onChange={(e) => {
              setDraft({ ...draft, [name]: e.target.value });
              setDirty(true);
            }}
          />
          <span
            className={
              snapshot.registered[index]
                ? "shortcut-ready"
                : "shortcut-unavailable"
            }
          >
            {draft[name] !== snapshot.bindings[name]
              ? "待保存"
              : snapshot.registered[index]
                ? "已启用"
                : "未启用"}
          </span>
        </div>
      ))}
      <div className="shortcut-buttons">
        <button
          disabled={saving}
          onClick={() => {
            setDraft({ ...defaultShortcuts });
            setDirty(true);
          }}
        >
          恢复默认
        </button>
        <button
          disabled={saving || (!dirty && snapshot.registered.every(Boolean))}
          onClick={async () => {
            setSaving(true);
            try {
              await perform("save_shortcuts", { bindings: draft });
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "正在保存…" : "保存快捷键"}
        </button>
      </div>
      <p role="status" className="shortcut-status">
        {notice ||
          (dirty
            ? "修改尚未保存，原快捷键继续生效。"
            : snapshot.message || "修改后保存，即时生效并在重启后保留。")}
      </p>
      {snapshot.registered.includes(false) && (
        <p className="shortcut-warning">
          未启用的组合可能被其他应用占用或由系统保留，请更换后保存。仍可使用边缘入口或托盘。
        </p>
      )}
    </section>
  );
}
