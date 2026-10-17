import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { settingsSchema, type Settings } from "@lingo-sofa/protocol";
import { colorTheme } from "./appearance.js";
export async function sendSettingsMessage(message: unknown) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败");
  return reply;
}
export function useSettingsPreferences() {
  const [settings, setSettings] = useState<Settings>();
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      browser.storage.local.get("uiTheme"),
      sendSettingsMessage({ action: "state", localOnly: true }),
    ])
      .then(([appearance, state]) => {
        if (active) {
          setTheme(colorTheme(appearance.uiTheme));
          setSettings(settingsSchema.parse(state.settings));
        }
      })
      .catch(() => {
        if (active) setFailure("无法读取设置，请重新打开设置页。");
      });
    const changed = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes.uiTheme) setTheme(colorTheme(changes.uiTheme.newValue));
      if (changes.settings) {
        const next = settingsSchema.safeParse(changes.settings.newValue);
        if (next.success) setSettings(next.data);
      }
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function save(
    operation: () => Promise<void>,
    success: string,
    fallback: string,
  ) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setNotice("");
    setFailure("");
    try {
      await operation();
      setNotice(success);
      return true;
    } catch (reason) {
      setFailure(
        reason instanceof Error ? `${fallback}：${reason.message}` : fallback,
      );
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function update(patch: Partial<Settings>) {
    if (!settings) return false;
    return save(
      async () => {
        const current = await sendSettingsMessage({
          action: "state",
          localOnly: true,
        });
        const next = settingsSchema.parse({ ...current.settings, ...patch });
        await sendSettingsMessage({ action: "save", settings: next });
        setSettings(next);
      },
      "所有更改已保存",
      "保存失败，请重试",
    );
  }
  const saveTheme = (next: typeof theme) =>
    save(
      async () => {
        await browser.storage.local.set({ uiTheme: next });
        setTheme(next);
      },
      "外观已保存",
      "外观保存失败，请重试",
    );
  const clearData = () =>
    save(
      async () => {
        await sendSettingsMessage({ action: "clear" });
      },
      "缓存、会话与用量已清除",
      "清理失败，请重试",
    );
  return {
    settings,
    theme,
    notice,
    failure,
    busy,
    setNotice,
    update,
    saveTheme,
    clearData,
  };
}
export type SettingsPreferences = ReturnType<typeof useSettingsPreferences>;
