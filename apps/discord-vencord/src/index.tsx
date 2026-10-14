import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import {
  React,
  useStateFromStores,
  MessageStore,
  Menu,
  ChannelStore,
  SelectedChannelStore,
  UserStore,
  Modal,
  openModal,
} from "@webpack/common";
import type { Message } from "@vencord/discord-types";
import { ProviderSettings } from "./provider-settings.js";
import { pluginStyles } from "./styles.js";
import { DiscordBridgeClient } from "./client.js";
import {
  MessageTranslations,
  messageTranslationText,
  messageContextMatches,
  type MessageRef,
} from "./controller.js";
import { budgetStatus, summarize } from "@lingo-sofa/translation-core";
import {
  formatTokens,
  formatCost,
  formatSpeed,
  formatPricing,
} from "@lingo-sofa/ui-shared";

const settings = definePluginSettings({
  port: {
    hidden: true,
    type: OptionType.NUMBER,
    description: "Local Bridge port",
    default: 43187,
  },
  targetLanguage: {
    hidden: true,
    type: OptionType.STRING,
    description: "Translation language",
    default: "简体中文",
  },
  autoChannels: {
    hidden: true,
    type: OptionType.STRING,
    description: "Explicitly enabled account:channel pairs",
    default: "",
  },
});
let pairingToken = "";
const Native = VencordNative.pluginHelpers.LingoSofa as PluginNative<
  typeof import("./native")
