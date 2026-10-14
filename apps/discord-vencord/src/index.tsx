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
import { ChannelControls } from "./channel-controls.js";
import type { ProviderCatalog } from "@lingo-sofa/protocol";
import { ProviderSettings } from "./provider-settings.js";
import { pluginStyles } from "./styles.js";
import { DiscordBridgeClient } from "./client.js";
import {
  MessageTranslations,
  messageTranslationText,
  messageContextMatches,
  type MessageRef,
} from "./controller.js";
import { formatTokens, formatCost } from "@lingo-sofa/ui-shared";

const settings = definePluginSettings({
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
  const configuration = settings.use([
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
    configuration.modelRevision,
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
    <ProviderSettings
      client={client}
      onSaved={() => {
        translations.clear();
        settings.store.modelRevision++;
      }}
    />
  );
}
function FloatingControls() {
  const configuration = settings.use([
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
          setNotice("本地助手未连接，请启动并配对后重新打开面板。");
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
  },
});
