import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isImeKey } from "./api";
import {
  readingHash,
  readReading,
  saveReading,
  useReadingPosition,
} from "./reading-position";
import { HighlightedCode } from "./highlighted-code";
import type { Perform } from "./view";

const ReadingScope = React.createContext<string | null>(null);
const AnswerActions = React.createContext<Perform | undefined>(undefined);
const AnswerReading = React.createContext<(() => void) | undefined>(undefined);
const markdownComponents: Components = {
  img: ({ alt }) => (
    <span className="answer-image-label">
      {alt ? `[图片：${alt}]` : "[图片]"}
    </span>
  ),
  a: AnswerLink,
  pre: CodeBlock,
  table: AnswerTable,
};

export function CopyButton({
  label,
  onCopy,
  preserveSelection = false,
  disabled = false,
  icon,
  showFailureNotice = true,
}: {
  label: string;
  onCopy: () => Promise<void | boolean>;
  preserveSelection?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  showFailureNotice?: boolean;
}) {
  const [status, setStatus] = useState<
    "idle" | "pending" | "copied" | "failed"
  >("idle");
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (status !== "copied") return;
    const timeout = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timeout);
  }, [status]);
  return (
    <span className="copy-control">
      <button
        aria-label={label}
        disabled={disabled || status === "pending"}
        onPointerDown={(event) => {
          if (preserveSelection && event.button === 0) event.preventDefault();
        }}
        onClick={async () => {
          if (locked.current || disabled) return;
          locked.current = true;
          setStatus("pending");
          try {
            const success = await onCopy();
            if (mounted.current)
              setStatus(success === false ? "failed" : "copied");
          } catch {
            if (mounted.current) setStatus("failed");
          } finally {
            locked.current = false;
          }
        }}
      >
        {icon}
        {status === "pending"
          ? "复制中…"
          : status === "copied"
            ? "已复制"
            : status === "failed"
              ? "重试复制"
              : label}
      </button>
      <span
        className={
          status === "failed" && showFailureNotice
            ? "copy-error"
            : "copy-announcement"
        }
        role="status"
      >
        {status === "failed" && showFailureNotice
          ? "复制失败，请重试"
          : status === "copied"
            ? `${label}成功`
            : ""}
      </span>
    </span>
  );
}

function contentText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contentText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return contentText(node.props.children);
  return "";
}

