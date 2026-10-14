import { React } from "@webpack/common";
import type { ProviderCatalog } from "@lingo-sofa/protocol";

export const targetLanguages = [
  "简体中文",
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
  "Português",
  "Italiano",
  "Русский",
  "العربية",
  "हिन्दी",
  "ไทย",
  "Tiếng Việt",
  "Bahasa Indonesia",
];

export function ChannelControls({
  channel,
  language,
  automatic,
  catalog,
  busy,
  notice,
  onLanguage,
  onModel,
  onAutomatic,
  onClose,
}: {
  channel: string;
  language: string;
  automatic: boolean;
  catalog: ProviderCatalog | null;
  busy: boolean;
  notice: string;
  onLanguage: (language: string) => void;
  onModel: (model: string) => void;
  onAutomatic: () => void;
  onClose: () => void;
}) {
  const provider = catalog?.providers.find(
    (provider) => provider.id === catalog.model.provider,
  );
  const models = provider?.models ?? [];
  return (
    <>
      <header className="lingo-sofa-control-heading">
        <div>
          <strong>LingoSofa</strong>
          <span className="lingo-sofa-channel-name">#{channel}</span>
        </div>
        <button aria-label="收起频道控制" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="lingo-sofa-reading-options">
        <label>
          目标语言
          <select
            aria-label="目标语言"
            value={language}
            disabled={busy}
            onChange={(event) => onLanguage(event.target.value)}
          >
            {[...new Set([language, ...targetLanguages])].map((language) => (
              <option key={language}>{language}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="lingo-sofa-field-heading">
            模型<span>{provider?.name ?? "当前供应商"}</span>
          </span>
          <select
            aria-label="模型"
            value={catalog?.model.model ?? ""}
            disabled={busy || !catalog}
            onChange={(event) => onModel(event.target.value)}
          >
            {!catalog ? (
              <option value="">连接本地助手中…</option>
            ) : (
              <>
                {!models.some((model) => model.id === catalog.model.model) && (
                  <option value={catalog.model.model}>
                    {catalog.model.model}
                  </option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
      </div>
      <label className="lingo-sofa-auto-row">
        <span>
          <strong>自动翻译</strong>
          <span className="lingo-sofa-control-hint">
            此频道的新消息与可见历史
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="自动翻译此频道"
          checked={automatic}
          disabled={busy || (!catalog && !automatic)}
          onChange={onAutomatic}
        />
      </label>
      {notice && (
        <p className="lingo-sofa-control-status" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
