import React, { useEffect, useRef, useState } from "react";
import { formatShortcut } from "./keyboard";
import { Settings } from "./settings";
import type { LoadModelCatalog } from "./model-providers";
import {
  loadModelCatalog as defaultLoadModelCatalog,
  matchingActions,
  contextLabel,
  errorMessage,
  shouldSubmitQuestion,
  isImeKey,
  type DesktopState,
  type Mode,
} from "./api";
export type Perform = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<void>;
const paths: Record<string, React.ReactNode> = {
  sofa: (
    <>
      <path d="M6 11V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5M9 4v11m6-11v11M6 15h12M4 10H3v9h18v-9h-1a2 2 0 0 0-2 2v3H6v-3a2 2 0 0 0-2-2ZM5 19v2m14-2v2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V3H3v13h5" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chat: (
    <>
      <path d="M5 4h14v13H9l-4 4V4Z" />
      <path d="M9 8h6m-6 4h4" />
    </>
  ),
  translate: (
    <>
      <path d="M3 5h11M8 2v3m-3 4 7 7m0-11c0 5-3 9-8 12m11-1 3-9 4 13m-6-4h5" />
    </>
  ),
  pen: (
    <>
      <path d="m4 16 12-12 4 4L8 20H4v-4Zm10-10 4 4M3 22h18" />
    </>
  ),
  selection: (
    <>
      <path d="M3 7V3h4m10 0h4v4M3 17v4h4m10 0h4v-4M8 8h8m-4 0v9m-3 0h6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m9 3-1 3-3 1-2 5 3 2 1 4 5 3 2-3 4-1 3-5-3-2-1-4-5-3-3 3Z" />
    </>
  ),
};
function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chat}
    </svg>
  );
}
export function Desktop({
  state,
  notice = "",
  perform,
  loadModelCatalog = defaultLoadModelCatalog,
}: {
  state: DesktopState;
  notice?: string;
  perform: Perform;
  loadModelCatalog?: LoadModelCatalog;
}) {
  const { desktop: d, model } = state;
  const mode = d.mode;
  const context = d.context;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [input, setInput] = useState("");
  const previousView = useRef({
    mode,
    epoch: d.epoch,
    revision: d.modelRevision,
  });
  const queryInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const busy =
    model.phase === "preparing" ||
    model.phase === "running" ||
    model.phase === "compacting";
  const current = model.revision === d.modelRevision;
  const options = matchingActions(query);
  const isAsk = mode === "ask" || mode === "ask-result";
  const isInput = mode === "input";
  const inputActions = [
    {
      id: "translate",
      label: "翻译这段文字",
      detail: `翻译为${model.settings.target}`,
      tag: "翻译",
      icon: "translate",
      question: "",
    },
    {
      id: "question",
      label: "作为新问题提问",
      detail: "直接提问，获取回答",
      tag: "提问",
      icon: "chat",
      question: "",
    },
  ];
  const visibleActions = isInput ? inputActions : options;
  const go = (mode: Mode) => void perform("set_mode", { mode });
  const back = () => void perform("back_reading");
  const execute = () => {
    if (busy) return;
    const action = visibleActions[selected];
    if (isInput) {
      if (input.trim())
        void perform(
          action?.id === "question" ? "ask_text" : "translate_text",
          { text: input },
        );
      return;
    }
    const question = action?.question ?? query.trim();
    if (question) void perform("ask_question", { question });
  };
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    const previous = previousView.current;
    const returningFromSettings =
      previous.mode === "settings" && previous.epoch === d.epoch;
    previousView.current = { mode, epoch: d.epoch, revision: d.modelRevision };
    // Settings temporarily replaces the launcher. Returning must not consume
    // a draft; a new source or accepted question still resets the right input.
    if (
      mode === "ask-result" &&
      (!returningFromSettings || previous.revision !== d.modelRevision)
    ) {
      setQuery("");
    }
    if (
      !returningFromSettings &&
      (previous.mode !== mode || previous.epoch !== d.epoch)
    ) {
      setSourceOpen(false);
      if (mode === "ask") {
        setQuery("");
        setSelected(0);
      }
      if (mode === "input") {
        setInput("");
        setSelected(0);
      }
    }
    if (mode === "input") draftInput.current?.focus();
    if (mode === "ask" || mode === "ask-result") queryInput.current?.focus();
  }, [mode, d.epoch, d.modelRevision]);
  useEffect(() => {
    if (answer.current) answer.current.scrollTop = answer.current.scrollHeight;
  }, [model.output]);
  useEffect(() => {
    const draft = draftInput.current;
    if (!isInput || !draft) return;
    draft.style.height = "auto";
    draft.style.height = `${Math.min(Math.max(draft.scrollHeight, 30), 74)}px`;
  }, [input, isInput]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (mode === "settings" || e.key !== "Escape" || isImeKey(e)) return;
      e.preventDefault();
      if (mode === "ask-result") {
        void perform("cancel_task");
        go("ask");
      } else if (mode === "translation" || mode === "menu") {
        void perform("collapse");
      } else if (mode !== "idle") {
        back();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [mode, perform]);
  const message =
    notice || (d.notice ? errorMessage(d.notice, state.shortcuts.macos) : "");
  const translationError = current && model.phase === "error";
  const translation =
    d.translation ||
    (current && model.phase !== "running" ? model.message : "正在翻译…");
  if (mode === "idle")
    return (
      <main className="edge">
        <button
          aria-label="翻译选中文字"
          title={`翻译选中文字 · ${state.shortcuts.registered[1] ? formatShortcut(state.shortcuts.bindings.selection, state.shortcuts.macos) : "快捷键未启用"}；右键打开更多操作`}
          onClick={() => void perform("capture_selection")}
          onContextMenu={(e) => {
            e.preventDefault();
            go("menu");
          }}
        >
          <Icon name="sofa" />
        </button>
      </main>
    );
  if (mode === "menu")
    return (
      <main className="entry-menu surface">
        <div className="menu-brand">
          <Icon name="sofa" />
          LingoSofa
          <button
            className="icon-button"
            aria-label="收起菜单"
            onClick={() => void perform("collapse")}
          >
            <Icon name="close" />
          </button>
        </div>
        {message && (
          <p className="menu-notice" role="status">
            {message}
          </p>
        )}
        <button onClick={() => void perform("capture_selection")}>
          <Icon name="selection" />
          翻译选中文字{" "}
          <kbd>
            {state.shortcuts.registered[1]
              ? formatShortcut(
                  state.shortcuts.bindings.selection,
                  state.shortcuts.macos,
                )
              : "快捷键未启用"}
          </kbd>
        </button>
        <button onClick={() => void perform("translate_clipboard")}>
          <Icon name="copy" />
          翻译剪贴板{" "}
          <kbd>
            {state.shortcuts.registered[2]
              ? formatShortcut(
                  state.shortcuts.bindings.clipboard,
                  state.shortcuts.macos,
                )
              : "快捷键未启用"}
          </kbd>
        </button>
        <button onClick={() => go("input")}>
          <Icon name="pen" />
          输入翻译
          <kbd>
            {state.shortcuts.registered[0]
              ? formatShortcut(
                  state.shortcuts.bindings.input,
                  state.shortcuts.macos,
                )
              : "快捷键未启用"}
          </kbd>
        </button>
        <button onClick={() => go("settings")}>
          <Icon name="settings" />
          设置
        </button>
      </main>
    );
  if (mode === "translation")
    return (
      <main className={`reading ${translationError ? "has-error" : ""}`}>
        <section
          className="annotation"
          aria-label="译文"
          title={d.translation || translation}
        >
          <p
            className={!d.translation && !translationError ? "loading" : ""}
            role="status"
          >
            {message || translation}
          </p>
        </section>
        <nav className="translation-actions" aria-label="译文操作">
          <button
            disabled={!d.translation}
            onClick={() => void perform("copy_result")}
          >
            <Icon name="copy" />
            复制
          </button>
          <button onClick={() => go("ask")}>
            <Icon name="search" />
            Ask
          </button>
          {busy && (
            <button onClick={() => void perform("cancel_task")}>停止</button>
          )}
          {translationError && !model.keyConfigured && (
            <button onClick={() => go("settings")}>添加账户</button>
          )}
          <button onClick={() => void perform("collapse")}>
            <Icon name="close" />
            收起
          </button>
        </nav>
        {context?.kind !== "selection" && (
          <span className="origin-hint">
            {contextLabel(context)} · 独立译文浮层
          </span>
        )}
      </main>
    );
  if (isAsk || isInput)
    return (
      <main className={`launcher${isInput ? " input-launcher" : ""}`}>
        <header
          className={`command-header${isInput ? " draft-header" : ""}`}
          data-tauri-drag-region
        >
          <Icon name="search" />
          {isInput ? (
            <textarea
              ref={draftInput}
              aria-label="需要翻译的原文或新问题"
              placeholder="输入文字，翻译或提问…"
              rows={1}
              maxLength={5000}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (isImeKey(e.nativeEvent)) return;
                if (
                  e.altKey &&
                  (e.key === "ArrowDown" || e.key === "ArrowUp")
                ) {
                  e.preventDefault();
                  setSelected(
                    (i) =>
                      (i +
                        (e.key === "ArrowDown" ? 1 : -1) +
                        inputActions.length) %
                      inputActions.length,
                  );
                }
                if (
                  !e.shiftKey &&
                  shouldSubmitQuestion(e.nativeEvent, busy, input)
                ) {
                  e.preventDefault();
                  execute();
                }
              }}
            />
          ) : (
            <input
              ref={queryInput}
              aria-label="Ask 问题或动作"
              placeholder={
                mode === "ask-result" ? "继续追问这段内容" : "解释这段内容"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (isImeKey(e.nativeEvent)) return;
                if (
                  mode === "ask" &&
                  (e.key === "ArrowDown" || e.key === "ArrowUp")
                ) {
                  e.preventDefault();
                  setSelected(
                    (i) =>
                      (i +
                        (e.key === "ArrowDown" ? 1 : -1) +
                        Math.max(options.length, 1)) %
                      Math.max(options.length, 1),
                  );
                }
                if (
                  shouldSubmitQuestion(
                    e.nativeEvent,
                    busy,
                    query || options[selected]?.label || "",
                  )
                ) {
                  e.preventDefault();
                  if (mode === "ask-result") {
                    if (query.trim())
                      void perform("ask_question", { question: query });
                  } else execute();
                }
              }}
            />
          )}
          <button className="sofa-mark" aria-label="返回阅读" onClick={back}>
            <Icon name="sofa" />
          </button>
        </header>
        <div className="context-bar">
          {isInput ? (
            <span className="input-label">独立输入</span>
          ) : (
            <button
              className="context-chip"
              disabled={!context}
              aria-expanded={sourceOpen}
              onClick={() => setSourceOpen(!sourceOpen)}
            >
              <Icon name="selection" />
              {contextLabel(context)}
            </button>
          )}
          {context && !isInput && (
            <button
              className="clear-context"
              title="移除当前原文并新建会话"
              aria-label="移除当前原文"
              onClick={() => void perform("clear_context")}
            >
              <Icon name="close" />
            </button>
          )}
          <span className="context-origin">
            {isInput ? "" : context?.origin || "不引用其他阅读会话"}
            {isInput
              ? input
                ? `${Array.from(input).length} 字符`
                : ""
              : context
                ? ` · ${Array.from(context.text).length} 字符`
                : ""}
          </span>
          <button
            className="icon-button"
            title="设置"
            aria-label="设置"
            onClick={() => go("settings")}
          >
            <Icon name="settings" />
          </button>
        </div>
        {sourceOpen && context && !isInput && (
          <section className="source-peek" aria-label="本次原文">
            {context.text}
          </section>
        )}
        {mode === "ask" || isInput ? (
          <section className="action-list" aria-label="匹配动作">
            <div className="list-caption">
              <span>
                {isInput ? "选择动作" : query ? "匹配动作" : "选择一个动作"}
              </span>
              <span>
                {isInput
                  ? "仅在执行时发送文本"
                  : context
                    ? "保留当前原文"
                    : "独立提问"}
              </span>
            </div>
            {visibleActions.map((action, index) => (
              <button
                key={action.id}
                className={`action ${index === selected ? "selected" : ""}`}
                disabled={busy || (isInput && !input.trim())}
                onMouseEnter={() => setSelected(index)}
                onClick={() =>
                  isInput
                    ? void perform(
                        action.id === "question"
                          ? "ask_text"
                          : "translate_text",
                        { text: input },
                      )
                    : void perform("ask_question", {
                        question: action.question,
                      })
                }
              >
                <span className="action-icon">
                  <Icon name={action.icon} />
                </span>
                <span className="action-copy">
                  <strong>{action.label}</strong>
                  <small>{action.detail}</small>
                </span>
                <span className="action-tag">{action.tag}</span>
                {index === selected && <span className="enter-key">↵</span>}
              </button>
            ))}
            {!isInput && options.length === 0 && (
              <button
                className="action selected"
                disabled={busy || !query.trim()}
                onClick={execute}
              >
                <span className="action-icon">
                  <Icon name="chat" />
                </span>
                <span className="action-copy">
                  <strong>围绕{context ? "原文" : "这个问题"}提问</strong>
                  <small>{query}</small>
                </span>
                <span className="enter-key">↵</span>
              </button>
            )}
            {busy && (
              <p className="quiet-status">
                模型仍在处理当前任务。
                <button onClick={() => void perform("cancel_task")}>
                  停止
                </button>
              </p>
            )}
          </section>
        ) : (
          <section className="answer-section">
            <div className="list-caption">
              <span>
                {d.operation === "translate"
                  ? "译文 · 可继续追问"
                  : "围绕当前原文"}
              </span>
              <button
                onClick={() => {
                  void perform("cancel_task");
                  go("ask");
                }}
              >
                返回动作
              </button>
            </div>
            <div className="answer" ref={answer} aria-live="polite">
              {current ? model.output || model.message : "正在准备回答…"}
            </div>
            <div className="answer-tools">
              <button
                disabled={!current || !model.output}
                onClick={() => void perform("copy_result")}
              >
                <Icon name="copy" />
                复制
              </button>
              {busy ? (
                <button onClick={() => void perform("cancel_task")}>
                  停止生成
                </button>
              ) : (
                <button
                  disabled={!model.sessionReady}
                  title="整理上下文并保留要点，会产生模型调用"
                  onClick={() => void perform("compact_session")}
                >
                  压缩会话
                </button>
              )}
              <span>
                {model.reportedTokens.toLocaleString()} tokens
                {model.unknownCalls
                  ? ` · ${model.unknownCalls} 次用量不完整`
                  : ""}
              </span>
            </div>
          </section>
        )}
        <footer className="launcher-footer">
          <span>
            {message ||
              (current && model.phase === "error"
                ? model.message
                : isInput
                  ? `${formatShortcut("Enter", state.shortcuts.macos)} 执行 · ${formatShortcut("Shift+Enter", state.shortcuts.macos)} 换行 · ${formatShortcut("Alt+↑↓", state.shortcuts.macos)} 选择`
                  : mode === "ask"
                    ? `↑↓ 选择\u3000 ${state.shortcuts.macos ? "↩" : "↵"} 执行\u3000 Esc 返回阅读`
                    : `输入问题后 ${formatShortcut("Enter", state.shortcuts.macos)} 继续 · Esc 返回动作`)}
          </span>
          <span>{isInput ? "Esc 收起" : "Ask 模式 · 主动展开"}</span>
        </footer>
      </main>
    );
  return (
    <Settings
      state={state}
      notice={message}
      perform={perform}
      onBack={back}
      loadCatalog={loadModelCatalog}
    />
  );
}
