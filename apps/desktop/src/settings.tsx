import { dragWindow } from "./window-drag";
import React, { useEffect, useRef, useState } from "react";
import { formatShortcut, listIndex } from "./keyboard";
import {
  isImeKey,
  type DesktopState,
  type Settings as Preferences,
} from "./api";
import { ModelProviders, type LoadModelCatalog } from "./model-providers";
import { UpdateSettings, updateSummary } from "./updates";
import { ShortcutSettings } from "./shortcuts";
import type { Perform } from "./view";
import {
  loadUsageReport as defaultLoadUsageReport,
  type LoadUsageReport,
} from "./api";
import { UsageSettings } from "./usage-settings";

const categories = [
  { id: "models", title: "模型与服务商", detail: "配置多个服务商与默认模型" },
  {
    id: "preferences",
    title: "翻译偏好",
    detail: "默认语言、译文位置与窗口置顶",
  },
  { id: "shortcuts", title: "快捷键", detail: "全局组合与启用状态" },
  { id: "updates", title: "关于与更新", detail: "版本信息与自动检查更新" },
  {
    id: "usage",
    title: "用量与费用",
    detail: "本机累计模型调用、token 与 USD 估算",
  },
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
  loadUsageReport = defaultLoadUsageReport,
}: {
  state: DesktopState;
  notice: string;
  perform: Perform;
  onBack: () => void;
  loadCatalog: LoadModelCatalog;
  initialPage?: SettingsPage;
  onLogin: (provider?: string) => void;
  loadUsageReport?: LoadUsageReport;
}) {
  const { model } = state;
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<ReadonlySet<keyof Preferences>>(
    new Set(),
  );
  const pending = useRef(new Set<keyof Preferences>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const savePreference = <K extends keyof Preferences>(
    field: K,
    value: Preferences[K],
  ) => {
    if (pending.current.has(field)) return;
    pending.current.add(field);
    setSaving(new Set(pending.current));
    const complete = () => {
      pending.current.delete(field);
      if (mounted.current) setSaving(new Set(pending.current));
    };
    // App reports persistence errors. ACK releases this field; polling supplies
    // authoritative values independently, so a missing snapshot cannot lock it.
    void perform("patch_settings", {
      patch: { [field]: value },
    }).then(complete, complete);
  };
  const filterInput = useRef<HTMLInputElement>(null);
  const searchFeatures = {
    models: [
      { label: "API Key", terms: "apikey 密钥 凭证" },
      {
        label: "订阅账户登录",
        terms: "订阅登录 ChatGPT Codex Claude",
      },
      { label: "默认模型", terms: "" },
    ],
    preferences: [
      { label: "默认翻译语言", terms: "" },
      { label: "划词与 OCR 译文位置", terms: "框选 悬浮栏 原文下方" },
      { label: "Ask 与输入窗口保持置顶", terms: "" },
      ...(!state.shortcuts.macos
        ? [{ label: "鼠标选中后自动翻译", terms: "自动划词" }]
        : []),
    ],
    shortcuts: [
      { label: "唤出输入面板", terms: "" },
      { label: "翻译当前选区", terms: "" },
      { label: "翻译剪贴板", terms: "" },
      { label: "划词翻译", terms: "" },
      ...(state.shortcuts.ocr ? [{ label: "截图 OCR", terms: "框选" }] : []),
    ],
    updates: [{ label: "自动检查更新", terms: "版本" }],
    usage: [
      { label: "用量与费用", terms: "token tokens 开销 成本 USD 缓存 调用" },
    ],
  };
  const search = query.trim().toLowerCase();
  const visibleCategories = categories.flatMap((category) => {
    const matches = search
      ? searchFeatures[category.id].filter((feature) =>
          `${feature.label} ${feature.terms}`.toLowerCase().includes(search),
        )
      : [];
    return !search ||
      matches.length ||
      `${category.title} ${category.detail}`.toLowerCase().includes(search)
      ? [{ ...category, matches }]
      : [];
  });
  const clearSearch = () => {
    setQuery("");
    filterInput.current?.focus();
  };
  const backButton = useRef<HTMLButtonElement>(null);
  const categoryButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousPage = useRef<SettingsPage>("home");
  const back = () => (page === "home" ? onBack() : setPage("home"));
  useEffect(() => {
    if (page === "home") {
      const index = visibleCategories.findIndex(
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
      if (page === "home" && query) {
        setQuery("");
        filterInput.current?.focus();
      } else if (page === "home") onBack();
      else setPage("home");
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [page, onBack, query]);
  const title =
    categories.find((category) => category.id === page)?.title ?? "设置";
  const values = {
    updates: updateSummary(state.updates),
    models: `${model.defaultModel.provider} / ${model.defaultModel.modelId}`,
    preferences: model.settings.target,
    shortcuts: `${state.shortcuts.registered.filter(Boolean).length}/${state.shortcuts.ocr ? 6 : 4} 已启用`,
    usage: "本机记录",
  };
  return (
    <main className="launcher settings-launcher selection-page">
      <header
        className="command-header settings-header"
        onMouseDown={dragWindow}
      >
        <button
          ref={backButton}
          className="settings-back"
          aria-label={page === "home" ? "返回导航窗口" : "返回设置"}
          onClick={back}
        >
          <span aria-hidden="true">←</span>
          {title}
        </button>
        <span className="settings-brand">
          {page === "home" ? "/settings" : "设置"}
        </span>
      </header>
      {page === "home" && (
        <div className="settings-search">
          <input
            ref={filterInput}
            aria-label="搜索设置"
            placeholder="搜索设置名称或功能…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent)) return;
              if (
                (event.key === "ArrowDown" || event.key === "Enter") &&
                visibleCategories.length
              ) {
                event.preventDefault();
                if (event.key === "Enter") setPage(visibleCategories[0]!.id);
                else categoryButtons.current[0]?.focus();
              }
            }}
          />
          {query && (
            <button className="settings-search-clear" onClick={clearSearch}>
              清空搜索
            </button>
          )}
          <span>{visibleCategories.length} 项</span>
        </div>
      )}
      <nav
        className="settings-categories"
        aria-label="设置分类"
        hidden={page !== "home"}
      >
        {visibleCategories.map((category, index) => (
          <button
            key={category.id}
            ref={(element) => {
              categoryButtons.current[index] = element;
            }}
            className={`action${category.matches.length ? " settings-search-result" : ""}`}
            aria-label={category.title}
            onClick={() => setPage(category.id)}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent)) return;
              const next = listIndex(
                event.key,
                index,
                visibleCategories.length,
              );
              if (next !== null) {
                event.preventDefault();
                categoryButtons.current[next]?.focus();
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
              <small>
                {category.matches.length
                  ? `匹配：${category.matches.map((feature) => feature.label).join("、")}`
                  : category.detail}
              </small>
            </span>
            <span className="setting-current-value" title={values[category.id]}>
              {values[category.id]}
            </span>
            <span className="category-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
        {!visibleCategories.length && (
          <p className="quiet-status">没有匹配的设置</p>
        )}
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
          {!state.shortcuts.macos && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={model.settings.autoSelectionTranslation}
                  disabled={saving.has("autoSelectionTranslation")}
                  aria-describedby={
                    saving.has("autoSelectionTranslation")
                      ? "automatic-saving"
                      : undefined
                  }
                  onChange={(event) =>
                    savePreference(
                      "autoSelectionTranslation",
                      event.target.checked,
                    )
                  }
                />
                鼠标选中后自动翻译
              </label>
              {saving.has("autoSelectionTranslation") && (
                <p
                  className="settings-help"
                  id="automatic-saving"
                  role="status"
                  aria-label="鼠标选中后自动翻译保存中"
                >
                  保存中…
                </p>
              )}
              <p className="settings-help">选中文字即翻译，会调用模型。</p>
            </>
          )}
          <div className="preference-row">
            <label htmlFor="translation-display">划词与 OCR 译文位置</label>
            <select
              id="translation-display"
              value={model.settings.translationDisplay}
              disabled={saving.has("translationDisplay")}
              aria-describedby={
                saving.has("translationDisplay")
                  ? "translation-display-saving"
                  : undefined
              }
              onChange={(event) =>
                savePreference(
                  "translationDisplay",
                  event.target.value as Preferences["translationDisplay"],
                )
              }
            >
              <option value="below">原文下方 · 贴合显示</option>
              <option value="panel">悬浮栏 · 集中面板</option>
            </select>
          </div>
          {saving.has("translationDisplay") && (
            <p
              className="settings-help"
              id="translation-display-saving"
              role="status"
            >
              译文位置保存中…
            </p>
          )}
          <div className="preference-row">
            <label htmlFor="target">默认翻译语言</label>
            <select
              id="target"
              value={model.settings.target}
              disabled={saving.has("target")}
              aria-describedby={
                saving.has("target") ? "target-saving" : undefined
              }
              onChange={(e) => savePreference("target", e.target.value)}
            >
              {["简体中文", "English", "日本語", "한국어"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
          {saving.has("target") && (
            <p className="settings-help" id="target-saving" role="status">
              默认翻译语言保存中…
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              id="pin-window"
              checked={model.settings.pinned}
              disabled={saving.has("pinned")}
              aria-describedby={
                saving.has("pinned") ? "pin-window-saving" : undefined
              }
              onChange={(e) => savePreference("pinned", e.target.checked)}
            />
            Ask 与输入窗口保持置顶
          </label>
          {saving.has("pinned") && (
            <p className="settings-help" id="pin-window-saving" role="status">
              窗口置顶保存中…
            </p>
          )}
        </section>
        <div hidden={page !== "updates"}>
          <UpdateSettings state={state} perform={perform} />
        </div>
        <UsageSettings active={page === "usage"} loadReport={loadUsageReport} />
        <div hidden={page !== "shortcuts"}>
          <ShortcutSettings
            active={page === "shortcuts"}
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
              : "")}
        </span>
        <span>
          {page === "home"
            ? query
              ? "Esc 清除搜索"
              : "Esc 返回导航"
            : "Esc 返回设置"}
        </span>
      </footer>
    </main>
  );
}
