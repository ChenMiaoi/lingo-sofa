import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import {
  providerCatalogSchema,
  type Settings,
  type TranslationEngine,
} from "@lingo-sofa/protocol";
import { webTranslationOrigins } from "@lingo-sofa/provider-web";
import { pageStatusLabel, type PageStatus } from "./page-status.js";
import { ReadingAccess } from "./ReadingAccess.js";

async function request(message: unknown) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败，请重试");
  return reply;
}

/** The toolbar popup is a launcher; configuration lives in the options tab. */
export function QuickPopup() {
  const [pageStatus, setPageStatus] = useState<PageStatus>();
  const [settings, setSettings] = useState<Settings>();
  const [modelName, setModelName] = useState("读取翻译服务…");
  const [engine, setEngine] = useState<TranslationEngine>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void request({ action: "page-status" })
      .then(setPageStatus)
      .catch(() => setPageStatus({ supported: false }));
    void request({ action: "state", localOnly: true })
      .then(async (state: { settings: Settings }) => {
        setSettings(state.settings);
        const catalog = providerCatalogSchema.parse(
          await request({ action: "provider-catalog" }),
        );
        setEngine(catalog.translationEngine ?? "llm");
        setModelName(
          catalog.translationEngine === "bing"
            ? "必应翻译 · 免 Key"
            : catalog.translationEngine === "google"
              ? "谷歌翻译 · 免 Key"
              : catalog.model.model,
        );
      })
      .catch(() => setError("无法读取翻译服务，请打开设置检查连接。"));
  }, []);
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function command(value: string) {
    // Start optional network authorization within the originating toolbar click.
    const permission =
      settings?.mode === "direct" &&
      engine &&
      engine !== "llm" &&
      ["page", "selection", "controls"].includes(value)
        ? browser.permissions.request({
            origins: [webTranslationOrigins[engine]],
          })
        : Promise.resolve(true);
    await act(async () => {
      if (!(await permission))
        throw new Error("需要允许访问所选翻译服务，才能开始翻译");
      await request({ action: "page", command: value });
      void request({ action: "page-status" })
        .then(setPageStatus)
        .catch(() => undefined);
      setNotice(
        value === "stop"
          ? "已恢复原页面"
          : value === "page" || value === "selection"
            ? "翻译已开始，可在网页中查看"
            : "已在网页中打开",
      );
    });
  }
  return (
    <main className="quick-popup">
      <header className="quick-header">
        <img src="/brand/lingo-sofa.svg" alt="" width="32" height="20" />
        <strong>LingoSofa</strong>
        <span>双语阅读</span>
      </header>
      <div className="quick-page-state" aria-label="当前页面">
        {pageStatus?.hostname && (
          <strong title={pageStatus.hostname}>{pageStatus.hostname}</strong>
        )}
        <span>{pageStatusLabel(pageStatus)}</span>
      </div>
      <section className="quick-language" aria-label="翻译语言">
        <span>自动检测</span>
        <span aria-hidden="true">→</span>
        <select
          aria-label="目标语言"
          disabled={!settings || busy}
          value={settings?.targetLanguage ?? "简体中文"}
          onChange={(event) => {
            const targetLanguage = event.target.value;
            void act(async () => {
              const current = await request({
                action: "state",
                localOnly: true,
              });
              const next = { ...current.settings, targetLanguage };
              await request({ action: "save", settings: next });
              setSettings(next);
              setNotice("目标语言已保存");
            });
          }}
        >
          {[
            ...new Set([
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
          ].map((language) => (
            <option key={language}>{language}</option>
          ))}
        </select>
      </section>
      <button
        className="quick-service"
        onClick={() => void browser.runtime.openOptionsPage()}
      >
        <span>翻译服务</span>
        <strong title={modelName}>{modelName}</strong>
        <span aria-hidden="true">↗</span>
      </button>
      <button
        className="quick-primary"
        disabled={
          busy ||
          !engine ||
          !pageStatus?.supported ||
          pageStatus.readingEnabled === false
        }
        onClick={() => void command("page")}
      >
        翻译页面 <span aria-hidden="true">→</span>
      </button>
      <div className="quick-actions" aria-label="常用操作">
        <button
          disabled={
            busy ||
            !engine ||
            !pageStatus?.supported ||
            pageStatus.readingEnabled === false ||
            pageStatus.hasSelection === false
          }
          onClick={() => void command("selection")}
        >
          翻译选中
        </button>
        <button
          disabled={
            busy ||
            !pageStatus?.supported ||
            pageStatus.readingEnabled === false ||
            pageStatus.hasSelection === false
          }
          onClick={() => void command("ask-selection")}
        >
          询问选中内容
        </button>
        <button
          disabled={busy || !pageStatus?.supported}
          onClick={() => void command("controls")}
        >
          显示网页悬浮球
        </button>
        <button
          disabled={
            busy ||
            !pageStatus?.supported ||
            (pageStatus.translated === false && pageStatus.pending === false)
          }
          onClick={() => void command("stop")}
        >
          恢复原文
        </button>
      </div>
      <ReadingAccess compact />
      <p className="quick-hint">选中文字后，按 Alt Shift A 打开 Ask</p>
      {error && (
        <p className="quick-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="quick-notice" role="status">
          {notice}
        </p>
      )}
      <footer className="quick-footer">
        <button onClick={() => void browser.runtime.openOptionsPage()}>
          设置 ↗
        </button>
        <span>v{browser.runtime.getManifest().version}</span>
        <a
          href={browser.runtime.getURL("/options.html#usage")}
          target="_blank"
          rel="noreferrer"
        >
          用量与记录 ↗
        </a>
      </footer>
    </main>
  );
}