function CodeBlock({
  children,
  node,
}: React.ComponentProps<"pre"> & {
  node?: { position?: { start: { offset?: number } } };
}) {
  const text = contentText(children);
  const scope = React.useContext(ReadingScope);
  const storageKey = scope
    ? `${scope}:code:${node?.position?.start.offset ?? 0}:${readingHash(text)}`
    : null;
  const saved = readReading<{
    wrap: boolean;
    numbers: boolean;
    expanded: boolean;
  }>(storageKey);
  const pre = useRef<HTMLPreElement>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [line, setLine] = useState("");
  const [lineError, setLineError] = useState("");
  const [targetLine, setTargetLine] = useState(0);
  const lineInput = useRef<HTMLInputElement>(null);
  const perform = React.useContext(AnswerActions);
  const [wrap, setWrap] = useState(saved?.wrap === true);
  const [numbers, setNumbers] = useState(saved?.numbers !== false);
  const block = useRef<HTMLElement>(null);
  const revealAfterCollapse = useRef(false);
  const [expanded, setExpanded] = useState(saved?.expanded === true);
  const inspect = React.useContext(AnswerReading);
  useLayoutEffect(() => {
    if (revealAfterCollapse.current) {
      block.current?.scrollIntoView({ block: "nearest" });
      revealAfterCollapse.current = false;
    }
  }, [expanded]);
  useReadingPosition(pre, storageKey ? `${storageKey}:position` : null);
  useEffect(() => {
    saveReading(storageKey, { wrap, numbers, expanded });
  }, [storageKey, wrap, numbers, expanded]);
  useEffect(() => {
    if (jumpOpen) lineInput.current?.focus();
  }, [jumpOpen]);
  const code = React.Children.toArray(children).find((child) =>
    React.isValidElement(child),
  );
  const language = React.isValidElement<{ className?: string }>(code)
    ? code.props.className?.match(/language-(\S+)/)?.[1]
    : undefined;
  const lines = text.replace(/\n$/, "").split("\n").length;
  return (
    <section
      ref={block}
      className={`code-block${wrap ? " is-wrapped" : ""}${expanded ? " is-expanded" : ""}`}
      aria-label={`${language || "text"} 代码块`}
      onKeyDown={(event) => {
        if (isImeKey(event.nativeEvent)) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "g"
        ) {
          event.preventDefault();
          event.stopPropagation();
          inspect?.();
          setJumpOpen(true);
          lineInput.current?.focus();
        }
      }}
    >
      <div className="content-toolbar">
        <span className="content-kind">
          {language || "text"} <span>· {lines} 行</span>
        </span>
        <div className="content-controls">
          <button
            title="代码内 Ctrl+G / ⌘G"
            onClick={() => {
              inspect?.();
              setJumpOpen(!jumpOpen);
            }}
          >
            跳行
          </button>
          <button
            aria-pressed={numbers}
            onClick={() => {
              inspect?.();
              setNumbers(!numbers);
            }}
          >
            行号
          </button>
          <button
            aria-pressed={wrap}
            onClick={() => {
              inspect?.();
              setWrap(!wrap);
            }}
          >
            自动换行
          </button>
          {lines > 12 && (
            <button
              aria-expanded={expanded}
              onClick={() => {
                inspect?.();
                revealAfterCollapse.current = expanded;
                setExpanded(!expanded);
              }}
            >
              {expanded ? "限制高度" : "展开全部"}
            </button>
          )}
          {perform && (
            <CopyButton
              label="复制代码"
              onCopy={() => perform("copy_text", { text })}
            />
          )}
        </div>
      </div>
      {jumpOpen && (
        <form
          className="code-jump"
          onSubmit={(event) => {
            event.preventDefault();
            const number = Number(line);
            if (
              !/^\d+$/.test(line) ||
              !Number.isInteger(number) ||
              number < 1 ||
              number > lines
            ) {
              setLineError(`请输入 1–${lines} 的行号`);
              return;
            }
            inspect?.();
            setLineError("");
            setTargetLine(number);
            block.current
              ?.querySelector<HTMLElement>(`.code-line[data-line="${number}"]`)
              ?.scrollIntoView({ block: "center", inline: "nearest" });
            pre.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isImeKey(event.nativeEvent)) {
              event.preventDefault();
              return;
            }
            if (event.key === "Escape" && !isImeKey(event.nativeEvent)) {
              event.preventDefault();
              event.stopPropagation();
              setJumpOpen(false);
              pre.current?.focus({ preventScroll: true });
            }
          }}
        >
          <label>
            行号{" "}
            <input
              ref={lineInput}
              aria-label="跳转到代码行"
              inputMode="numeric"
              value={line}
              onChange={(event) => setLine(event.target.value)}
              placeholder={`1–${lines}`}
            />
          </label>
          <button type="submit">前往</button>
          <span role="status">
            {lineError ||
              (targetLine ? `已定位第 ${targetLine} 行` : `共 ${lines} 行`)}
          </span>
          <button
            type="button"
            aria-label="关闭跳行"
            onClick={() => {
              setJumpOpen(false);
              pre.current?.focus({ preventScroll: true });
            }}
          >
            关闭
          </button>
        </form>
      )}
      <pre
        ref={pre}
        tabIndex={0}
        aria-label="代码内容"
        onPointerDown={() => inspect?.()}
        onKeyDown={() => inspect?.()}
      >
        <HighlightedCode
          text={text}
          language={(language || "text").toLowerCase()}
          numbers={numbers}
          targetLine={targetLine}
        />
      </pre>
    </section>
  );
}

