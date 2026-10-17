import { providerConnectionLabel } from "./provider-label.js";
import { aiWorkspaceStyles } from "./ai-workspace-styles.js";
import { createProviderEditor } from "./provider-editor.js";
import type {
  ModelConfig,
  OAuthStatus,
  ProviderCatalog,
  ProviderUpdate,
  Reply,
  TranslationEngine,
} from "@lingo-sofa/protocol";
import type { HostReact } from "./provider-auth.js";

export interface AISettingsClient {
  providers: () => Promise<ProviderCatalog>;
  configureProvider: (update: ProviderUpdate) => Promise<Reply>;
  oauth?: (
    action: "start" | "status" | "cancel" | "logout",
  ) => Promise<OAuthStatus>;
}

export function createAISettings(getReact: () => HostReact) {
  const ProviderEditor = createProviderEditor(getReact);
  return function AISettings({
    client,
    onSaved,
    onManage,
    section = "all",
    embedded = false,
  }: {
    client: AISettingsClient;
    onSaved?: (target?: ProviderUpdate["target"]) => void;
    onManage?: (section: "translation" | "ask-default" | "account") => void;
    section?: "all" | "translation" | "ask";
    embedded?: boolean;
  }) {
    const React = getReact();
    const [catalog, setCatalog] = React.useState<ProviderCatalog | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [editor, setEditor] = React.useState<
      "translation" | "ask-default" | "account" | null
    >(null);
    const trigger = React.useRef<HTMLElement | null>(null);
    const container = React.useRef<HTMLElement | null>(null);
    const refresh = React.useCallback(async () => {
      setError("");
      try {
        setCatalog(await client.providers());
      } catch {
        setError("连接不可用，请检查本地助手或选择模型直连。");
      }
    }, [client]);
    React.useEffect(() => {
      void refresh();
    }, [refresh]);
    React.useEffect(() => {
      if (!editor && trigger.current) {
        if (trigger.current.isConnected) trigger.current.focus();
        else
          container.current
            ?.querySelector<HTMLElement>(
              `[data-editor-target="${trigger.current.dataset.editorTarget ?? "account"}"]`,
            )
            ?.focus();
      }
    }, [editor]);
    function openEditor(section: NonNullable<typeof editor>) {
      trigger.current = document.activeElement as HTMLElement | null;
      if (onManage && section === "account") onManage(section);
      else setEditor(section);
    }
    function closeEditor() {
      setEditor(null);
      void refresh();
    }
    async function save(
      model: ModelConfig,
      target: "translation" | "ask-default",
    ) {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await client.configureProvider({ model, target });
        if (!result.ok) throw new Error(result.error);
        onSaved?.(target);
        setCatalog(await client.providers());
        setNotice(
          target === "translation"
            ? "翻译模型已保存，不影响 Ask 会话"
            : "Ask 默认模型已保存，已有会话保持原配置",
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "保存失败，请重试");
      } finally {
        setBusy(false);
      }
    }
    async function saveEngine(engine: TranslationEngine) {
      if (
        engine === "llm" &&
        catalog &&
        !catalog.keyConfigured &&
        !catalog.piAuth &&
        catalog.model.authMode !== "subscription"
      ) {
        openEditor("translation");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await client.configureProvider({
          target: "translation-engine",
          engine,
        });
        if (!result.ok) throw new Error(result.error);
        setCatalog(await client.providers());
        onSaved?.("translation-engine");
        setNotice("翻译引擎已保存，不影响 Ask 会话");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "保存失败，请重试");
      } finally {
        setBusy(false);
      }
    }
    function modelSelect(
      model: ModelConfig,
      target: "translation" | "ask-default",
      label: string,
    ) {
      const choices: { value: string; label: string; model: ModelConfig }[] =
        [];
      for (const account of catalog?.accounts ?? []) {
        if (account.keyConfigured === false) continue;
        const models =
          catalog?.providers.find((item) => item.id === account.model.provider)
            ?.models ?? [];
        for (const id of new Set([
          account.model.model,
          ...models.map((item) => item.id),
          ...(model.accountId === account.id ? [model.model] : []),
        ])) {
          choices.push({
            value: `${account.id}:${id}`,
            label: `${providerConnectionLabel(account, catalog!)} · ${id}`,
            model: {
              ...account.model,
              accountId: account.id,
              model: id,
              thinkingLevel: undefined,
              capabilities: undefined,
              prices: null,
            },
          });
        }
      }
      // Older saved configurations may not have an account ID yet.
      if (!model.accountId && catalog?.keyConfigured) {
        const provider = catalog.providers.find(
          (item) => item.id === model.provider,
        );
        for (const id of new Set([
          model.model,
          ...(provider?.models.map((item) => item.id) ?? []),
        ]))
          choices.push({
            value: `current:${id}`,
            label: `${provider?.name ?? model.provider} · ${id}`,
            model: {
              ...model,
              model: id,
              thinkingLevel: undefined,
              capabilities: undefined,
              prices: null,
            },
          });
      }
      const value = `${model.accountId ?? "current"}:${model.model}`;
      return (
        <select
          aria-label={label}
          value={value}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value === "connect") {
              openEditor(target);
              return;
            }
            const choice = choices.find(
              (item) => item.value === event.target.value,
            );
            if (choice) void save(choice.model, target);
          }}
        >
          {!choices.some((item) => item.value === value) && (
            <option value={value}>
              {model.model} · {catalog?.keyConfigured ? "当前模型" : "尚未连接"}
            </option>
          )}
          {choices.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
          <option value="connect">连接其他模型…</option>
        </select>
      );
    }
    const askModel = catalog?.askModel ?? catalog?.model;
    const levels =
      catalog?.providers
        .find((item) => item.id === askModel?.provider)
        ?.models.find((item) => item.id === askModel?.model)?.thinkingLevels ??
      [];
    if (editor)
      return (
        <section
          className="ls-intelligence"
          aria-label="问答设置"
          ref={container}
        >
          <style>{aiWorkspaceStyles}</style>
          <header className="ls-design-heading">
            <h1>
              {editor === "account"
                ? "供应商"
                : editor === "translation"
                  ? "翻译模型"
                  : "Ask 默认模型"}
            </h1>
          </header>
          <section className="ls-provider-page" aria-label="连接服务商">
            <ProviderEditor
              client={client}
              initialSection={editor}
              onManageAccount={() => openEditor("account")}
              onSaved={(target) => {
                onSaved?.(target);
                void refresh();
              }}
            />
            <button className="ls-dialog-done" onClick={closeEditor}>
              完成
            </button>
          </section>
        </section>
      );
    return (
      <section
        className="ls-intelligence"
        aria-label="问答设置"
        ref={container}
      >
        <style>{aiWorkspaceStyles}</style>
        {!embedded && (
          <header className="ls-design-heading">
            <h1>{section === "all" ? "翻译与问答" : "问答设置"}</h1>
            <p>
              {section === "all"
                ? "选择翻译引擎，单独配置 Ask 模型与对话行为。"
                : "Ask 默认模型与对话行为，独立于翻译引擎。"}
            </p>
          </header>
        )}
        {error && (
          <p className="ls-notification error" role="alert">
            {error} <button onClick={() => void refresh()}>重新连接</button>
          </p>
        )}
        {section !== "ask" && (
          <div className="ls-design-card">
            <div className="ls-engine-heading">
              <h2>翻译引擎</h2>
              <span className="ls-status-chip">独立配置</span>
            </div>
            <p className="ls-engine-intro">
              免 Key 引擎可直接翻译；添加模型账户后仍可继续使用。
            </p>
            <div
              className="ls-engine-choices"
              role="group"
              aria-label="翻译引擎"
            >
              {(
                [
                  ["bing", "B", "必应翻译", "免 Key"],
                  ["google", "G", "谷歌翻译", "免 Key"],
                  ["llm", "✦", "大模型翻译", "使用模型账户"],
                ] as const
              ).map(([engine, icon, label, hint]) => (
                <button
                  key={engine}
                  disabled={busy || !catalog}
                  aria-pressed={
                    (catalog?.translationEngine ?? "llm") === engine
                  }
                  onClick={() => {
                    void saveEngine(engine);
                  }}
                >
                  <span className="ls-engine-icon" aria-hidden>
                    {icon}
                  </span>
                  <span>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                  <span className="ls-engine-check" aria-hidden>
                    {(catalog?.translationEngine ?? "llm") === engine
                      ? "✓"
                      : ""}
                  </span>
                </button>
              ))}
            </div>
            {catalog &&
              catalog.translationEngine !== undefined &&
              catalog.translationEngine !== "llm" && (
                <p className="ls-engine-note">
                  原文发送至所选翻译服务，不使用大模型
                  Key。服务暂不可用时，可手动切换引擎。
                </p>
              )}
            {(catalog?.translationEngine ?? "llm") === "llm" && (
              <>
                <div className="ls-setting-row">
                  <div>
                    <button
                      className="ls-row-title"
                      data-editor-target="translation"
                      onClick={() => openEditor("translation")}
                    >
                      翻译模型
                    </button>
                    <small>用于划词、段落和整页翻译。</small>
                  </div>
                  {catalog ? (
                    modelSelect(catalog.model, "translation", "翻译模型")
                  ) : (
                    <span>读取连接中…</span>
                  )}
                </div>
              </>
            )}
            <button
              className="ls-engine-configure"
              onClick={() => openEditor("translation")}
            >
              配置大模型翻译
            </button>
          </div>
        )}
        {section !== "translation" && (
          <div className="ls-design-card">
            <h2>问答模型</h2>
            <div className="ls-setting-row">
              <div>
                <button
                  className="ls-row-title"
                  data-editor-target="ask-default"
                  onClick={() => openEditor("ask-default")}
                >
                  Ask 默认模型
                </button>
                <small>Pi agent · 用于对话。</small>
              </div>
              {askModel && modelSelect(askModel, "ask-default", "Ask 默认模型")}
            </div>
            <div className="ls-setting-row">
              <div>
                <strong>思考程度</strong>
                <small>
                  {levels.length
                    ? "仅在模型支持时可选。"
                    : "此模型未提供可调档位。"}
                </small>
              </div>
              <select
                aria-label="思考程度"
                disabled={busy || !levels.length}
                value={askModel?.thinkingLevel ?? ""}
                onChange={(event) => {
                  if (askModel)
                    void save(
                      {
                        ...askModel,
                        thinkingLevel: (event.target.value ||
                          undefined) as ModelConfig["thinkingLevel"],
                      },
                      "ask-default",
                    );
                }}
              >
                <option value="">模型默认</option>
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {{
                      off: "关闭",
                      minimal: "最低",
                      low: "低",
                      medium: "中",
                      high: "高",
                      xhigh: "更高",
                      max: "最高",
                    }[level] ?? level}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {section !== "translation" && (
          <div className="ls-design-card">
            <div className="ls-setting-row">
              <div>
                <strong>默认上下文</strong>
                <small>仅发送你明确选择的内容。</small>
              </div>
              <span className="ls-readonly-value">仅所选文本</span>
            </div>
            <div className="ls-setting-row">
              <div>
                <strong>工具权限</strong>
                <small>当前 Ask 仅支持所选内容问答。</small>
              </div>
              <span className="ls-readonly-value">未启用工具操作</span>
            </div>
          </div>
        )}
        {!embedded && (
          <button
            className="ls-advanced"
            onClick={() =>
              openEditor(section === "ask" ? "ask-default" : "translation")
            }
          >
            <span aria-hidden>›</span>
            <span>
              <strong>高级 · 手动配置兼容模型</strong>
              <small>自定义端点与模型</small>
            </span>
          </button>
        )}
        <footer className="ls-design-footer">
          <span
            role={embedded ? undefined : "status"}
            aria-live={embedded ? "polite" : undefined}
          >
            {busy ? "正在保存…" : notice || "更改会自动保存"}
          </span>
          <button
            data-editor-target="account"
            onClick={() => openEditor("account")}
          >
            供应商
          </button>
        </footer>
      </section>
    );
  };
}
