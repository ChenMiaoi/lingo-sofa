import * as React from "react";
import { useCallback, useMemo, useState, useEffect } from "react";
import { browser } from "wxt/browser";
import { providerCatalogSchema, type Settings } from "@lingo-sofa/protocol";
import {
  createAISettings,
  createProviderEditor,
  designStyles,
} from "@lingo-sofa/ui-shared";
import { colorTheme } from "./appearance.js";
import { ReadingAccess } from "./ReadingAccess.js";
const AISettings = createAISettings(() => React);
const ProviderEditor = createProviderEditor(() => React);
async function send(message: unknown) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败");
  return reply;
}
export function ProviderPage() {
  const [mode, setMode] = useState<"bridge" | "direct">("bridge");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void send({ action: "state" })
      .then((state: { settings: Settings }) => {
        setMode(state.settings.mode);
        setReady(true);
      })
      .catch(() => setError("无法读取扩展设置"));
  }, []);
  const providers = useCallback(
    async () =>
      providerCatalogSchema.parse(
        await send({ action: "provider-catalog", mode }),
      ),
    [mode],
  );
  const client = useMemo(
    () => ({
      providers,
      configureProvider: async (
        update: import("@lingo-sofa/protocol").ProviderUpdate,
      ) => {
        if (
          mode === "direct" &&
          !(await browser.permissions.request({
            origins: [`${new URL(update.model.endpoint).origin}/*`],
          }))
        )
          throw new Error("需要允许访问所选模型地址");
        return send({ action: "provider-update", mode, update });
      },
      ...(mode === "bridge"
        ? {
            oauth: (action: "start" | "status" | "cancel" | "logout") =>
              send({ action: "provider-oauth", oauth: { action } }),
          }
        : {}),
    }),
    [providers, mode],
  );
  return (
    <ProductSettings
      mode={mode}
      setMode={setMode}
      ready={ready}
      error={error}
      client={client}
    />
  );
}