function AnswerTable({ children }: React.ComponentProps<"table">) {
  const scope = React.useContext(ReadingScope);
  const storageKey = scope
    ? `${scope}:table:${readingHash(contentText(children))}`
    : null;
  const saved = readReading<{ expanded: boolean }>(storageKey);
  const container = useRef<HTMLDivElement>(null);
  useReadingPosition(container, storageKey ? `${storageKey}:position` : null);
  const perform = React.useContext(AnswerActions);
  const table = useRef<HTMLTableElement>(null);
  const [expanded, setExpanded] = useState(saved?.expanded === true);
  useEffect(() => {
    saveReading(storageKey, { expanded });
  }, [storageKey, expanded]);
  const inspect = React.useContext(AnswerReading);
  const copy = () => {
    const text = Array.from(table.current?.rows ?? [])
      .map((row) =>
        Array.from(row.cells)
          .map((cell) => {
            const value = cell.innerText ?? cell.textContent ?? "";
            return /[\t\n\r"]/.test(value)
              ? `"${value.replace(/"/g, '""')}"`
              : value;
          })
          .join("\t"),
      )
      .join("\n");
    return perform!("copy_text", { text });
  };
  return (
    <section
      className={`table-block${expanded ? " is-expanded" : ""}`}
      aria-label="回答表格"
    >
      <div className="content-toolbar">
        <span className="content-kind">
          表格 <span>· 可横向滚动</span>
        </span>
        <div className="content-controls">
          <button
            aria-expanded={expanded}
            onClick={() => {
              inspect?.();
              setExpanded(!expanded);
            }}
          >
            {expanded ? "限制表格高度" : "展开表格"}
          </button>
          {perform && <CopyButton label="复制表格" onCopy={copy} />}
        </div>
      </div>
      <div
        ref={container}
        className="answer-table"
        tabIndex={0}
        aria-label="表格内容"
      >
        <table ref={table}>{children}</table>
      </div>
    </section>
  );
}
function AnswerLink({ children, href }: React.ComponentProps<"a">) {
  const perform = React.useContext(AnswerActions);
  return (
    <span className="answer-link">
      {perform && href && /^https?:\/\//i.test(href) ? (
        <button
          className="answer-link-button"
          title={`在浏览器中打开：${href}`}
          onClick={() => void perform("open_external_url", { url: href })}
        >
          {children} ↗
        </button>
      ) : (
        children
      )}
      {href && href !== String(children) && (
        <span className="answer-link-url"> ({href})</span>
      )}
    </span>
  );
}
export function AnswerMarkdown({
  text,
  perform,
  onInspect,
  readingKey,
}: {
  text: string;
  perform?: Perform;
  onInspect?: () => void;
  readingKey?: string;
}) {
  const prose = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const owned =
        selection &&
        !selection.isCollapsed &&
        prose.current?.contains(selection.anchorNode) &&
        prose.current?.contains(selection.focusNode);
      const value = owned ? selection.toString() : "";
      setSelected(value);
      if (value) onInspect?.();
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [onInspect]);
  return (
    <ReadingScope.Provider value={readingKey ?? null}>
      <AnswerActions.Provider value={perform}>
        <AnswerReading.Provider value={onInspect}>
          <div
            className="answer-prose"
            ref={prose}
            onCopy={(event) => {
              const selection = document.getSelection();
              if (
                selection &&
                !selection.isCollapsed &&
                prose.current?.contains(selection.anchorNode) &&
                prose.current?.contains(selection.focusNode)
              ) {
                event.clipboardData.setData("text/plain", selection.toString());
                event.preventDefault();
              }
            }}
          >
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={markdownComponents}
            >
              {text}
            </Markdown>
            {selected && perform && (
              <div className="selection-actions" data-no-drag>
                <CopyButton
                  label="复制选中内容"
                  preserveSelection
                  onCopy={() => perform("copy_text", { text: selected })}
                />
              </div>
            )}
          </div>
        </AnswerReading.Provider>
      </AnswerActions.Provider>
    </ReadingScope.Provider>
  );
}
