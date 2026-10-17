import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { settingsSchema, type Settings } from "@lingo-sofa/protocol";
import { colorTheme } from "./appearance.js";
import { sendSettingsMessage } from "./settings-message.js";
import type { CleanupResult, CleanupTarget } from "./data-cleanup.js";
export function useSettingsPreferences() {
  const [settings, setSettings] = useState<Settings>();
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const settingsRevision = useRef(0);
  const themeRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const initialSettings = settingsRevision.current;
    const initialTheme = themeRevision.current;
    void browser.storage.local
      .get("uiTheme")
      .then((appearance) => {
        if (active && themeRevision.current === initialTheme)
          setTheme(colorTheme(appearance.uiTheme));
      })
      .catch(() => {
        if (active && themeRevision.current === initialTheme)
          setFailure("无法读取外观偏好，其他设置仍可使用。");
      });
    void sendSettingsMessage({ action: "state", localOnly: true })
      .then((state) => {
        if (active && settingsRevision.current === initialSettings)
          setSettings(settingsSchema.parse(state.settings));
      })
      .catch(() => {
        if (active && settingsRevision.current === initialSettings)
          setFailure("无法读取设置，请重新打开设置页。");
      });
    const changed = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes.uiTheme) {
        themeRevision.current++;
        setTheme(colorTheme(changes.uiTheme.newValue));
      }
      if (changes.settings) {
        const next = settingsSchema.safeParse(changes.settings.newValue);
        if (next.success) {
          settingsRevision.current++;
          setSettings(next.data);
        }
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
        const revision = settingsRevision.current;
        const reply = await sendSettingsMessage({ action: "save", patch });
        if (settingsRevision.current === revision)
          setSettings(settingsSchema.parse(reply.settings));
      },
      "所有更改已保存",
      "保存失败，请重试",
    );
  }
  const saveTheme = (next: typeof theme) =>
    save(
      async () => {
        const revision = themeRevision.current;
        await browser.storage.local.set({ uiTheme: next });
        if (themeRevision.current === revision) setTheme(next);
      },
      "外观已保存",
      "外观保存失败，请重试",
    );
  const disableSite = (origin: string) =>
    save(
      async () => {
        const revision = settingsRevision.current;
        const reply = await sendSettingsMessage({
          action: "page-auto",
          enabled: false,
          origin,
        });
        if (settingsRevision.current === revision)
          setSettings(settingsSchema.parse(reply.settings));
      },
      "网站自动翻译已关闭",
      "保存失败，请重试",
    );
  async function clearData(targets?: CleanupTarget[]) {
    let results: CleanupResult[] | undefined;
    const saved = await save(
      async () => {
        const reply = await sendSettingsMessage({ action: "clear", targets });
        results = reply.results;
      },
      "",
      "清理失败，请重试",
    );
    if (!saved || !results) return;
    setNotice(
      results.every((item) => item.ok)
        ? "所选数据已清除"
        : "部分项目未清理完成，可单独重试",
    );
    return results;
  }
  return {
    settings,
    theme,
    notice,
    failure,
    busy,
    setNotice,
    update,
    saveTheme,
    disableSite,
    clearData,
  };
}
export type SettingsPreferences = ReturnType<typeof useSettingsPreferences>;
