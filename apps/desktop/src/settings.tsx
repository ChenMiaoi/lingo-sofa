import React, { useEffect, useRef, useState } from "react";
import { isImeKey, type DesktopState } from "./api";
import { ModelProviders, type LoadModelCatalog } from "./model-providers";
import { ShortcutSettings } from "./shortcuts";
import type { Perform } from "./view";

const categories = [
  { id: "models", title: "模型与服务商", detail: "配置多个服务商与默认模型" },
  { id: "preferences", title: "翻译偏好", detail: "默认语言与窗口置顶" },
  { id: "shortcuts", title: "快捷键", detail: "全局组合与启用状态" },
] as const;
type Page = "home" | (typeof categories)[number]["id"];

export function Settings({
  state,
  notice,
  perform,
  onBack,
  loadCatalog,
}: {
  state: DesktopState;
  notice: string;
  perform: Perform;
  onBack: () => void;
  loadCatalog: LoadModelCatalog;
}) {
  const { model } = state;
  const [page, setPage] = useState<Page>("home");
  const backButton = useRef<HTMLButtonElement>(null);
  const categoryButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousPage = useRef<Page>("home");
  const back = () => (page === "home" ? onBack() : setPage("home"));
  useEffect(() => {
    if (page === "home" && previousPage.current !== "home") {
      const index = categories.findIndex(
        (category) => category.id === previousPage.current,
      );
      categoryButtons.current[index]?.focus();
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
              <strong>{category.title}</strong>
              <small>{category.detail}</small>
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
        <div hidden={page !== "shortcuts"}>
          <ShortcutSettings
            key={state.shortcuts.revision}
            snapshot={state.shortcuts}
            notice={notice}
            perform={perform}
          />
        </div>
      </section>
      <footer className="launcher-footer" role="status">
        <span>{notice || "设置保存在本机"}</span>
        <span>{page === "home" ? "Esc 返回导航" : "Esc 返回设置"}</span>
      </footer>
    </main>
  );
}
