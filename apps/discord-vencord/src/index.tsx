import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import definePlugin, { OptionType } from "@utils/types";
import {
  React,
  Menu,
  ChannelStore,
  SelectedChannelStore,
  UserStore,
  Modal,
  openModal,
} from "@webpack/common";
import type { Message } from "@vencord/discord-types";
import { DiscordBridgeClient } from "./client.js";
import { MessageTranslations, type MessageRef } from "./controller.js";
import { summarize } from "@lingo-sofa/translation-core";
import { formatTokens, formatCost, formatSpeed } from "@lingo-sofa/ui-shared";

const settings = definePluginSettings({
  port: {
    type: OptionType.NUMBER,
    description: "Local Bridge port",
    default: 43187,
  },
  targetLanguage: {
    type: OptionType.STRING,
    description: "Translation language",
    default: "简体中文",
  },
  autoChannels: {
    type: OptionType.STRING,
    description: "Explicitly enabled account:channel pairs",
    default: "",
  },
});
let pairingToken = "";
const client = new DiscordBridgeClient({
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
function Ask({ message }: { message: MessageRef }) {
  const [question, setQuestion] = React.useState("");
  const [turns, setTurns] = React.useState<
    { question: string; answer: string }[]
  >([]);
  const [running, setRunning] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const sessionId = React.useRef(crypto.randomUUID());
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
    const requestId = crypto.randomUUID();
    setRunning(requestId);
    setError("");
    try {
      const reply = await client.request(scope(message), {
        kind: "ask",
        requestId,
        sessionId: sessionId.current,
        context: message.content,
        question,
      });
      if (!reply.ok) throw new Error(reply.error);
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
    <section style={{ padding: 16 }}>
      <h2>LingoSofa · 询问消息</h2>
      <label>
        将发送的上下文
        <textarea value={message.content} readOnly style={{ width: "100%" }} />
      </label>
      <p>仅发送这条消息及本会话的提问，不读取频道历史或附件。</p>
      {turns.map((turn, index) => (
        <div key={index}>
          <p>{turn.question}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{turn.answer}</p>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      <label>
        问题
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <button disabled={Boolean(running)} onClick={() => void ask()}>
        提问
      </button>
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
    configuration.autoChannels,
    configuration.targetLanguage,
  ]);
  const state = translations.get(ref);
  return (
    <div ref={element} style={{ minHeight: 1 }}>
      {state && (
        <section
          aria-label="LingoSofa 译文"
          style={{
            borderInlineStart: "2px solid #238363",
            paddingInlineStart: 8,
            marginBlock: 6,
          }}
        >
          <button onClick={() => setFolded(!folded)}>
            {folded ? "展开译文" : "折叠译文"}
          </button>
          {!folded && (
            <p style={{ whiteSpace: "pre-wrap" }}>
              {state.status === "success"
                ? state.text
                : state.status === "failed"
                  ? state.error
                  : "翻译中…"}
            </p>
          )}
          <button
            onClick={() => {
              translations.remove(ref);
              translations.translate(ref, settings.store.targetLanguage);
            }}
          >
            重试
          </button>
          <button
            disabled={!state.text}
            onClick={() => {
              if (state.text) void navigator.clipboard.writeText(state.text);
            }}
          >
            复制译文
          </button>
          <button onClick={() => showAsk(ref)}>向 Pi 提问</button>
          {(state.status === "queued" || state.status === "running") && (
            <button onClick={() => translations.remove(ref)}>停止</button>
          )}
        </section>
      )}
    </div>
  );
}
function SettingsPanel() {
  const [token, setToken] = React.useState(pairingToken);
  const [notice, setNotice] = React.useState("");
  const [stats, setStats] = React.useState("未查询");
  const [draft, setDraft] = React.useState("");
  const [translated, setTranslated] = React.useState("");
  const current = () => ({
    account: UserStore.getCurrentUser()?.id ?? "",
    channel: SelectedChannelStore.getChannelId(),
    id: "draft",
    content: draft,
  });
  return (
    <section>
      <p>
        模型、provider、Pi 登录和预算由本地 Bridge
        配置。配对令牌只保留到插件停止或客户端关闭。
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
            .usage(scope(message))
            .then((records) => {
              const total = summarize(records);
              setStats(
                `Input ${formatTokens(total.input)} · Output ${formatTokens(total.output)} · ${formatSpeed(total.tps)} · ${formatCost(total.cost)}`,
              );
            })
            .catch((reason: Error) => setStats(reason.message));
        }}
      >
        查看当前频道用量
      </button>
      <p>{stats}</p>
      <label>
        草稿翻译预览
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        onClick={() => {
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
            .catch((reason: Error) => setNotice(reason.message));
        }}
      >
        预览翻译
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
          setNotice("已清理本地状态与配对令牌");
        }}
      >
        清理
      </button>
    </section>
  );
}
export default definePlugin({
  name: "LingoSofa",
  description:
    "Translate visible messages and ask Pi through a paired local Bridge.",
  authors: [],
  settings,
  settingsAboutComponent: SettingsPanel,
  renderMessageAccessory: (props) => <Accessory message={props.message} />,
  messagePopoverButton: {
    icon: Icon,
    render: (message) =>
      message.content
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
      translations.remove(reference(message)),
    CONNECTION_OPEN: () => translations.clear(),
  },
  stop: () => {
    translations.clear();
    pairingToken = "";
  },
});
