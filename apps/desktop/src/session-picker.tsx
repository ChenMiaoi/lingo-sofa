import React, { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  isImeKey,
  type LoadSessions,
  type SessionInfo,
} from "./api";
import type { Perform } from "./view";

export function SessionPicker({
  search,
  load,
  perform,
  onClose,
}: {
  search: string;
  load: LoadSessions;
  perform: Perform;
  onClose: (applied?: boolean) => void;
}) {
  const [query, setQuery] = useState(search);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    input.current?.focus();
    void load()
      .then(
        (value) => {
          if (!disposed) {
            setSessions(value.sessions);
            setTotal(value.total);
          }
        },
        () => {
          if (!disposed) setError("无法读取会话历史，请重试。");
        },
      )
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [load]);
  const choices = sessions.filter((item) =>
    `${item.title} ${item.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    input.current
      ?.closest("main")
      ?.querySelector(".action.selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const choose = async (item?: SessionInfo) => {
    if (!item || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const applied = await perform("session_request", {
        request: { action: "resume", id: item.id },
      });
      if (applied !== false) onClose(true);
      else setError("恢复失败，请检查模型凭证与会话文件后重试。");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <main
      className="launcher model-picker"
      aria-label="会话历史"
      onKeyDown={(event) => {
        if (isImeKey(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!saving) onClose();
        }
      }}
    >
      <header className="command-header" data-tauri-drag-region>
        <span className="model-picker-prefix">/resume</span>
        <input
          ref={input}
          aria-label="搜索会话"
          placeholder="搜索标题或会话 ID…"
          value={query}
          disabled={saving}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKey(event.nativeEvent) || event.shiftKey) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    Math.max(choices.length, 1)) %
                  Math.max(choices.length, 1),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              void choose(choices[selected]);
            }
          }}
        />
        <button
          onClick={() => onClose()}
          disabled={saving}
          aria-label="返回会话"
        >
          Esc
        </button>
      </header>
      <section className="action-list" aria-label="历史会话列表">
        <div className="list-caption">
          <span>{loading ? "正在读取…" : `${total} 个会话`}</span>
          <span>保存在本机</span>
        </div>
        {choices.map((item, index) => (
          <button
            key={item.id}
            className={`action ${selected === index ? "selected" : ""}`}
            disabled={saving}
            onMouseEnter={() => setSelected(index)}
            onClick={() => void choose(item)}
          >
            <span className="action-copy">
              <strong>{item.title}</strong>
              <small>
                {new Date(item.modified).toLocaleString()} · {item.messageCount}{" "}
                条消息
              </small>
            </span>
            <span className="enter-key">↵</span>
          </button>
        ))}
        {!loading && !choices.length && (
          <p className="quiet-status">
            {sessions.length ? "没有匹配的会话" : "暂无历史会话"}
          </p>
        )}
        {sessions.length < total && (
          <button
            disabled={loading || saving}
            onClick={() => {
              setLoading(true);
              void load(sessions.length)
                .then(
                  (value) => {
                    setSessions((current) => [...current, ...value.sessions]);
                    setTotal(value.total);
                  },
                  () => setError("加载失败，请重试。"),
                )
                .finally(() => setLoading(false));
            }}
          >
            加载更多会话
          </button>
        )}
      </section>
      <footer className="launcher-footer">
        <span role={error ? "alert" : undefined}>
          {error || (saving ? "正在恢复…" : "↑↓ 选择 · Enter 恢复 · Esc 返回")}
        </span>
      </footer>
    </main>
  );
}
