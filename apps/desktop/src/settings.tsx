import React, { useEffect, useRef, useState } from "react";
import { isImeKey, type DesktopState } from "./api";
import { ShortcutSettings } from "./shortcuts";
import type { Perform } from "./view";

const categories = [
  { id: "account", title: "账户", detail: "DeepSeek API Key 与账户管理" },
  { id: "preferences", title: "翻译偏好", detail: "默认语言与窗口置顶" },
  { id: "shortcuts", title: "快捷键", detail: "全局组合与启用状态" },
] as const;
type Page = "home" | (typeof categories)[number]["id"];

export function Settings({
  state,
  notice,
  perform,
  onBack,
}: {
  state: DesktopState;
  notice: string;
  perform: Perform;
  onBack: () => void;
}) {
  const { model } = state;
  const [page, setPage] = useState<Page>("home");
  const [key, setKey] = useState("");
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
        <section
          hidden={page !== "account"}
          className="settings-group"
          aria-labelledby="account-heading"
        >
          <h2 id="account-heading">账户</h2>
          <label htmlFor="api-key">
            DeepSeek API Key{" "}
            <span>{model.keyConfigured ? "已加密保存" : "尚未配置"}</span>
          </label>
          <div className="key-row">
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              placeholder="输入 API Key，仅加密保存在本机"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              disabled={!key.trim()}
              onClick={() => {
                void perform("save_account", { key: key.trim() });
                setKey("");
              }}
            >
              保存
            </button>
          </div>
          {model.keyConfigured && (
            <button
              className="text-button"
              onClick={() => void perform("save_account", { key: "" })}
            >
              移除账户
            </button>
          )}
          <p>DeepSeek V4.1 Flash · 翻译与提问会将文本发送至 DeepSeek。</p>
        </section>
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
