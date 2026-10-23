import React, { useEffect, useRef, useState } from "react";
import {
  isImeKey,
  type View,
  type LoadActivity,
  type SessionTurn,
} from "./api";
import type { Perform } from "./view";

import { AnswerSearch } from "./answer-search";
import { readingHash, useReadingPosition } from "./reading-position";
import { AnswerMarkdown, CopyButton } from "./answer-markdown";
export { AnswerMarkdown } from "./answer-markdown";

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function parameterLabel(text: string) {
  const value = parseObject(text);
  if (!value) return text;
  for (const key of ["path", "command", "pattern", "query"])
    if (typeof value[key] === "string") return value[key];
  return "查看参数";
}

function ActivityDetails({
  className,
  label,
  summary,
  children,
  onInspect,
}: {
  className: string;
  label: string;
  summary: React.ReactNode;
  children: React.ReactNode;
  onInspect: () => void;
}) {
  return (
    <details
      className={className}
      onToggle={(event) => {
        if (event.currentTarget.open) onInspect();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !isImeKey(event.nativeEvent) &&
          event.currentTarget.open
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label}>
        {summary}
        <span className="activity-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {children}
    </details>
  );
}
export function toolRows(events: View["toolCalls"], busy: boolean) {
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      args: string;
      result: string;
      status: "running" | "done" | "error" | "interrupted";
    }
  >();
  for (const event of events) {
    const previous = rows.get(event.id);
    rows.set(event.id, {
      id: event.id,
      name: event.name,
      args:
        event.type === "tool_execution_start"
          ? event.text
          : (previous?.args ?? ""),
      result:
        event.type === "tool_execution_end"
          ? event.text
          : (previous?.result ?? ""),
      status:
        event.type === "tool_execution_end"
          ? event.isError
            ? "error"
            : "done"
          : busy
            ? "running"
            : "interrupted",
    });
  }
  return [...rows.values()];
}
function compactNumber(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : value.toLocaleString();
}
function dollars(value: number, detailed = false) {
  if (value > 0 && value < 0.0001)
    return detailed ? `$${value.toPrecision(4)}` : "<$0.0001";
  return `$${value.toFixed(detailed || (value > 0 && value < 0.01) ? 4 : 2)}`;
}

