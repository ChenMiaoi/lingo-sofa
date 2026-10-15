import { providerConnectionLabel } from "./provider-label.js";
import { aiWorkspaceStyles } from "./ai-workspace-styles.js";
import {
  accountMatches,
  type ModelConfig,
  type OAuthStatus,
  type ProviderCatalog,
  type ProviderUpdate,
  type Reply,
} from "@lingo-sofa/protocol";
import { createModelPreferences } from "./model-preferences.js";
import { createProviderAuth, type HostReact } from "./provider-auth.js";

export interface AISettingsClient {
  providers: () => Promise<ProviderCatalog>;
  configureProvider: (update: ProviderUpdate) => Promise<Reply>;
  oauth?: (
    action: "start" | "status" | "cancel" | "logout",
  ) => Promise<OAuthStatus>;
}
export function createProviderEditor(getReact: () => HostReact) {
  const ModelPreferences = createModelPreferences(getReact);
  const ProviderAuth = createProviderAuth(getReact);
  return function AISettings({
    client,
    onSaved,
    initialSection = "account",
    onManageAccount,
  }: {
    client: AISettingsClient;
    onSaved?: (target?: ProviderUpdate["target"]) => void;
    initialSection?: "translation" | "ask-default" | "account";
    onManageAccount?: () => void;
  }) {
    const React = getReact();
    const [catalog, setCatalog] = React.useState<ProviderCatalog | null>(null);
    const [section, setSection] = React.useState<
      "translation" | "ask-default" | "account"
    >(initialSection);
    const [model, setModel] = React.useState<ModelConfig | null>(null);
    const [key, setKey] = React.useState("");
    const [newAccount, setNewAccount] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [oauthConnected, setOAuthConnected] = React.useState(false);
    const onOAuthStatus = React.useCallback(
      (status: OAuthStatus) => setOAuthConnected(status.connected),
      [],
    );
    const oauthRequest = React.useCallback(
      (action: "start" | "status" | "cancel" | "logout") =>
        client.oauth!(action),
      [client],
    );
    const load = React.useCallback(async () => {
      setBusy(true);
      setError("");
      try {
        const next = await client.providers();
        setCatalog(next);
        setModel(
          initialSection === "ask-default"
            ? (next.askModel ?? next.model)
            : next.model,
        );
      } catch {
        setError("连接不可用，请检查本地助手或选择模型直连。");
      } finally {
        setBusy(false);
      }
    }, [client, initialSection]);
    React.useEffect(() => {
      void load();
    }, [load]);
    function navigate(target: typeof section) {
      setSection(target);
      setKey("");
      setError("");
      setNotice("");
      setNewAccount(false);
      const selected =
        target === "ask-default"
          ? (catalog?.askModel ?? catalog?.model)
          : catalog?.model;
      setModel(selected ?? null);
    }
    const account = catalog?.accounts?.find((item) =>
      model?.accountId
        ? item.id === model.accountId && accountMatches(item, model)
        : model && accountMatches(item, model),
    );
    const configured =
      !newAccount &&
      (Boolean(account && account.keyConfigured !== false) ||
        Boolean(
          catalog?.keyConfigured &&
          model &&
          accountMatches({ id: "", name: "", model: catalog.model }, model),
        ));
    const title =
      section === "translation"
        ? "翻译模型"
        : section === "ask-default"
          ? "Ask 默认模型"
          : "供应商";
    async function save(remove = false) {
      if (!model) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const reply = await client.configureProvider({
          model,
          target: remove ? "remove-account" : section,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
          ...(newAccount ? { newAccount: true } : {}),
        });
        if (!reply.ok) throw new Error(reply.error);
        setKey("");
        setNewAccount(false);
        onSaved?.(remove ? "remove-account" : section);
        const next = await client.providers();
        setCatalog(next);
        setModel(
          section === "ask-default"
            ? (next.askModel ?? next.model)
            : section === "translation" || remove
              ? next.model
              : (next.accounts.find((item) => item.id === model.accountId)
                  ?.model ??
                next.accounts.at(-1)?.model ??
                model),
        );
        setNotice(
          remove
            ? "供应商已移除"
            : section === "account"
              ? "供应商已保存，切换时无需重新输入 Key"
              : section === "translation"
                ? "翻译配置已保存，不影响 Ask 会话"
                : "Ask 默认模型已保存，已有会话保持原配置",
        );
      } catch (reason) {
        setError(
          reason instanceof Error
            ? `保存失败：${reason.message}`
            : "保存失败，请重试",
        );
      } finally {
        setBusy(false);
      }
    }
    return (
      <div className="ls-settings">
        <style>{aiWorkspaceStyles}</style>
        <section className="ls-settings-content" aria-label={title}>
          <header className="ls-section-header">
            <div>
              <span className="ls-overline">
                {section === "account" ? "CONNECTIONS" : "MODEL PREFERENCES"}
              </span>
              <h2>{title}</h2>
              <p>
                {section === "translation"
                  ? "为双语阅读选择模型，保持轻快、准确。"
                  : section === "ask-default"
                    ? "新对话从这里开始，每个会话都能单独调整。"
                    : "连接一次，在翻译与对话中随时切换。"}
              </p>
            </div>
            <span className="ls-connection">
              {catalog ? "已连接" : "未连接"}
            </span>
          </header>
          {error && (
            <p className="ls-notification error" role="alert">
              {error}
            </p>
          )}
          {!catalog || !model ? (
            <button disabled={busy} onClick={() => void load()}>
              {busy ? "连接中…" : "重新连接"}
            </button>
          ) : (
            <>
              {section === "account" && (
                <div className="ls-accounts">
                  {catalog.accounts?.map((item) => (
                    <button
                      key={item.id}
                      className="ls-account"
                      aria-pressed={!newAccount && account?.id === item.id}
                      disabled={busy}
                      onClick={() => {
                        setModel({ ...item.model, accountId: item.id });
                        setKey("");
                        setNewAccount(false);
                        setNotice("");
                      }}
                    >
                      <span className="ls-account-icon">
                        {providerConnectionLabel(item, catalog)
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                      <span>
                        <strong>
                          {providerConnectionLabel(item, catalog)}
                        </strong>
                        <small>
                          {item.model.provider} ·{" "}
                          {item.model.authMode === "subscription"
                            ? "订阅"
                            : "API Key 已保存"}
                        </small>
                      </span>
                      <span aria-hidden>↗</span>
                    </button>
                  ))}
                  <button
                    className="ls-add-account"
                    disabled={busy}
                    onClick={() => {
                      setModel({
                        ...model,
                        accountId: undefined,
                        authMode: "api_key",
                      });
                      setKey("");
                      setNewAccount(true);
                    }}
                  >
                    ＋ 添加供应商
                  </button>
                </div>
              )}
              <div className="ls-preferences-card">
                {section === "account" ? (
                  <label>
                    供应商
                    <select
                      aria-label="供应商"
                      value={model.provider}
                      disabled={busy}
                      onChange={(event) => {
                        const provider = event.target.value;
                        const selected = catalog.providers.find(
                          (item) => item.id === provider,
                        )?.models[0];
                        setModel({
                          ...model,
                          provider,
                          accountId: undefined,
                          authMode: "api_key",
                          model: selected?.id ?? model.model,
                          endpoint:
                            selected?.endpoint ?? "https://api.example.com/v1",
                          thinkingLevel: undefined,
                          capabilities: undefined,
                          prices: null,
                        });
                        setKey("");
                        setNotice("");
                      }}
                    >
                      {catalog.providers
                        .filter(
                          (item) =>
                            item.models.length &&
                            item.id !== "openai-compatible",
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      <option value="openai-compatible">
                        自定义 · OpenAI 兼容
                      </option>
                    </select>
                  </label>
                ) : (
                  <ModelPreferences
                    catalog={catalog}
                    model={model}
                    disabled={busy}
                    onChange={(next) => {
                      setModel(next);
                      setKey("");
                      setNotice("");
                    }}
                  />
                )}
                {(section === "account" ||
                  (model.provider === "openai-compatible" && !configured)) && (
                  <label>
                    API 地址
                    <input
                      aria-label="API 地址"
                      type="url"
                      disabled={busy}
                      value={model.endpoint}
                      onChange={(event) =>
                        setModel({
                          ...model,
                          endpoint: event.target.value,
                          accountId: undefined,
                        })
                      }
                    />
                  </label>
                )}
                {model.provider === "openai" &&
                  client.oauth &&
                  catalog.oauth && (
                    <ProviderAuth
                      mode={model.authMode}
                      onMode={(authMode) => {
                        setModel({ ...model, authMode, accountId: undefined });
                        setKey("");
                      }}
                      request={oauthRequest}
                      onStatus={onOAuthStatus}
                      disabled={busy}
                    />
                  )}
                {model.authMode !== "subscription" &&
                  (section === "account" || !configured) && (
                    <label>
                      API Key{" "}
                      <span className="ls-field-note">
                        {configured ? "已保存 · 留空保留" : "添加后可反复使用"}
                      </span>
                      <input
                        aria-label="API Key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        value={key}
                        placeholder={
                          configured
                            ? "已配置 · 留空保留现有 Key"
                            : "输入该供应商的 API Key"
                        }
                        onChange={(event) => setKey(event.target.value)}
                      />
                    </label>
                  )}
                {configured && section !== "account" && (
                  <div className="ls-connected-account">
                    <span>
                      ◈ 已连接 ·{" "}
                      {account
                        ? providerConnectionLabel(account, catalog)
                        : model.provider}
                      <small>{model.endpoint}</small>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onManageAccount
                          ? onManageAccount()
                          : navigate("account")
                      }
                    >
                      管理供应商 ↗
                    </button>
                  </div>
                )}
              </div>
              <footer className="ls-settings-footer">
                <span role="status">
                  {notice ||
                    (section === "account"
                      ? "Key 不会返回给页面或写入同步存储"
                      : "仅更改此任务的默认模型")}
                </span>
                <div>
                  {section === "account" && account && !newAccount && (
                    <button disabled={busy} onClick={() => void save(true)}>
                      移除供应商
                    </button>
                  )}
                  <button
                    className="primary lingo-sofa-primary"
                    disabled={
                      busy ||
                      !model.model.trim() ||
                      (model.authMode === "subscription"
                        ? !oauthConnected
                        : !configured && !key.trim() && !catalog.piAuth)
                    }
                    onClick={() => void save()}
                  >
                    {busy ? "保存中…" : "保存配置"}
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    );
  };
}
