import React, { useEffect, useRef, useState } from "react";
import { formatShortcut } from "./keyboard";
import { isImeKey, type DesktopState } from "./api";
import { ModelProviders, type LoadModelCatalog } from "./model-providers";
import { UpdateSettings, updateSummary } from "./updates";
import { ShortcutSettings } from "./shortcuts";
import type { Perform } from "./view";

const categories = [
  { id: "models", title: "模型与服务商", detail: "配置多个服务商与默认模型" },
  {
    id: "preferences",
    title: "翻译偏好",
    detail: "默认语言、译文位置与窗口置顶",
  },
  { id: "shortcuts", title: "快捷键", detail: "全局组合与启用状态" },
  { id: "updates", title: "关于与更新", detail: "版本信息与自动检查更新" },
] as const;
export type SettingsPage = "home" | (typeof categories)[number]["id"];

export function Settings({
  state,
  notice,
  perform,
  onBack,
  loadCatalog,
  initialPage = "home",
  onLogin,
}: {
  state: DesktopState;
  notice: string;
  perform: Perform;
  onBack: () => void;
  loadCatalog: LoadModelCatalog;
  initialPage?: SettingsPage;
  onLogin: (provider?: string) => void;
}) {
  const { model } = state;
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const backButton = useRef<HTMLButtonElement>(null);
  const categoryButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousPage = useRef<SettingsPage>("home");
  const back = () => (page === "home" ? onBack() : setPage("home"));
  useEffect(() => {
    if (page === "home") {
      const index = categories.findIndex(
        (category) => category.id === previousPage.current,
      );
      categoryButtons.current[Math.max(index, 0)]?.focus();
    } else {
      backButton.current?.focus();
    }
    previousPage.current = page;
  }, [page]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKey(event)) return;
      event.preventDefault();
      if (page === "home") onBack();
      else setPage("home");
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [page, onBack]);
  const title =
    categories.find((category) => category.id === page)?.title ?? "设置";
  const values = {
    updates: updateSummary(state.updates),
    models: `${model.defaultModel.provider} / ${model.defaultModel.modelId}`,
    preferences: model.settings.target,
    shortcuts: `${state.shortcuts.registered.filter(Boolean).length}/${state.shortcuts.macos ? 6 : 4} 已启用`,
  };
  return (
    <main className="launcher settings-launcher">
      <header className="command-header settings-header" data-tauri-drag-region>
        <button
          ref={backButton}
          className="settings-back"
          aria-label={page === "home" ? "返回导航窗口" : "返回设置"}
          onClick={back}
        >
          <span aria-hidden="true">←</span>
          {title}
        </button>
        <span className="settings-brand" data-tauri-drag-region>
          {page === "home" ? "LingoSofa" : "设置"}
        </span>
      </header>
      <nav
        className="settings-categories"
        aria-label="设置分类"
        hidden={page !== "home"}
      >
        {categories.map((category, index) => (
          <button
            key={category.id}
            ref={(element) => {
              categoryButtons.current[index] = element;
            }}
            className="action"
            aria-label={category.title}
            onClick={() => setPage(category.id)}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                categoryButtons.current[
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    categories.length) %
                    categories.length
                ]?.focus();
              }
            }}
          >
            <span className="action-copy">
              <strong>
                {category.title}
                {category.id === "updates" &&
                  ["available", "downloading", "ready"].includes(
                    state.updates.phase,
                  ) && <span className="update-dot" aria-label="有可用更新" />}
              </strong>
              <small>{category.detail}</small>
            </span>
            <span className="setting-current-value" title={values[category.id]}>
              {values[category.id]}
            </span>
            <span className="category-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </nav>
      <section
        className="settings-form"
        hidden={page === "home"}
        aria-label={title}
      >
        <div hidden={page !== "models"}>
          <ModelProviders
            model={model}
            perform={perform}
            loadCatalog={loadCatalog}
            onLogin={onLogin}
            active={page === "models"}
          />
        </div>
        <section
          hidden={page !== "preferences"}
          className="settings-group"
          aria-labelledby="preferences-heading"
        >
          <h2 id="preferences-heading">翻译偏好</h2>
          <div className="preference-row">
            <label htmlFor="translation-display">划词与 OCR 译文位置</label>
            <select
              id="translation-display"
              value={model.settings.translationDisplay}
              onChange={(event) =>
                void perform("patch_settings", {
                  patch: { translationDisplay: event.target.value },
                })
              }
            >
              <option value="below">原文下方 · 贴合显示</option>
              <option value="panel">悬浮栏 · 集中面板</option>
            </select>
          </div>
          <p className="settings-help">
            OCR
            框选后直接翻译；空间不足时在区域上方显示。快捷键可临时使用另一种样式，不修改默认设置。
          </p>
          <div className="preference-row">
            <label htmlFor="target">默认翻译语言</label>
            <select
              id="target"
              value={model.settings.target}
              onChange={(e) =>
                void perform("save_settings", {
                  settings: { ...model.settings, target: e.target.value },
                })
              }
            >
              {["简体中文", "English", "日本語", "한국어"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={model.settings.pinned}
              onChange={(e) =>
                void perform("save_settings", {
                  settings: { ...model.settings, pinned: e.target.checked },
                })
              }
            />
            Ask 与输入窗口保持置顶
          </label>
        </section>
        <div hidden={page !== "updates"}>
          <UpdateSettings state={state} perform={perform} />
        </div>
        <div hidden={page !== "shortcuts"}>
          <ShortcutSettings
            key={state.shortcuts.revision}
            snapshot={state.shortcuts}
            display={model.settings.translationDisplay}
            notice={notice}
            perform={perform}
          />
        </div>
      </section>
      <footer className="launcher-footer" role="status">
        <span>
          {notice ||
            (page === "home"
              ? `↑↓ 选择 · ${formatShortcut("Enter", state.shortcuts.macos)} 打开`
              : "设置保存在本机")}
        </span>
        <span>{page === "home" ? "Esc 返回导航" : "Esc 返回设置"}</span>
      </footer>
    </main>
  );
}