function Usage({ model }: { model: View }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tokens = model.sessionStats?.tokens;
  const unknown = model.sessionUnpricedCalls;
  const haveUsage =
    model.sessionStats !== null ||
    model.sessionEstimatedCost > 0 ||
    unknown > 0;
  const price = !haveUsage
    ? "费用待结算"
    : unknown && !model.sessionEstimatedCost
      ? "费用未知"
      : `${dollars(model.sessionEstimatedCost)}${unknown ? " + ?" : ""}`;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="usage-control"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="usage-trigger"
        aria-label="用量与费用"
        aria-expanded={open}
        aria-controls="answer-usage"
        onClick={() => setOpen(!open)}
      >
        <span className="token-counter" title="当前会话：输入 / 输出 Tokens">
          ↑ {compactNumber(tokens?.input ?? 0)}{" "}
          <span>↓ {compactNumber(tokens?.output ?? 0)}</span>
        </span>
        <span className="price-counter">{price}</span>
        <span className="disclosure-glyph">{open ? "⌄" : "⌃"}</span>
      </button>
      {open && (
        <div
          ref={panel}
          id="answer-usage"
          className="usage-panel"
          role="region"
          aria-label="费用明细"
        >
          <div className="usage-heading">
            <strong>当前会话</strong>
            <span>USD · 估算</span>
          </div>
          <dl className="usage-grid">
            <div>
              <dt>输入</dt>
              <dd>{(tokens?.input ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{(tokens?.output ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>思考</dt>
              <dd>{(tokens?.reasoning ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>工具调用</dt>
              <dd>{model.sessionStats?.toolCalls ?? 0}</dd>
            </div>
            <div>
              <dt>缓存读取</dt>
              <dd>{(tokens?.cacheRead ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>缓存写入</dt>
              <dd>{(tokens?.cacheWrite ?? 0).toLocaleString()}</dd>
            </div>
          </dl>
          <div className="usage-total">
            <span>当前已知估算</span>
            <strong>{dollars(model.sessionEstimatedCost, true)}</strong>
          </div>
          {!!unknown && <p className="usage-note">{unknown} 次费用未知</p>}
          <div className="usage-lifetime">
            <span>累计 {compactNumber(model.reportedTokens)} tokens</span>
            <span>{dollars(model.estimatedCost, true)}</span>
          </div>
          {!!model.unpricedCalls && (
            <p className="usage-note">累计 {model.unpricedCalls} 次费用未知</p>
          )}
          {!!model.unknownCalls && (
            <p className="usage-note">{model.unknownCalls} 次用量不完整</p>
          )}
          <p className="usage-note">估算仅供参考，不代表账单或订阅余额。</p>
        </div>
      )}
    </div>
  );
}

export function AskAnswer({
  model,
  current,
  busy,
  operation,
  perform,
  onActions,
  loadActivity,
}: {
  model: View;
  current: boolean;
  busy: boolean;
  operation: string;
  perform: Perform;
  onActions: () => void;
  loadActivity?: LoadActivity;
}) {
  const [history, setHistory] = useState(false);
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [archive, setArchive] = useState<{
    key: string;
    turns: SessionTurn[];
  } | null>(null);
  const [archiveError, setArchiveError] = useState(false);
  const [retry, setRetry] = useState(0);
  const archiveKey = `${model.sessionId}:${model.revision}:${busy}`;
  const turns = archive?.key === archiveKey ? archive.turns : null;
  const restored = !busy ? turns?.at(-1) : undefined;
  const answerText = restored?.output ?? model.output;
  const thinkingOutput = restored?.thinkingOutput ?? model.thinkingOutput;
  const tools = toolRows(restored?.toolCalls ?? model.toolCalls, busy);
  useEffect(() => {
    const controller = new AbortController();
    setArchiveError(false);
    if (
      current &&
      !busy &&
      model.sessionReady &&
      model.sessionId &&
      loadActivity
    ) {
      void loadActivity(model.sessionId, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted)
            setArchive({ key: archiveKey, turns: result.turns });
        })
        .catch(() => {
          if (!controller.signal.aborted) setArchiveError(true);
        });
    }
    return () => controller.abort();
  }, [archiveKey, current, model.sessionReady, loadActivity, retry]);
  const inspectActivity = () => {
    follow.current = false;
    setFollowing(false);
  };
  useEffect(() => {
    setHistory(false);
    follow.current = busy;
    setFollowing(true);
  }, [model.revision]);
  useEffect(() => {
    if (
      busy &&
      follow.current &&
      !history &&
      !model.toolApprovals.length &&
      scroll.current
    )
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [
    busy,
    model.output,
    model.thinkingOutput,
    model.toolCalls,
    model.toolApprovals.length,
    history,
  ]);
  const readingKey =
    model.sessionId && !busy && (turns || !loadActivity || !model.sessionReady)
      ? `${model.sessionId}:${history ? "history" : restored?.id || readingHash(model.question + answerText)}`
      : null;
  useReadingPosition(scroll, readingKey, inspectActivity);
  const phase = model.toolApprovals.length
    ? "等待确认"
    : busy
      ? model.phase === "compacting"
        ? "正在整理上下文"
        : tools.some((tool) => tool.status === "running")
          ? "工具执行中"
          : model.thinkingOutput && !model.output
            ? "正在思考"
            : "正在回答"
      : ["error", "truncated", "incomplete"].includes(model.phase)
        ? "回答未完成"
        : operation === "translate"
          ? "译文"
          : "回答";
  return (
    <section className="answer-section" aria-label="Ask 回答">
      <div className="answer-caption">
        <span
          className={`answer-phase${busy ? " is-active" : ""}`}
          role="status"
        >
          <i aria-hidden="true" />
          {history ? "会话记录" : phase}
        </span>
        <div>
          {current && answerText && !history && (
            <CopyButton
              label="复制回答"
              onCopy={() => perform("copy_text", { text: answerText })}
            />
          )}
          {(model.messages.length > 0 || !!turns?.length) && (
            <button aria-pressed={history} onClick={() => setHistory(!history)}>
              {history ? "当前回答" : `会话记录 · ${model.messageCount}`}
            </button>
          )}
          <details
            className="answer-menu"
            onKeyDown={(event) => {
              if (event.key === "Escape" && event.currentTarget.open) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary aria-label="会话操作" title="会话操作">
              •••
            </summary>
            <div className="answer-actions">
              <button onClick={onActions}>返回动作</button>
              {busy ? (
                <button
                  className="stop-generation"
                  onClick={() => void perform("cancel_task")}
                >
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
            </div>
          </details>
          {busy && (
            <button
              className="stop-generation"
              onClick={() => void perform("cancel_task")}
            >
              停止
            </button>
          )}
        </div>
      </div>
      <AnswerSearch
        key={`${model.sessionId}:${model.revision}:${history}`}
        root={scroll}
        content={history ? turns || model.messages : answerText}
        onInspect={inspectActivity}
      />
      {archiveError && (
        <div className="activity-load-status" role="status">
          完整过程加载失败。
          <button onClick={() => setRetry(retry + 1)}>重试加载完整过程</button>
        </div>
      )}
      {!archiveError &&
        !turns &&
        !busy &&
        model.sessionId &&
        model.sessionReady &&
        loadActivity && (
          <div className="activity-load-status" role="status">
            正在读取完整会话记录…
          </div>
        )}
      <div
        className="answer"
        ref={scroll}
        tabIndex={0}
        aria-label={history ? "会话记录内容" : "回答内容"}
        onScroll={() => {
          const field = scroll.current;
          if (!field) return;
          follow.current =
            field.scrollHeight - field.scrollTop - field.clientHeight < 48;
          setFollowing(follow.current);
        }}
      >
        {history ? (
          <div className="conversation-history">
            <p className="history-notice">
              {turns
                ? `${turns.length} 轮完整记录 · 保存在本机`
                : `最近 ${model.messages.length} 条消息摘要 · ${archiveError ? "完整记录暂不可用" : "正在读取完整记录"}`}
            </p>
            {turns
              ? turns.map((turn, index) => (
                  <ActivityDetails
                    key={turn.id}
                    className="history-turn"
                    label={`第 ${index + 1} 轮完整记录`}
                    onInspect={inspectActivity}
                    summary={
                      <>
                        <span>第 {index + 1} 轮</span>
                        <span className="thinking-preview">
                          {turn.question}
                        </span>
                      </>
                    }
                  >
                    <div className="question-block">
                      <p>{turn.question}</p>
                    </div>
                    <ActivityBody
                      thinkingOutput={turn.thinkingOutput}
                      tools={toolRows(turn.toolCalls, false)}
                      phase="思考过程"
                      revision={0}
                      perform={perform}
                      inspectActivity={inspectActivity}
                    />
                    <AnswerMarkdown
                      readingKey={`${model.sessionId}:history:${turn.id}`}
                      text={turn.output || "本轮暂无可恢复的回答。"}
                      perform={perform}
                    />
                  </ActivityDetails>
                ))
              : model.messages.map((message, index) => (
                  <article
                    className={`history-message role-${message.role}`}
                    key={index}
                  >
                    <div className="message-author">
                      {message.role === "user"
                        ? "你"
                        : message.role === "assistant"
                          ? "助手"
                          : "工具 / 上下文"}
                    </div>
                    <AnswerMarkdown perform={perform} text={message.content} />
                    {message.truncated && (
                      <span className="history-notice">显示摘要已截断</span>
                    )}
                  </article>
                ))}
          </div>
        ) : (
          <>
            {operation === "ask" && model.question && (
              <div className="question-block" aria-label="本轮提问">
                <span className="question-glyph" aria-hidden="true">
                  ›
                </span>
                <p>{model.question}</p>
              </div>
            )}
            <ActivityBody
              thinkingOutput={thinkingOutput}
              tools={tools}
              phase={phase}
              revision={model.revision}
              perform={perform}
              inspectActivity={inspectActivity}
            />
            {model.toolApprovals.map((item) => (
              <ToolApproval key={item.id} approval={item} perform={perform} />
            ))}
            <div className="answer-response" aria-busy={busy}>
              {current && answerText ? (
                <AnswerMarkdown
                  key={readingKey || "live"}
                  readingKey={readingKey || undefined}
                  perform={perform}
                  text={answerText}
                  onInspect={inspectActivity}
                />
              ) : busy &&
                (model.toolApprovals.length ||
                  model.thinkingOutput ||
                  tools.length) ? null : (
                <p className="answer-pending">
                  {current
                    ? busy
                      ? `${phase}…`
                      : model.question && model.phase !== "error"
                        ? "本轮无可恢复的回答。"
                        : model.message
                    : "正在准备回答…"}
                </p>
              )}
            </div>
            {current &&
              answerText &&
              ["error", "truncated", "incomplete"].includes(model.phase) && (
                <p className="answer-error" role="alert">
                  {model.message}
                </p>
              )}
          </>
        )}
      </div>
      {!following && !history && !model.toolApprovals.length && (
        <button
          className="follow-answer"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
          }}
        >
          ↓ 回到最新回答
        </button>
      )}
    </section>
  );
}

function ActivityBody({
  thinkingOutput,
  tools,
  phase,
  revision,
  perform,
  inspectActivity,
}: {
  thinkingOutput: string;
  tools: ReturnType<typeof toolRows>;
  phase: string;
  revision: number;
  perform: Perform;
  inspectActivity: () => void;
}) {
  return (
    <>
      {" "}
      {thinkingOutput && (
        <ActivityDetails
          key={revision}
          className="thinking-row"
          label="思考过程"
          onInspect={inspectActivity}
          summary={
            <>
              <span className="thinking-mark" aria-hidden="true">
                ✧
              </span>
              {phase === "正在思考" ? "正在思考" : "思考过程"}
              <span className="thinking-preview">
                {thinkingOutput
                  .trim()
                  .split("\n")
                  .find((line) => line.trim())}
              </span>
              <span className="tool-status">
                {phase === "正在思考" ? "生成中" : "查看过程"}
              </span>
            </>
          }
        >
          <div className="thinking-body" tabIndex={0} aria-label="思考过程内容">
            <AnswerMarkdown perform={perform} text={thinkingOutput} />
          </div>
        </ActivityDetails>
      )}
      {tools.length > 0 && (
        <div className="tool-timeline" aria-label="工具调用">
          <div className="activity-caption">
            <span>工具调用 · {tools.length}</span>
            <span>
              {tools.filter((tool) => tool.status === "done").length} 完成
              {tools.some((tool) => tool.status === "error")
                ? ` · ${tools.filter((tool) => tool.status === "error").length} 失败`
                : ""}
            </span>
          </div>
          {tools.map((tool) => (
            <div className="tool-entry" key={tool.id}>
              <ActivityDetails
                className={`tool-row status-${tool.status}`}
                label={`${tool.name} 调用详情`}
                onInspect={inspectActivity}
                summary={
                  <>
                    <span className="tool-state" aria-hidden="true">
                      {tool.status === "running"
                        ? "◌"
                        : tool.status === "error"
                          ? "!"
                          : tool.status === "interrupted"
                            ? "−"
                            : "✓"}
                    </span>
                    <strong>
                      {tool.name.charAt(0).toUpperCase() + tool.name.slice(1)}
                    </strong>
                    <code title={parameterLabel(tool.args)}>
                      {parameterLabel(tool.args)}
                    </code>
                    <span className="tool-status">
                      {tool.status === "running"
                        ? "执行中"
                        : tool.status === "error"
                          ? "失败"
                          : tool.status === "interrupted"
                            ? "已停止"
                            : "完成"}
                    </span>
                  </>
                }
              >
                <div className="tool-body">
                  <div className="tool-detail-label">参数</div>
                  <pre tabIndex={0} aria-label={`${tool.name} 参数`}>
                    {parseObject(tool.args)
                      ? JSON.stringify(parseObject(tool.args), null, 2)
                      : tool.args}
                  </pre>
                  {(tool.result || tool.status !== "running") && (
                    <>
                      <div className="tool-detail-label">结果</div>
                      <pre tabIndex={0} aria-label={`${tool.name} 结果`}>
                        {tool.result ||
                          (tool.status === "interrupted"
                            ? "调用已停止，暂无结果。"
                            : "未返回文本结果。")}
                      </pre>
                    </>
                  )}
                </div>
              </ActivityDetails>
              {tool.result && (
                <pre
                  className="tool-preview"
                  aria-label={`${tool.name} 结果预览`}
                >
                  {tool.result.split("\n").slice(0, 2).join("\n")}
                  {tool.result.split("\n").length > 2 ? " …" : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function SessionStatus({ model }: { model: View }) {
  return (
    <div className="session-statusbar">
      <span
        className="session-model"
        title={`${model.defaultModel.provider}/${model.defaultModel.modelId}`}
      >
        {model.defaultModel.modelId}
      </span>
      <span className="session-thinking" title="思考强度">
        {model.thinking}
      </span>
      {model.toolsEnabled && (
        <span className="session-tools" title="工具每次执行均需确认">
          tools
        </span>
      )}
      <Usage model={model} />
    </div>
  );
}

function ToolApproval({
  approval,
  perform,
}: {
  approval: View["toolApprovals"][number];
  perform: Perform;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [decided, setDecided] = useState(false);
  const deny = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = deny.current;
    queueMicrotask(() => {
      if (button?.isConnected) button.focus();
    });
  }, []);
  const lock = useRef(false);
  const decide = async (approved: boolean) => {
    if (lock.current || decided) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      if (
        (await perform("session_request", {
          request: { action: "decision", id: approval.id, approved },
        })) === false
      )
        setError("确认失败，请重试或停止当前任务。");
      else setDecided(true);
    } catch {
      setError("确认失败，请重试或停止当前任务。");
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <section className="tool-approval" aria-label="工具执行确认">
      <div className="approval-heading">
        <span aria-hidden="true">◇</span>
        <strong>{approval.name}</strong>
        <span>请求执行</span>
      </div>
      <p className="approval-directory">{approval.cwd}</p>
      <pre>
        {parseObject(approval.args)
          ? JSON.stringify(parseObject(approval.args), null, 2)
          : approval.args}
      </pre>
      <div className="approval-actions">
        <button
          ref={deny}
          disabled={pending || decided}
          onClick={() => void decide(false)}
        >
          拒绝本次
        </button>
        <button
          className="approve-tool"
          disabled={pending || decided}
          onClick={() => void decide(true)}
        >
          允许本次
        </button>
        <span>
          {pending ? "正在确认…" : decided ? "已确认" : "Tab 选择 · Enter 确认"}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