>;
const client = new DiscordBridgeClient({
  connect: () => Native?.connection() ?? Promise.resolve(null),
  port: () => settings.store.port,
  token: () => pairingToken,
});
const translations = new MessageTranslations(client);
function reference(message: Message): MessageRef {
  return {
    account: UserStore.getCurrentUser()?.id ?? "",
    channel: message.channel_id,
    id: message.id,
    content: message.content,
    deliveryState: message.state,
  };
}
function scope(message: MessageRef): string {
  return `discord:${message.account}:${message.channel}`;
}
function automatic(message: MessageRef): boolean {
  return settings.store.autoChannels
    .split(",")
    .includes(`${message.account}:${message.channel}`);
}
function toggleAuto(message: MessageRef): void {
  const channels = new Set(
    settings.store.autoChannels.split(",").filter(Boolean),
  );
  const key = `${message.account}:${message.channel}`;
  if (channels.has(key)) channels.delete(key);
  else channels.add(key);
  settings.store.autoChannels = [...channels].join(",");
}
function Icon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M3 3h9v2H8v3h4v2H8v3H6v-3H3V8h3V5H3zm11 5h3l5 13h-3l-1-3h-5l-1 3H9zm1.5 3L14 16h3z"
      />
    </svg>
  );
}
function Ask({
  message,
  initialQuestion = "",
}: {
  message: MessageRef;
  initialQuestion?: string;
}) {
  const [question, setQuestion] = React.useState(initialQuestion);
  const [turns, setTurns] = React.useState<
    { question: string; answer: string }[]
  >([]);
  const [running, setRunning] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [sessionStats, setSessionStats] = React.useState<{
    tokens: number;
    cost: number | null;
    messages: number;
  }>();
  const sessionId = React.useRef(crypto.randomUUID());
  function contextIsCurrent() {
    return messageContextMatches(message, {
      account: UserStore.getCurrentUser()?.id,
      channel: SelectedChannelStore.getChannelId(),
      content: MessageStore.getMessage(message.channel, message.id)?.content,
    });
  }
  React.useEffect(
    () => () => {
      if (running)
        void client
          .request(scope(message), { kind: "cancel", requestId: running })
          .catch(() => undefined);
    },
    [running],
  );
  async function ask() {
    if (!question.trim() || running) return;
    if (!contextIsCurrent()) {
      setSessionStats(undefined);
      setError("消息、账号或频道已变化，请重新选择并预览上下文");
      return;
    }
    const requestId = crypto.randomUUID();
    setRunning(requestId);
    setSessionStats(undefined);
    setError("");
    try {
      const reply = await client.request(scope(message), {
        kind: "ask",
        requestId,
        sessionId: sessionId.current,
        context: message.content,
        question,
      });
      if (!contextIsCurrent())
        throw new Error("消息、账号或频道已变化，请重新选择并预览上下文");
      if (!reply.ok) throw new Error(reply.error);
      setSessionStats(reply.sessionStats);
      setTurns((current) => [
        ...current,
        { question, answer: reply.text ?? "" },
      ]);
      setQuestion("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "问答失败");
    } finally {
      setRunning(null);
    }
  }
  return (
    <section
      className="lingo-sofa-panel lingo-sofa-ask"
      aria-busy={Boolean(running)}
    >
      <h2>LingoSofa · 询问消息</h2>
      <label>
        将发送的上下文
        <textarea value={message.content} readOnly rows={4} />
      </label>
      <p>仅发送这条消息及本会话的提问，不读取频道历史或附件。</p>
      <div aria-live="polite">
        {turns.map((turn, index) => (
          <div className="lingo-sofa-turn" key={index}>
            <p>
              <strong>你：</strong>
              {turn.question}
            </p>
            <p style={{ whiteSpace: "pre-wrap" }}>{turn.answer}</p>
          </div>
        ))}
      </div>
      {sessionStats && (
        <p>
          Pi 会话汇总：{formatTokens(sessionStats.tokens)} tokens ·{" "}
          {formatCost(sessionStats.cost)} · {sessionStats.messages}{" "}
          条消息（与请求统计为同一消耗）
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <label>
        问题
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={16_000}
          rows={3}
        />
      </label>
      <button
        className="lingo-sofa-primary"
        disabled={Boolean(running) || !question.trim()}
        onClick={() => void ask()}
      >
        提问
      </button>
      {running && <p role="status">正在生成回答…</p>}
      {running && (
        <button
          onClick={() =>
            void client
              .request(scope(message), { kind: "cancel", requestId: running })
              .catch(() => undefined)
          }
        >
          停止
        </button>
      )}
      <button
        disabled={Boolean(running)}
        onClick={() => {
          void client
            .request(scope(message), {
              kind: "clear-session",
              sessionId: sessionId.current,
            })
            .catch(() => undefined);
          sessionId.current = crypto.randomUUID();
          setTurns([]);
          setSessionStats(undefined);
        }}
      >
        新建 / 清理会话
      </button>
    </section>
  );
}
function showAsk(message: MessageRef) {
  openModal((props) => (
    <Modal {...props} title="LingoSofa">
      <Ask message={message} />
    </Modal>
  ));
}
function Accessory({ message }: { message: Message }) {
  const configuration = settings.use(["autoChannels", "targetLanguage"]);
  const ref = reference(message);
  const [, refresh] = React.useState(0);
  const element = React.useRef<HTMLDivElement>(null);
  const [folded, setFolded] = React.useState(false);
  React.useEffect(
    () => translations.subscribe(ref, () => refresh((value) => value + 1)),
    [ref.account, ref.channel, ref.id, ref.content],
  );
  React.useEffect(() => {
    if (!automatic(ref) || !ref.content || !element.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting))
        translations.translate(ref, settings.store.targetLanguage, true);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [
    ref.account,
    ref.channel,
    ref.id,
    ref.content,
    ref.deliveryState,
    configuration.autoChannels,
    configuration.targetLanguage,
  ]);
  const observed = translations.get(ref);
  const state =
    observed?.language === configuration.targetLanguage ? observed : undefined;
  return (
    <div ref={element} style={{ minHeight: 1 }}>
      {state && !translations.isOriginalOnly(scope(ref)) && (
        <section aria-label="LingoSofa 译文" className="lingo-sofa-accessory">
          {!folded && (
            <p
              role={
                state.status === "failed"
                  ? "alert"
                  : state.status === "success"
                    ? undefined
                    : "status"
              }
              style={{ whiteSpace: "pre-wrap" }}
            >
              {state.status === "success"
                ? state.text
                : state.status === "failed"
                  ? state.error
                  : "翻译中…"}
            </p>
          )}
          {state.status === "failed" && (
            <button
              onClick={() =>
                translations.translate(ref, settings.store.targetLanguage)
              }
            >
              重试
            </button>
          )}
          {(state.status === "queued" || state.status === "running") && (
            <button onClick={() => translations.remove(ref)}>停止</button>
          )}
          {state.status === "success" && (
            <details className="lingo-sofa-translation-actions">
              <summary aria-label="译文操作">···</summary>
              <button
                aria-expanded={!folded}
                onClick={() => setFolded(!folded)}
              >
                {folded ? "展开译文" : "折叠译文"}
              </button>
              <button
                onClick={() => {
                  if (state.text)
                    void navigator.clipboard.writeText(state.text);
                }}
              >
                复制译文
              </button>
              <button onClick={() => showAsk(ref)}>向 Pi 提问</button>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
function ProviderSettingsPanel() {
  return (
    <ProviderSettings client={client} onSaved={() => translations.clear()} />
  );
}
function ReadingToolsPanel() {
  const [token, setToken] = React.useState(pairingToken);
  const [notice, setNotice] = React.useState("");
  const [stats, setStats] = React.useState("未查询");
  const [details, setDetails] = React.useState<string[]>([]);
  const [budgets, setBudgets] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState("");
  const [translated, setTranslated] = React.useState("");
  const [previewRunning, setPreviewRunning] = React.useState(false);
  const current = () => ({
    account: UserStore.getCurrentUser()?.id ?? "",
    channel: SelectedChannelStore.getChannelId(),
    id: "draft",
    content: draft,
  });
  return (
    <section className="lingo-sofa-panel">
      <h3>连接本地助手</h3>
      <p>
        模型和 Key
        在供应商设置中管理，预算由本地助手配置。桌面端自动连接；旧版助手可在这里手动配对。
      </p>
      <label>
        配对令牌
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <button
        onClick={() => {
          pairingToken = token;
          setNotice("已保存本次会话的配对令牌");
        }}
      >
        配对
      </button>
      <p role="status">{notice}</p>
      <button
        onClick={() => {
          const message = current();
          void client
            .request(scope(message), { kind: "usage" })
            .then((reply) => {
              if (!reply.ok) throw new Error(reply.error);
              const records = reply.usage ?? [];
              const total = summarize(records);
              setDetails(
                records
                  .slice(-100)
                  .reverse()
                  .map(
                    (record) =>
                      `${record.model} · ${record.status} · Input ${formatTokens(record.usage ? record.usage.input + record.usage.cacheRead + record.usage.cacheWrite : null)} / Output ${formatTokens(record.usage?.output ?? null)} · 缓存读 ${formatTokens(record.usage?.cacheRead ?? null)} / 写 ${formatTokens(record.usage?.cacheWrite ?? null)} · 首输出 ${record.firstTextMs === null ? "不可用" : `${Math.round(record.firstTextMs)}ms`} / 耗时 ${Math.round(record.durationMs)}ms · ${formatSpeed(record.tps)} · ${formatCost(record.costKnown ? (record.usage?.cost.total ?? null) : null)} · ${formatPricing(record.pricing)}${record.pricing?.sourceUrl ? ` · ${record.pricing.sourceUrl}` : ""}`,
                  ),
              );
              setBudgets(
                (
                  reply.budgets ??
                  (reply.settings ? budgetStatus(records, reply.settings) : [])
                ).map(
                  (item) =>
                    `${reply.shareBudget ? "Bridge 共享" : "当前前端"} · ${item.window === "day" ? "日" : "月"}${item.metric === "tokens" ? " token" : "费用"}预算：${item.used ?? "未知"} / ${item.limit}${item.warning ? " · 已达阈值或消耗未知" : ""}`,
                ),
              );
              setStats(
                `${reply.sharedUsage ? "Bridge 跨端共享" : "当前频道"} · ${total.requests} 次请求 · Input ${formatTokens(total.input)} · Output ${formatTokens(total.output)} · ${formatSpeed(total.tps)} · ${formatCost(total.cost)}`,
              );
            })
            .catch((reason: Error) => setStats(reason.message));
        }}
      >
        查看当前频道用量
      </button>
      <p>{stats}</p>
      {budgets.map((budget) => (
        <p key={budget} role="status">
          {budget}
        </p>
      ))}
      <details>
        <summary>请求明细（最近 100 次）</summary>
        {details.map((record, index) => (
          <p key={index}>{record}</p>
        ))}
      </details>
      <h3>先预览，再复制</h3>
      <label>
        草稿翻译预览
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        className="lingo-sofa-primary"
        disabled={previewRunning || !draft.trim()}
        onClick={() => {
          setPreviewRunning(true);
          const requestId = crypto.randomUUID();
          const ref = current();
          void client
            .request(scope(ref), {
              kind: "translate",
              requestId,
              automatic: false,
              units: [
                {
                  id: "draft",
                  revision: requestId,
                  text: draft,
                  sourceKind: "discord",
                  targetLanguage: settings.store.targetLanguage,
                  protectedParts: [],
                },
              ],
            })
            .then((reply) => {
              if (!reply.ok) throw new Error(reply.error);
              setTranslated(reply.results?.[0]?.text ?? "");
            })
            .catch((reason: Error) => setNotice(reason.message))
            .finally(() => setPreviewRunning(false));
        }}
      >
        {previewRunning ? "翻译中…" : "预览翻译"}
      </button>
      <textarea value={translated} readOnly aria-label="草稿译文" />
      <button
        disabled={!translated}
        onClick={() => void navigator.clipboard.writeText(translated)}
      >
        复制草稿译文
      </button>
      <p>不会替换输入框或自动发送消息。</p>
      <button
        onClick={() => {
          translations.clear();
          pairingToken = "";
          setToken("");
          setNotice("已清理本地译文与手动配对状态");
        }}
      >
        清理
      </button>
    </section>
  );
}
function FloatingControls() {
  const configuration = settings.use(["autoChannels", "targetLanguage"]);
  const identity = useStateFromStores(
    [SelectedChannelStore, UserStore],
    () =>
      `${UserStore.getCurrentUser()?.id ?? ""}:${SelectedChannelStore.getChannelId() ?? ""}`,
  );
  const [account = "", channel = ""] = identity.split(":");
  const ref = { account, channel, id: "controls", content: "" };
  const channelScope = scope(ref);
  const [expanded, setExpanded] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [selected, setSelected] = React.useState<MessageRef>();
  const [position, setPosition] = React.useState({ side: "right", y: 160 });
  const [, refresh] = React.useState(0);
  const drag = React.useRef<{
    x: number;
    y: number;
    top: number;
    moved: boolean;
  } | null>(null);
  React.useEffect(
    () =>
      translations.subscribeScope(channelScope, () =>
        refresh((value) => value + 1),
      ),
    [channelScope],
  );
  React.useEffect(() => {
    setExpanded(false);
    setNotice("");
  }, [identity]);
  React.useEffect(() => {
    setSelected(undefined);
    const capture = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim().slice(0, 16_000) ?? "";
      // Discord restores composer focus when a chat-bar control is clicked.
      // Keep the last explicit selection for its read-only preview; identity and
      // source-content checks reject a changed message before anything is sent.
      if (!text) return;
      const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
      const node = range?.commonAncestorContainer;
      const element = node instanceof Element ? node : node?.parentElement;
      const messageElement = element?.closest<HTMLElement>(
        `[id^="chat-messages-${channel}-"]`,
      );
      const id = messageElement?.id.slice(`chat-messages-${channel}-`.length);
      const message = id ? MessageStore.getMessage(channel, id) : undefined;
      setSelected(
        message && message.content.includes(text)
          ? {
              ...reference(message),
              content: text,
              sourceContent: message.content,
            }
          : undefined,
      );
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [identity]);
  function askSelection() {
    if (!selected) {
      setNotice("请先在一条消息中选中要询问的正文");
      return;
    }
    const current = MessageStore.getMessage(selected.channel, selected.id);
    if (current?.content !== selected.sourceContent) {
      setNotice("消息已变化，请重新选择上下文");
      return;
    }
    showAsk(selected);
    setExpanded(false);
  }
  if (!account || !channel) return null;
  return (
    <div
      className="lingo-sofa-dock"
      style={{
        top: position.y,
        right: position.side === "right" ? 16 : "auto",
        left: position.side === "left" ? 16 : "auto",
      }}
    >
      <button
        className="lingo-sofa-launcher"
        aria-label="LingoSofa 频道控制，可拖动或用方向键移动"
        aria-expanded={expanded}
        onPointerDown={(event) => {
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            top: position.y,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (
            !start ||
            Math.abs(event.clientX - start.x) +
              Math.abs(event.clientY - start.y) <
              6
          )
            return;
          start.moved = true;
          setExpanded(false);
          setPosition({
            side: event.clientX < window.innerWidth / 2 ? "left" : "right",
            y: Math.max(
              16,
              Math.min(
                start.top + event.clientY - start.y,
                window.innerHeight - 60,
              ),
            ),
          });
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClick={() => {
          if (!drag.current?.moved) setExpanded(!expanded);
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setExpanded(false);
          if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setPosition({
              ...position,
              y: Math.max(
                16,
                Math.min(
                  position.y + (event.key === "ArrowUp" ? -24 : 24),
                  window.innerHeight - 60,
                ),
              ),
            });
          }
        }}
      >
        🛋
      </button>
      {expanded && (
        <section
          className="lingo-sofa-channel-panel lingo-sofa-panel"
          aria-label="LingoSofa 频道控制"
          style={{
            right: position.side === "right" ? 0 : "auto",
            left: position.side === "left" ? 0 : "auto",
            top: position.y > window.innerHeight / 2 ? "auto" : 54,
            bottom: position.y > window.innerHeight / 2 ? 54 : "auto",
          }}
        >
          <div className="lingo-sofa-control-heading">
            <strong>
              LingoSofa · {ChannelStore.getChannel(channel)?.name ?? "当前频道"}
            </strong>
            <button
              aria-label="收起频道控制"
              onClick={() => setExpanded(false)}
            >
              ×
            </button>
          </div>
          <label>
            目标语言
            <select
              value={configuration.targetLanguage}
              onChange={(event) => {
                translations.pause(channelScope);
                settings.store.targetLanguage = event.target.value;
              }}
            >
              {[
                ...new Set([
                  configuration.targetLanguage,
                  "简体中文",
                  "English",
                  "日本語",
                  "한국어",
                ]),
              ].map((language) => (
                <option key={language}>{language}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={automatic(ref)}
              onChange={() => {
                if (!pairingToken) {
                  setNotice("请先配对本地 Bridge");
                  return;
                }
                if (automatic(ref)) translations.pause(channelScope);
                else translations.setOriginalOnly(channelScope, false);
                toggleAuto(ref);
              }}
            />{" "}
            自动翻译此频道
          </label>
          <p className="lingo-sofa-control-hint">
            仅处理新消息和可见历史，不读取全部频道历史。
          </p>
          <label>
            <input
              type="checkbox"
              checked={translations.isOriginalOnly(channelScope)}
              onChange={(event) => {
                if (event.target.checked && automatic(ref)) toggleAuto(ref);
                translations.setOriginalOnly(
                  channelScope,
                  event.target.checked,
                );
              }}
            />{" "}
            只显示原文
          </label>
          <details>
            <summary>更多操作</summary>
            <button onClick={askSelection}>解释 / Ask Pi</button>
            <button
              onClick={() => {
                setExpanded(false);
                openModal((props) => (
                  <Modal {...props} title="LingoSofa">
                    <ProviderSettingsPanel />
                  </Modal>
                ));
              }}
            >
              供应商设置
            </button>
            <button
              onClick={() => {
                setExpanded(false);
                openModal((props) => (
                  <Modal {...props} title="LingoSofa">
                    <ReadingToolsPanel />
                  </Modal>
                ));
              }}
            >
              用量与草稿
            </button>
          </details>
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </div>
  );
}
export default definePlugin({
  name: "LingoSofa",
  description:
    "Translate visible messages and ask Pi through a paired local Bridge.",
  authors: [],
  settings,
  settingsAboutComponent: ProviderSettingsPanel,
  // The host mounts this after its React/store initialization, inside its error boundary.
  chatBarButton: {
    icon: Icon,
    render: (props) => (props.isMainChat ? <FloatingControls /> : null),
  },
  renderMessageAccessory: (props) => <Accessory message={props.message} />,
  messagePopoverButton: {
    icon: Icon,
    render: (message) =>
      messageTranslationText(message.content)
        ? {
            label: "LingoSofa 翻译",
            icon: Icon,
            message,
            channel: ChannelStore.getChannel(message.channel_id),
            onClick: () =>
              translations.translate(
                reference(message),
                settings.store.targetLanguage,
              ),
          }
        : null,
  },
  contextMenus: {
    message: (children, { message }: { message: Message }) => {
      if (!message?.content) return;
      const ref = reference(message);
      const group = findGroupChildrenByChildId("copy-text", children);
      if (!group) return;
      group.push(
        <Menu.MenuItem
          id="lingo-sofa-translate"
          label="LingoSofa 翻译"
          action={() =>
            translations.translate(ref, settings.store.targetLanguage)
          }
        />,
        <Menu.MenuItem
          id="lingo-sofa-ask"
          label="询问这条消息"
          action={() => showAsk(ref)}
        />,
        <Menu.MenuItem
          id="lingo-sofa-auto"
          label={
            automatic(ref)
              ? "关闭本频道自动翻译"
              : "启用本频道自动翻译（发送可见消息至 Bridge）"
          }
          action={() => toggleAuto(ref)}
        />,
      );
    },
  },
  flux: {
    MESSAGE_DELETE: ({ id, channelId }: { id: string; channelId: string }) =>
      translations.remove({
        account: UserStore.getCurrentUser()?.id ?? "",
        channel: channelId,
        id,
      }),
    MESSAGE_UPDATE: ({ message }: { message: Message }) =>
      translations.update(reference(message)),
    CONNECTION_OPEN: () => translations.clear(),
  },
  start: () => {
    document.getElementById("lingo-sofa-styles")?.remove();
    const style = document.createElement("style");
    style.id = "lingo-sofa-styles";
    style.textContent = pluginStyles;
    document.head.append(style);
  },
  stop: () => {
    document.getElementById("lingo-sofa-styles")?.remove();
    translations.clear();
    pairingToken = "";
  },
});