const sections = [
  ["translation", "翻译偏好"],
  ["intelligence", "AI 与 Pi"],
  ["accounts", "供应商"],
  ["shortcuts", "快捷键"],
  ["appearance", "外观"],
  ["privacy", "隐私与数据"],
] as const;
function ProductSettings({
  mode,
  setMode,
  ready,
  error,
  client,
}: {
  mode: "bridge" | "direct";
  setMode: (mode: "bridge" | "direct") => void;
  ready: boolean;
  error: string;
  client: import("@lingo-sofa/ui-shared").AISettingsClient;
}) {
  const [section, setSection] = useState<string>(() => {
    const value = location.hash.slice(1);
    return sections.some(([id]) => id === value) ? value : "intelligence";
  });
  useEffect(() => {
    const changed = () => {
      const value = location.hash.slice(1);
      if (sections.some(([id]) => id === value)) setSection(value);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [settings, setSettings] = useState<Settings>();
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void browser.storage.local
      .get("uiTheme")
      .then((value) => setTheme(colorTheme(value.uiTheme)));
    const changed = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area === "local" && changes.uiTheme)
        setTheme(colorTheme(changes.uiTheme.newValue));
    };
    browser.storage.onChanged.addListener(changed);
    void send({ action: "state" })
      .then((state) => setSettings(state.settings))
      .catch(() => setFailure("无法读取设置，请重新打开设置页。"));
    return () => browser.storage.onChanged.removeListener(changed);
  }, []);
  async function update(patch: Partial<Settings>) {
    if (!settings) return;
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      // Read current settings so a model saved in another panel is retained.
      const current = await send({ action: "state" });
      const next = { ...current.settings, ...patch };
      await send({ action: "save", settings: next });
      setSettings(next);
      setNotice("所有更改已保存");
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  const row = (
    title: string,
    description: string,
    control: React.ReactNode,
  ) => (
    <div className="ls-setting-row" key={title}>
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      {control}
    </div>
  );
  return (
    <main className="ls-product-settings settings-workspace">
      <style>{designStyles + productSettingsStyles}</style>
      <header className="ls-settings-topbar workspace-header">
        <a href="options.html" className="ls-settings-wordmark">
          LingoSofa <span>设置</span>
        </a>
        <a href="options.html?view=activity">用量与记录 ↗</a>
      </header>
      <aside className="ls-product-sidebar">
        <input
          className="ls-settings-search"
          type="search"
          aria-label="搜索设置"
          placeholder="搜索设置"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav aria-label="设置导航">
          {sections
            .filter(([, label]) =>
              label.toLowerCase().includes(query.toLowerCase()),
            )
            .map(([id, label]) => (
              <button
                key={id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(id);
                  history.replaceState(null, "", `#${id}`);
                  setNotice("");
                }}
              >
                {label}
              </button>
            ))}
          {query &&
            !sections.some(([, label]) =>
              label.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="ls-search-empty">没有匹配的设置</p>}
        </nav>
        <footer>
          <span>浏览器扩展 / v0.1</span>
          <span>Read together.</span>
          <a href="options.html?view=activity">阅读与用量 ↗</a>
        </footer>
      </aside>
      <div className="ls-product-content">
        <ReadingAccess />
        {(error || failure) && <p role="alert">{error || failure}</p>}
        {section === "accounts" ? (
          <>
            <header className="ls-design-heading">
              <h1>供应商</h1>
              <p>配置服务商、登录方式与 API 连接。</p>
            </header>
            {ready && (
              <section className="ls-provider-page" aria-label="连接服务商">
                <ProviderEditor
                  key={mode}
                  client={client}
                  initialSection="account"
                />
                <button
                  className="ls-dialog-done"
                  onClick={() => {
                    setSection("intelligence");
                    history.replaceState(null, "", "#intelligence");
                  }}
                >
                  完成
                </button>
              </section>
            )}
          </>
        ) : section === "intelligence" ? (
          <>
            {ready && (
              <AISettings
                key={mode}
                client={client}
                onManage={() => {
                  setSection("accounts");
                  history.replaceState(null, "", "#accounts");
                }}
              />
            )}
            <details className="ls-connection-details">
              <summary>连接方式</summary>
              <div
                className="connection-modes"
                role="group"
                aria-label="模型连接方式"
              >
                <button
                  aria-pressed={mode === "bridge"}
                  onClick={() => setMode("bridge")}
                >
                  本地助手
                </button>
                <button
                  aria-pressed={mode === "direct"}
                  onClick={() => setMode("direct")}
                >
                  模型直连
                </button>
              </div>
              <p>
                {mode === "bridge"
                  ? "供应商配置保存在本机助手，浏览器与 Discord 共用。"
                  : "直连供应商配置仅保存在此浏览器的本地存储。"}
              </p>
            </details>
          </>
        ) : (
          <>
            <header className="ls-design-heading">
              <h1>{sections.find(([id]) => id === section)?.[1]}</h1>
              <p>
                {section === "translation"
                  ? "目标语言、双语显示与网站规则。"
                  : section === "appearance"
                    ? "选择设置页的颜色主题。"
                    : section === "privacy"
                      ? "上下文由你选择，数据留在本机。"
                      : "查看翻译与 Ask 的快捷操作。"}
              </p>
            </header>
            {section === "translation" && (
              <>
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
                <div className="ls-bilingual-preview">
                  <span className="ls-status-chip">效果预览</span>
                  <p>A little context goes a long way.</p>
                  <p>一点上下文，就能带来很大的帮助。</p>
                  <small>原文不会被替换，译文保持在同一阅读位置。</small>
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
            )}
            {section === "appearance" && (
              <div className="ls-design-card">
                {row(
                  "颜色主题",
                  "跟随系统，或选择浅色与深色。",
                  <select
                    aria-label="颜色主题"
                    value={theme}
                    onChange={(event) => {
                      const next = event.target.value as typeof theme;
                      setTheme(next);
                      void browser.storage.local
                        .set({ uiTheme: next })
                        .then(() => setNotice("外观已保存"))
                        .catch(() => setFailure("外观保存失败，请重试"));
                    }}
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>,
                )}
              </div>
            )}
            {section === "shortcuts" && (
              <div className="ls-design-card">
                {row(
                  "快速打开 Ask",
                  "选中文字，或将鼠标移到正文段落旁；只打开窗口。",
                  <kbd>Alt Shift A</kbd>,
                )}
                {row(
                  "打开悬浮菜单",
                  "显示翻译、Ask 与设置入口。",
                  <kbd>Alt L</kbd>,
                )}
                {row("收起面板或对话", "关闭后焦点回到入口。", <kbd>Esc</kbd>)}
                {row(
                  "移动悬浮入口",
                  "先用 Tab 聚焦入口，再使用方向键。",
                  <kbd>↑ / ↓</kbd>,
                )}
                {row("Ask 发送消息", "Shift Enter 换行。", <kbd>Enter</kbd>)}
              </div>
            )}
            {section === "privacy" && (
              <>
                <div className="ls-design-card">
                  {row(
                    "上下文范围",
                    "Ask 仅发送所选内容与本次对话。",
                    <span className="ls-readonly-value">由你明确选择</span>,
                  )}
                  {row(
                    "持久保存用量",
                    "关闭时仅在当前浏览器会话中保存。切换会清除已有用量记录。",
                    <select
                      aria-label="持久保存用量"
                      value={String(settings?.persistUsage ?? false)}
                      disabled={busy || !settings}
                      onChange={(event) =>
                        void update({
                          persistUsage: event.target.value === "true",
                        })
                      }
                    >
                      <option value="false">关闭</option>
                      <option value="true">开启</option>
                    </select>,
                  )}
                </div>
                <a href="options.html?view=activity">管理用量、术语与历史 ↗</a>
              </>
            )}
            <p className="ls-design-footer" role="status">
              {busy ? "正在保存…" : notice}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

const productSettingsStyles = `
main.ls-product-settings{display:grid;grid-template-columns:224px minmax(0,1fr);grid-template-rows:64px 1fr;max-width:none;min-height:100dvh;margin:0;padding:0;background:var(--ls-canvas);color:var(--ls-text);border-radius:0;overflow:clip}
.ls-settings-topbar{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:0 32px;border-bottom:1px solid var(--ls-border);background:var(--ls-surface);font-size:12px}.ls-settings-topbar a{color:var(--ls-muted);text-decoration:none}.ls-settings-topbar .ls-settings-wordmark{font-weight:650;font-size:17px;color:var(--ls-text)}.ls-settings-wordmark span{font-size:12px;font-weight:400;margin-left:12px;color:var(--ls-muted)}
.ls-product-sidebar{display:flex;flex-direction:column;gap:8px;padding:28px 20px;background:transparent;border-right:1px solid var(--ls-border)}
.ls-product-settings .ls-settings-search{display:block;width:100%;height:40px;border:1px solid var(--ls-border);border-radius:8px;background:var(--ls-surface);color:var(--ls-text);margin:0 0 20px;padding:10px 12px;font:inherit;font-size:13px;line-height:20px}
.ls-product-sidebar nav{display:flex;flex-direction:column;gap:8px}.ls-product-sidebar nav button{min-height:44px;background:transparent;border:0;border-radius:8px;text-align:left;padding:12px;color:var(--ls-muted);font-size:13px}.ls-product-sidebar nav button[aria-current=page]{background:var(--ls-tint);color:var(--ls-accent);font-weight:500}
.ls-product-sidebar footer{display:flex;flex-direction:column;gap:8px;margin-top:auto;padding-top:60px;color:var(--ls-muted);font-size:11px}.ls-product-sidebar footer a{color:var(--ls-muted);text-decoration:none}.ls-search-empty{color:var(--ls-muted);font-size:12px}
.ls-product-content{padding:36px 48px;max-width:1120px;width:100%;min-width:0;display:flex;flex-direction:column;gap:18px}.ls-product-content .ls-design-heading{margin-bottom:0}.ls-product-content .ls-connection-details{font-size:11px;color:var(--ls-muted);padding-top:12px;border-top:1px solid var(--ls-border);margin-top:6px}.ls-connection-details summary{cursor:pointer}.ls-connection-details .connection-modes{display:inline-flex;margin-top:16px}
.ls-product-content .ls-design-card p{font-size:12px;color:var(--ls-muted)}.ls-bilingual-preview{background:var(--ls-tint);border:1px solid var(--ls-border);border-radius:14px;padding:24px}.ls-bilingual-preview>p{font-size:18px;margin:14px 0;line-height:27px}.ls-bilingual-preview>p+p{font-size:16px;color:var(--ls-accent);line-height:24px}.ls-bilingual-preview small{font-size:11px;color:var(--ls-muted)}.ls-info-note{padding:16px;background:var(--ls-subtle);border-radius:10px;font-size:12px;color:var(--ls-muted);margin:0}.ls-muted{color:var(--ls-muted)}.ls-product-settings .ls-setting-row select{appearance:none;background-image:url('/brand/figma/chevron.svg');background-repeat:no-repeat;background-position:right 12px center;padding-right:36px;font-family:inherit;font-size:13px}.ls-product-settings kbd{padding:8px 12px;border:1px solid var(--ls-border);border-radius:8px;background:var(--ls-subtle);font-size:12px}
@media(min-width:1120px){body.options-page:has(.ls-product-settings){padding:0;background:var(--ls-canvas)}}
@media(max-width:700px){main.ls-product-settings{grid-template-columns:minmax(0,1fr);border-radius:0;min-height:100dvh}.ls-product-sidebar{padding:20px;gap:14px;border-right:0;border-bottom:1px solid var(--ls-border)}.ls-product-settings .ls-settings-search{margin:0}.ls-product-sidebar nav{flex-direction:row;flex-wrap:wrap;gap:4px}.ls-product-sidebar nav button{padding:8px 10px;min-height:36px}.ls-product-sidebar footer{display:none}.ls-product-content{padding:24px 20px}.ls-product-brand{font-size:17px}}
`;
