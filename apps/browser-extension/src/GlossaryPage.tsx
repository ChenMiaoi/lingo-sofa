import * as React from "react";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { importGlossary, exportGlossary } from "./glossary-files.js";
import { settingsSchema } from "@lingo-sofa/protocol";

export function GlossaryPage({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState<
    { id: string; source: string; target: string }[]
  >([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void browser.runtime
      .sendMessage({ action: "state", localOnly: true })
      .then((reply) => {
        if (reply?.ok === false) throw new Error(reply.error);
        setTerms(
          settingsSchema
            .parse(reply.settings)
            .glossary.map((term) => ({ ...term, id: crypto.randomUUID() })),
        );
        setReady(true);
      })
      .catch(() => setError("无法读取术语表，请重新打开此页面。"));
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  function changed() {
    setDirty(true);
    setNotice("");
    setError("");
  }
  return (
    <section className="ls-activity" aria-label="术语表管理">
      <header className="ls-design-heading">
        <span className="ls-overline">GLOSSARY</span>
        <h1>术语表</h1>
        <p>为专业词汇约定译法，让每一次翻译保持一致。</p>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          const glossary = terms.map(({ source, target }) => ({
            source: source.trim(),
            target: target.trim(),
          }));
          if (glossary.some((term) => !term.source || !term.target)) {
            setError("请填写每一项的原词与译词，或删除空白项。");
            return;
          }
          if (
            new Set(glossary.map((term) => term.source)).size !==
            glossary.length
          ) {
            setError("原词不能重复，请合并重复的术语。");
            return;
          }
          setBusy(true);
          // Merge only glossary into the latest settings, retaining model changes elsewhere.
          void browser.runtime
            .sendMessage({ action: "state", localOnly: true })
            .then(async (current) => {
              if (current?.ok === false) throw new Error(current.error);
              const settings = settingsSchema.parse({
                ...current.settings,
                glossary,
              });
              const reply = await browser.runtime.sendMessage({
                action: "save",
                settings,
              });
              if (reply?.ok === false) throw new Error(reply.error);
              setDirty(false);
              setNotice("术语表已保存，将用于后续翻译。");
            })
            .catch(() => setError("术语表保存失败，请检查内容后重试。"))
            .finally(() => setBusy(false));
        }}
      >
        <div className="ls-design-card ls-glossary-card">
          <div className="ls-card-heading">
            <div>
              <h2>
                我的术语 <span className="ls-count">{terms.length}</span>
              </h2>
              <p>
                手动保存 · 仅用于此浏览器的直连翻译，不会同步到本地助手或
                Discord。
              </p>
            </div>
            <button
              type="button"
              disabled={!ready || busy || terms.length >= 200}
              onClick={() => {
                setQuery("");
                setTerms([
                  ...terms,
                  { id: crypto.randomUUID(), source: "", target: "" },
                ]);
                changed();
              }}
            >
              ＋ 添加术语
            </button>
          </div>
          <div className="ls-glossary-tools">
            <input
              type="search"
              aria-label="搜索术语"
              placeholder="搜索原词或译词"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label>
              导入 JSON / TSV
              <input
                type="file"
                aria-label="导入术语文件"
                accept=".json,.tsv,application/json,text/tab-separated-values"
                disabled={!ready || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 100_000) {
                    setError("文件过大，请限制在 100 KB 内。");
                    return;
                  }
                  setBusy(true);
                  setError("");
                  setNotice("");
                  void file
                    .text()
                    .then((text) => {
                      const merged = importGlossary(
                        text,
                        terms.map(({ source, target }) => ({ source, target })),
                      );
                      setTerms(
                        merged.map((term) => ({
                          ...term,
                          id: crypto.randomUUID(),
                        })),
                      );
                      setDirty(true);
                      setQuery("");
                      setNotice("已合并到草稿，请检查后保存。");
                    })
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error ? reason.message : "导入失败",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              />
            </label>
            <button
              type="button"
              disabled={!ready || busy || !terms.length}
              onClick={() => {
                try {
                  const text = exportGlossary(
                    terms.map(({ source, target }) => ({ source, target })),
                  );
                  const url = URL.createObjectURL(
                    new Blob([text], { type: "application/json" }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "lingo-sofa-glossary.json";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                  setError("");
                  setNotice(
                    dirty
                      ? "已导出当前草稿；扩展中的更改仍需保存。"
                      : "术语表已导出。",
                  );
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : "导出失败",
                  );
                }
              }}
            >
              导出 JSON
            </button>
          </div>
          <p className="ls-muted">
            导入会合并已有术语；译法冲突时保留原草稿。TSV
            每行用制表符分隔原词与译词，不含标题行。
          </p>
          {!terms.length && (
            <div className="ls-activity-empty">
              <span aria-hidden="true">Aa</span>
              <h3>让专业表达有自己的译法</h3>
              <p>例如：kernel → 内核，pull request → 合并请求。</p>
            </div>
          )}
          {terms.length > 0 && (
            <div className="ls-glossary-rows">
              <div className="ls-glossary-labels">
                <span>原词</span>
                <span>译词</span>
                <span />
              </div>
              {terms
                .map((term, index) => ({ term, index }))
                .filter(({ term }) =>
                  `${term.source} ${term.target}`
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()),
                )
                .map(({ term, index }) => (
                  <div className="ls-glossary-row" key={term.id}>
                    <input
                      aria-label={`原词 ${index + 1}`}
                      placeholder="例如 kernel"
                      maxLength={100}
                      value={term.source}
                      disabled={busy}
                      onChange={(event) => {
                        setTerms(
                          terms.map((t) =>
                            t.id === term.id
                              ? { ...t, source: event.target.value }
                              : t,
                          ),
                        );
                        changed();
                      }}
                    />
                    <input
                      aria-label={`译词 ${index + 1}`}
                      placeholder="例如 内核"
                      maxLength={100}
                      value={term.target}
                      disabled={busy}
                      onChange={(event) => {
                        setTerms(
                          terms.map((t) =>
                            t.id === term.id
                              ? { ...t, target: event.target.value }
                              : t,
                          ),
                        );
                        changed();
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`删除术语 ${index + 1}`}
                      disabled={busy}
                      onClick={() => {
                        setTerms(terms.filter((t) => t.id !== term.id));
                        changed();
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
            </div>
          )}
          {query &&
            !terms.some((term) =>
              `${term.source} ${term.target}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase()),
            ) && <p>没有匹配的术语。</p>}
          <footer className="ls-glossary-footer">
            <span>
              {dirty ? "有未保存的更改" : "最多 200 项 · 保存在此浏览器"}
            </span>
            <button
              type="submit"
              className="ls-solid-button"
              disabled={!ready || busy || !dirty}
            >
              {busy ? "正在保存…" : "保存术语表"}
            </button>
          </footer>
        </div>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
      <p className="ls-info-note">
        术语只约定词汇译法，不作为模型指令。本地助手的术语独立管理，不会从这里同步。
      </p>
    </section>
  );
}
