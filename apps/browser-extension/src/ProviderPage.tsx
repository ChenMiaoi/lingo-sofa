import * as React from "react";
import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { browser } from "wxt/browser";
import { providerCatalogSchema } from "@lingo-sofa/protocol";
import {
  createAISettings,
  createProviderEditor,
  designStyles,
} from "@lingo-sofa/ui-shared";

import { webTranslationOrigins } from "@lingo-sofa/provider-web";

import { ReadingAccess } from "./ReadingAccess.js";
import { ActivityPage } from "./ActivityPage.js";
import { GlossaryPage } from "./GlossaryPage.js";

import "./settings-workspace.css";
import "./activity.css";
import { useSettingsPreferences } from "./useSettingsPreferences.js";
import { sendSettingsMessage as send } from "./settings-message.js";
import { TranslationPreferences } from "./TranslationPreferences.js";
import { AppearancePreferences } from "./AppearancePreferences.js";
import { PrivacyPreferences } from "./PrivacyPreferences.js";
import { ShortcutPreferences } from "./ShortcutPreferences.js";
import { ConnectionPreferences } from "./ConnectionPreferences.js";
import { AccountMigration } from "./AccountMigration.js";

import { SettingsNavigation, sections } from "./SettingsNavigation.js";
const AISettings = createAISettings(() => React);
const ProviderEditor = createProviderEditor(() => React);
export function ProviderPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void send({ action: "state", localOnly: true })
      .then(() => setReady(true))
      .catch(() => setError("无法读取扩展设置"));
  }, []);
  const providers = useCallback(
    async () =>
      providerCatalogSchema.parse(await send({ action: "provider-catalog" })),
    [],
  );
  const client = useMemo(
    () => ({
      providers,
      configureProvider: async (
        update: import("@lingo-sofa/protocol").ProviderUpdate,
      ) => {
        const origins =
          update.target === "remove-account"
            ? []
            : update.target === "translation-engine"
              ? update.engine === "llm"
                ? []
                : [webTranslationOrigins[update.engine]]
              : [];
        if (
          origins.length > 0 &&
          !(await browser.permissions.request({ origins }))
        )
          throw new Error("需要允许访问所选免 Key 翻译服务");
        return send({ action: "provider-update", update });
      },
      oauth: (action: "start" | "status" | "cancel" | "logout") =>
        send({ action: "provider-oauth", oauth: { action } }),
    }),
    [providers],
  );
  return <ProductSettings ready={ready} error={error} client={client} />;
}

function ProductSettings({
  ready,
  error,
  client,
}: {
  ready: boolean;
  error: string;
  client: import("@lingo-sofa/ui-shared").AISettingsClient;
}) {
  const [section, setSection] = useState<string>(() => {
    const value = location.hash.slice(1);
    return sections.some(([id]) => id === value) ? value : "translation";
  });
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo(0, 0);
  }, [section]);
  useEffect(() => {
    const changed = () => {
      const value = location.hash.slice(1);
      setSection(sections.some(([id]) => id === value) ? value : "translation");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const connected = useCallback(
    () => setConnectionRevision((value) => value + 1),
    [],
  );

  const preferences = useSettingsPreferences();
  const { notice, failure, busy, setNotice } = preferences;
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [accountReturn, setAccountReturn] = useState("translation");
  const openAccounts = () => {
    setAccountReturn(section === "accounts" ? "translation" : section);
    setNavigationError("");
    setSection("accounts");
    location.hash = "accounts";
  };
  useEffect(() => {
    if (!providerDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [providerDirty]);
  return (
    <main className="ls-product-settings">
      <style>{designStyles}</style>
      <header className="ls-settings-topbar">
        <a href="options.html" className="ls-settings-wordmark">
          LingoSofa <span>设置 · v{browser.runtime.getManifest().version}</span>
        </a>
        <span className="ls-muted">阅读与理解，都在此处。</span>
      </header>
      <aside className="ls-product-sidebar">
        <SettingsNavigation
          section={section}
          content={content}
          onSelect={(id) => {
            if (id === "accounts") {
              openAccounts();
              return;
            }
            setSection(id);
            location.hash = id;
            setNotice("");
          }}
        />
        <footer>
          <span>浏览器扩展 / v{browser.runtime.getManifest().version}</span>
          <span>Read together.</span>
        </footer>
      </aside>
      <div
        className={`ls-product-content${section === "usage" || section === "history" ? " ls-content-wide" : ""}`}
        ref={content}
      >
        {section !== "connection" && (
          <AccountMigration onMigrated={connected} />
        )}
        {(section === "translation" ||
          new URLSearchParams(location.search).get("setup") === "reading") && (
          <div className="ls-reading-access">
            <ReadingAccess
              detailed={
                new URLSearchParams(location.search).get("setup") === "reading"
              }
              prominent={section === "translation"}
            />
          </div>
        )}
        {["translation", "intelligence", "accounts"].includes(section) &&
          preferences.settings && (
            <div className="ls-configuration-context">
              <span>模型账户：浏览器与 Discord 共用本地助手</span>
              <a href="#connection">管理连接</a>
            </div>
          )}
        {glossaryDirty && section !== "glossary" && (
          <button
            className="ls-draft-reminder"
            onClick={() => {
              setSection("glossary");
              location.hash = "glossary";
            }}
          >
            术语表有未保存更改 · 返回保存
          </button>
        )}
        {(error || failure || navigationError) && (
          <p role="alert">{error || failure || navigationError}</p>
        )}
        {providerDirty && section !== "accounts" && (
          <button className="ls-draft-reminder" onClick={openAccounts}>
            供应商有未保存更改 · 返回保存
          </button>
        )}
        {(providerDirty || section === "accounts") && (
          <div hidden={section !== "accounts"} data-setting="providers">
            <>
              <header className="ls-design-heading">
                <h1>供应商</h1>
                <p>配置服务商、登录方式与 API 连接。</p>
              </header>
              {ready && (
                <section className="ls-provider-page" aria-label="连接服务商">
                  <ProviderEditor
                    key={connectionRevision}
                    client={client}
                    initialSection="account"
                    onDirtyChange={setProviderDirty}
                    onClose={() => {
                      setSection(accountReturn);
                      location.hash = accountReturn;
                    }}
                  />
                </section>
              )}
            </>
          </div>
        )}
        {section === "accounts" ? null : section === "intelligence" ? (
          <>
            {ready && (
              <AISettings
                key={connectionRevision}
                client={client}
                section="ask"
                onManage={openAccounts}
              />
            )}
          </>
        ) : section === "connection" ? (
          <div data-setting="connection">
            <ConnectionPreferences
              activeMode={preferences.settings?.mode}
              onConnected={connected}
            />
          </div>
        ) : section === "usage" || section === "history" ? (
          <div data-setting={section === "usage" ? "usage" : "request-history"}>
            <ActivityPage key={section} section={section} />
          </div>
        ) : section === "glossary" ? null : (
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
              <TranslationPreferences
                key={connectionRevision}
                preferences={preferences}
                ready={ready}
                client={client}
                onManage={openAccounts}
              />
            )}
            {section === "appearance" && (
              <AppearancePreferences preferences={preferences} />
            )}
            {section === "shortcuts" && <ShortcutPreferences />}
            {section === "privacy" && (
              <PrivacyPreferences preferences={preferences} />
            )}
            <p className="ls-design-footer" role="status">
              {busy ? "正在保存…" : notice}
            </p>
          </>
        )}
        <div hidden={section !== "glossary"} data-setting="glossary">
          <GlossaryPage onDirtyChange={setGlossaryDirty} />
        </div>
      </div>
    </main>
  );
}
