import { listIndex } from "./keyboard";
import { dragWindow } from "./window-drag";
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
  currentId,
  load,
  perform,
  onClose,
}: {
  search: string;
  currentId?: string | null;
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
  const [reload, setReload] = useState(0);
  const [snapshot, setSnapshot] = useState<string>();
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    generation.current++;
    input.current?.focus();
    setLoading(true);
    setError("");
    setSessions([]);
    setTotal(0);
    setSnapshot(undefined);
    setSelected(0);
    void (async () => {
      try {
        const value = await load(0, query);
        if (disposed) return;
        setSessions(value.sessions);
        setTotal(value.total);
        setSnapshot(value.snapshot);
      } catch {
        if (!disposed) setError("会话历史未加载完整，请重试。");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      generation.current++;
    };
  }, [load, reload, query]);
  const choices = sessions;
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    input.current
      ?.closest("main")
      ?.querySelector(".action.selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const more = async () => {
    if (loading || saving) return;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await load(sessions.length, query, snapshot);
      if (version !== generation.current) return;
      if (!value.sessions.length && sessions.length < value.total)
        throw new Error("incomplete_history");
      setSessions((previous) => [
        ...previous,
        ...value.sessions.filter(
          (item) => !previous.some((old) => old.id === item.id),
        ),
      ]);
      setTotal(value.total);
    } catch {
      if (version === generation.current)
        setError("会话历史未加载完整，请重试。");
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
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
      className="launcher model-picker selection-page"
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
      <header className="command-header" onMouseDown={dragWindow}>
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
            const next = listIndex(event.key, selected, choices.length);
            if (next !== null) {
              event.preventDefault();
              setSelected(next);
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
          返回
        </button>
      </header>
      <section className="action-list" aria-label="历史会话列表">
        <div className="list-caption">
          <span>
            {loading
              ? "正在读取…"
              : error
                ? "读取未完成"
                : query.trim()
                  ? `${choices.length} / ${total} 个会话`
                  : `${total} 个会话`}
          </span>
          <span>保存在本机</span>
        </div>
        {choices.map((item, index) => (
          <button
            key={item.id}
            className={`action ${selected === index ? "selected" : ""}`}
            aria-current={item.id === currentId ? "true" : undefined}
            disabled={saving}
            onMouseMove={(event) => {
              if (event.movementX || event.movementY) setSelected(index);
            }}
            onClick={() => void choose(item)}
          >
            <span className="action-copy">
              <strong title={item.title}>{item.title}</strong>
              <small>
                {new Date(item.modified).toLocaleString()} · {item.messageCount}{" "}
                条消息
              </small>
            </span>
            {item.id === currentId && (
              <span className="current-badge">当前</span>
            )}
            {selected === index && (
              <span className="enter-key" aria-hidden="true">
                ↵
              </span>
            )}
          </button>
        ))}
        {!loading && !error && !choices.length && (
          <p className="quiet-status">
            {query.trim() ? "没有匹配的会话" : "暂无历史会话"}
            {query.trim() && (
              <>
                {" "}
                <button
                  disabled={saving}
                  onClick={() => {
                    setQuery("");
                    input.current?.focus();
                  }}
                >
                  清空搜索
                </button>
              </>
            )}
          </p>
        )}
        {sessions.length < total && !error && (
          <button disabled={loading || saving} onClick={() => void more()}>
            加载更多会话
          </button>
        )}
        {error && (
          <button
            disabled={loading || saving}
            onClick={() => setReload((value) => value + 1)}
          >
            重新加载会话
          </button>
        )}
      </section>
      <footer className="launcher-footer">
        <span role={error ? "alert" : undefined}>
          {error ||
            (saving
              ? "正在恢复…"
              : "↑↓ 选择 · PgUp/PgDn 翻页 · Enter 恢复 · Esc 返回")}
        </span>
      </footer>
    </main>
  );
}
