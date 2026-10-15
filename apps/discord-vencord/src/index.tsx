import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import {
  addMessagePopoverButton,
  removeMessagePopoverButton,
} from "@api/MessagePopover";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import {
  React,
  useStateFromStores,
  MessageStore,
  Menu,
  ChannelStore,
  SelectedChannelStore,
  UserStore,
  createRoot,
} from "@webpack/common";
import type { Message } from "@vencord/discord-types";
import { ChannelControls } from "./channel-controls.js";
import type { ModelConfig, ProviderCatalog } from "@lingo-sofa/protocol";
import { ProviderSettings } from "./provider-settings.js";
import { pluginStyles } from "./styles.js";
import { DiscordBridgeClient } from "./client.js";
import {
  MessageTranslations,
  messageTranslationText,
  messageContextMatches,
  type MessageRef,
} from "./controller.js";
import {
  createAskModelSelector,
  askStyles,
  attachAskWindow,
  textAnchorRect,
  registerAskShortcut,
  formatTokens,
  formatCost,
  renderTranslationMarkdown,
  formatTranslationBilling,
} from "@lingo-sofa/ui-shared";

const settings = definePluginSettings({
  readingEnabled: {
    hidden: true,
    type: OptionType.BOOLEAN,
    description: "Enable bilingual reading",
    default: true,
  },
  modelRevision: {
    hidden: true,
    type: OptionType.NUMBER,
    description: "Model refresh generation",
    default: 0,
  },
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
const Native = VencordNative.pluginHelpers.LingoSofa as PluginNative<
  typeof import("./native")
>;
const client = new DiscordBridgeClient({
  connect: () => Native?.connection() ?? Promise.resolve(null),
  port: () => settings.store.port,
  token: () => "",
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
function AskIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-5 3V7.5A4.5 4.5 0 0 1 7.5 3h8A4.5 4.5 0 0 1 20 7.5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M7 8h9M7 12h6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
const askPopoverId = "LingoSofaAsk";
const AskModelSelector = createAskModelSelector(() => React);
function Ask({
  message,
  initialQuestion = "",
  onClose,
}: {
  message: MessageRef;
  initialQuestion?: string;
  onClose?: () => void;
}) {
  const [askModel, setAskModel] = React.useState<ModelConfig | undefined>(
    undefined,
  );
  const loadAskModels = React.useCallback(() => client.providers(), []);
  const [includeContext, setIncludeContext] = React.useState(true);
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
  const reading = settings.use(["readingEnabled"]);
  const sessionId = React.useRef(crypto.randomUUID());
  React.useEffect(() => {
    if (!reading.readingEnabled && running)
      void client
        .request(scope(message), { kind: "cancel", requestId: running })
        .catch(() => undefined);
  }, [reading.readingEnabled, running]);
  function contextIsCurrent() {
    return (
      settings.store.readingEnabled &&
      messageContextMatches(message, {
        account: UserStore.getCurrentUser()?.id,
        channel: SelectedChannelStore.getChannelId(),
        content: MessageStore.getMessage(message.channel, message.id)?.content,
      })
    );
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
  React.useEffect(
    () => () => {
      void client
        .request(scope(message), {
          kind: "clear-session",
          sessionId: sessionId.current,
        })
        .catch(() => undefined);
    },
    [],
  );
  function fresh() {
    void client
      .request(scope(message), {
        kind: "clear-session",
        sessionId: sessionId.current,
      })
      .catch(() => undefined);
    sessionId.current = crypto.randomUUID();
    setAskModel(undefined);
    setTurns([]);
    setQuestion("");
    setError("");
    setSessionStats(undefined);
  }
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
        model: askModel,
        requestId,
        sessionId: sessionId.current,
        context: includeContext ? message.content : "",
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
      className="ls-ask lingo-sofa-ask"
      data-ask-state={turns.length || running ? "conversation" : "empty"}
      aria-label="Ask Pi · 选中内容"
      aria-busy={Boolean(running)}
    >
      <style>{askStyles}</style>
      <header className="ls-ask-header" aria-label="会话操作">
        <button
          aria-label="新建 / 清理会话"
          disabled={Boolean(running)}
          onClick={fresh}
        >
          ＋
        </button>
        {onClose && (
          <button aria-label="关闭并清理会话" onClick={onClose}>
            ×
          </button>
        )}
      </header>
      <div className="ls-ask-conversation">
        {!turns.length && !running && (
          <div className="ls-ask-empty">
            <div className="ls-ask-suggestions">
              {[
                "解释这段话的含义",
                "用三句话总结所选内容",
                "帮我写一条自然的回复",
              ].map((text) => (
                <button key={text} onClick={() => setQuestion(text)}>
                  {text} ↗
                </button>
              ))}
            </div>
          </div>
        )}
        <div aria-live="polite">
          {turns.map((turn, index) => (
            <div className="ls-ask-turn" key={index}>
              <p className="ls-ask-user">{turn.question}</p>
              <span className="ls-ask-badge">✓ 已完成</span>
              <div
                className="ls-ask-answer"
                dangerouslySetInnerHTML={{
                  __html: renderTranslationMarkdown(turn.answer),
                }}
              />
              <div className="ls-ask-answer-actions">
                <button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(turn.answer)
                      .catch(() => setError("无法复制，请手动选择回答文本。"));
                  }}
                >
                  复制
                </button>
              </div>
            </div>
          ))}
        </div>
        {sessionStats && (
          <p className="ls-ask-status">
            {formatTokens(sessionStats.tokens)} tokens · API 等值{" "}
            {formatCost(sessionStats.cost)} · {sessionStats.messages} 条消息
          </p>
        )}
        {running && (
          <p className="ls-ask-status" role="status">
            正在生成回答…
          </p>
        )}
        {error && (
          <p className="ls-ask-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ls-ask-composer-area">
        <form
          className="ls-ask-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <div className="ls-ask-context-chips">
            <button
              type="button"
              className="ls-context-chip"
              aria-pressed={includeContext}
              aria-label={includeContext ? "移除所选上下文" : "添加所选上下文"}
              disabled={Boolean(running) || turns.length > 0}
              onClick={() => setIncludeContext(!includeContext)}
            >
              {includeContext ? "所选文本 ×" : "+ 添加所选文本"}
            </button>
          </div>
          <textarea
            aria-label="问题"
            className="ls-ask-question"
            value={question}
            placeholder="针对这条消息，问点什么…"
            maxLength={16000}
            rows={2}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (askModel) void ask();
              }
            }}
          />
          <div className="ls-ask-composer-bottom">
            <div className="ls-ask-model-host">
              <AskModelSelector
                key={sessionId.current}
                load={loadAskModels}
                model={askModel}
                onChange={setAskModel}
                disabled={Boolean(running)}
              />
            </div>
            {running ? (
              <button
                type="button"
                onClick={() => {
                  void client
                    .request(scope(message), {
                      kind: "cancel",
                      requestId: running,
                    })
                    .catch(() => undefined);
                }}
              >
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="ls-ask-send"
                aria-label="提问"
                disabled={!question.trim() || !askModel}
              >
                <span className="ls-ask-send-text">↑</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
let closeAsk: (() => void) | undefined;
let removeAskShortcut: (() => void) | undefined;
let hoveredMessage: HTMLElement | null = null;
function messageElement(id: string, channel: string) {
  return (
    document.getElementById(`message-content-${id}`) ??
    document.getElementById(`chat-messages-${channel}-${id}`)
  );
}
function showAsk(message: MessageRef, useSelection = false) {
  if (!settings.store.readingEnabled) return;
  const source = messageElement(message.id, message.channel);
  const selection = document.getSelection();
  const range = selection?.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : undefined;
  const selected = Boolean(
    useSelection &&
    source &&
    range &&
    source.contains(range.commonAncestorContainer) &&
    selection?.toString().trim(),
  );
  const context = selected
    ? {
        ...message,
        sourceContent: message.sourceContent ?? message.content,
        content: selection!.toString(),
      }
    : message;
  closeAsk?.();
  const dialog = document.createElement("dialog");
  dialog.className = "ls-ask-shell";
  dialog.setAttribute("aria-label", "Ask Pi · 选中内容");
  dialog.setAttribute("aria-keyshortcuts", "Alt+Shift+A");
  document.body.append(dialog);
  const root = createRoot(dialog);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    detach();
    root.unmount();
    dialog.remove();
    if (closeAsk === cleanup) closeAsk = undefined;
  };
  const detach = attachAskWindow(
    dialog,
    source
      ? () => {
          if (!source.isConnected) return null;
          return selected && range
            ? range.getBoundingClientRect()
            : textAnchorRect(source);
        }
      : undefined,
    cleanup,
  );
  closeAsk = cleanup;
  root.render(<Ask message={context} onClose={cleanup} />);
  window.requestAnimationFrame(() =>
    dialog
      .querySelector<HTMLTextAreaElement>(".ls-ask-question")
      ?.focus({ preventScroll: true }),
  );
}
function trackAskMessage(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".ls-ask-shell")) return;
  hoveredMessage =
    target?.closest<HTMLElement>(
      '[id^="message-content-"],[id^="chat-messages-"]',
    ) ?? null;
}
function openAskShortcut() {
  if (!settings.store.readingEnabled) return false;
  const selection = document.getSelection();
  const node =
    selection?.rangeCount && !selection.isCollapsed
      ? selection.getRangeAt(0).commonAncestorContainer
      : null;
  const selected = node instanceof Element ? node : node?.parentElement;
  const element =
    selected?.closest<HTMLElement>(
      '[id^="message-content-"],[id^="chat-messages-"]',
    ) ?? hoveredMessage;
  const channel = SelectedChannelStore.getChannelId();
  if (!element?.isConnected || !channel) return false;
  const id = element.id.startsWith("message-content-")
    ? element.id.slice("message-content-".length)
    : element.id.slice(`chat-messages-${channel}-`.length);
  const message = MessageStore.getMessage(channel, id);
  if (!message?.content) return false;
  showAsk(reference(message), true);
  return true;
}

function Accessory({ message }: { message: Message }) {
  const configuration = settings.use([
    "readingEnabled",
    "autoChannels",
    "targetLanguage",
    "modelRevision",
  ]);
  const ref = reference(message);
  const [, refresh] = React.useState(0);
  const element = React.useRef<HTMLDivElement>(null);
  const [folded, setFolded] = React.useState(false);
  React.useEffect(
    () => translations.subscribe(ref, () => refresh((value) => value + 1)),
    [ref.account, ref.channel, ref.id, ref.content],
  );
  React.useEffect(() => {
    if (
      !configuration.readingEnabled ||
      !automatic(ref) ||
      !ref.content ||
      !element.current
    )
      return;
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
    configuration.readingEnabled,
    configuration.autoChannels,
    configuration.targetLanguage,
    configuration.modelRevision,
  ]);
  const observed = translations.get(ref);
  const state =
    observed?.language === configuration.targetLanguage ? observed : undefined;
  return (
    <div ref={element} style={{ minHeight: 1 }}>
      {configuration.readingEnabled &&
        state &&
        !translations.isOriginalOnly(scope(ref)) && (
          <section aria-label="LingoSofa 译文" className="lingo-sofa-accessory">
            {!folded && (
              <div
                role={
                  state.status === "failed"
                    ? "alert"
                    : state.status === "success"
                      ? undefined
                      : "status"
                }
                dangerouslySetInnerHTML={
                  state.status === "success"
                    ? { __html: renderTranslationMarkdown(state.text ?? "") }
                    : undefined
                }
              >
                {state.status === "success"
                  ? undefined
                  : state.status === "failed"
                    ? state.error
                    : "翻译中…"}
              </div>
            )}
            {state.status === "success" && !folded && (
              <div
                className="lingo-sofa-inline-usage"
                title={formatTranslationBilling(state.billing).title}
              >
                {formatTranslationBilling(state.billing).text}
              </div>
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
    <ProviderSettings
      client={client}
      onSaved={(target) => {
        if (target !== "translation") return;
        translations.clear();
        settings.store.modelRevision++;
      }}
    />
  );
}
function FloatingControls() {
  const configuration = settings.use([
    "readingEnabled",
    "autoChannels",
    "targetLanguage",
    "modelRevision",
  ]);
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
  const [catalog, setCatalog] = React.useState<ProviderCatalog | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [position, setPosition] = React.useState({ side: "right", y: 160 });
  const [, refresh] = React.useState(0);
  const launcher = React.useRef<HTMLButtonElement>(null);
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
    if (!expanded) return;
    let active = true;
    setBusy(true);
    void client
      .providers()
      .then((next) => {
        if (active) {
          setCatalog(next);
          setNotice("");
        }
      })
      .catch(() => {
        if (active) {
          setCatalog(null);
          setNotice("本地助手未连接，请检查助手安装后重新打开面板。");
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [expanded]);
  React.useEffect(() => {
    const resize = () =>
      setPosition((position) => ({
        ...position,
        y: Math.max(16, Math.min(position.y, window.innerHeight - 60)),
      }));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  async function switchModel(id: string) {
    if (!catalog || busy || id === catalog.model.model) return;
    const selected = catalog.providers
      .find((provider) => provider.id === catalog.model.provider)
      ?.models.find((model) => model.id === id);
    if (!selected) return;
    setBusy(true);
    setNotice("正在切换模型…");
    try {
      const model = {
        ...catalog.model,
        model: selected.id,
        thinkingLevel: undefined,
        capabilities: undefined,
        prices: null,
      };
      const reply = await client.configureProvider({ model });
      if (!reply.ok) throw new Error(reply.error);
      setCatalog({ ...catalog, model });
      translations.clear();
      settings.store.modelRevision++;
      setNotice("模型已切换，后续翻译使用新模型。");
    } catch {
      setNotice("切换失败，请等当前翻译完成后重试；原模型仍保留。");
    } finally {
      setBusy(false);
    }
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
        ref={launcher}
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
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setExpanded(false);
              launcher.current?.focus();
            }
          }}
          style={{
            right: position.side === "right" ? 0 : "auto",
            left: position.side === "left" ? 0 : "auto",
            top: position.y > window.innerHeight / 2 ? "auto" : 54,
            bottom: position.y > window.innerHeight / 2 ? 54 : "auto",
            maxHeight: Math.max(
              64,
              position.y > window.innerHeight / 2
                ? position.y - 70
                : window.innerHeight - position.y - 70,
            ),
          }}
        >
          <ChannelControls
            channel={ChannelStore.getChannel(channel)?.name ?? "当前频道"}
            enabled={configuration.readingEnabled}
            onEnabled={() => {
              settings.store.readingEnabled = !configuration.readingEnabled;
              translations.setEnabled(settings.store.readingEnabled);
              setNotice(
                settings.store.readingEnabled
                  ? "双语阅读已开启"
                  : "双语阅读已关闭，已恢复原文",
              );
            }}
            language={configuration.targetLanguage}
            automatic={automatic(ref)}
            catalog={catalog}
            busy={busy}
            notice={notice}
            onClose={() => {
              setExpanded(false);
              launcher.current?.focus();
            }}
            onLanguage={(language) => {
              translations.pause(channelScope);
              settings.store.targetLanguage = language;
              setNotice(`目标语言已切换为 ${language}`);
            }}
            onModel={(model) => void switchModel(model)}
            onAutomatic={() => {
              if (automatic(ref)) translations.pause(channelScope);
              else translations.setOriginalOnly(channelScope, false);
              toggleAuto(ref);
              setNotice(
                automatic(ref)
                  ? "自动翻译已开启"
                  : "自动翻译已暂停，已有译文保留",
              );
            }}
          />
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
      settings.store.readingEnabled && messageTranslationText(message.content)
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
      if (!settings.store.readingEnabled || !message?.content) return;
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
    translations.setEnabled(settings.store.readingEnabled);
    void Native?.start();
    document.getElementById("lingo-sofa-styles")?.remove();
    const style = document.createElement("style");
    style.id = "lingo-sofa-styles";
    style.textContent = pluginStyles;
    document.head.append(style);
    addMessagePopoverButton(
      askPopoverId,
      (message) => {
        if (!settings.store.readingEnabled || !message.content?.trim())
          return null;
        const channel = ChannelStore.getChannel(message.channel_id);
        if (!channel) return null;
        return {
          label: "LingoSofa Ask",
          icon: AskIcon,
          message,
          channel,
          onClick: () => showAsk(reference(message)),
        };
      },
      AskIcon,
    );
    document.addEventListener("pointerover", trackAskMessage);
    removeAskShortcut = registerAskShortcut(document, openAskShortcut);
  },
  stop: () => {
    removeMessagePopoverButton(askPopoverId);
    closeAsk?.();
    removeAskShortcut?.();
    document.removeEventListener("pointerover", trackAskMessage);
    hoveredMessage = null;
    void Native?.stop();
    document.getElementById("lingo-sofa-styles")?.remove();
    translations.clear();
  },
});
