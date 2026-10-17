const examples: Record<string, string> = {
  简体中文: "一点上下文，就能带来很大的帮助。",
  繁體中文: "一點上下文，就能帶來很大的幫助。",
  日本語: "少しの文脈が、大きな助けになります。",
  한국어: "약간의 맥락만 있어도 큰 도움이 됩니다.",
  Français: "Un peu de contexte peut être très utile.",
  Deutsch: "Ein wenig Kontext kann sehr hilfreich sein.",
  Español: "Un poco de contexto puede ser de gran ayuda.",
};
export function BilingualPreview({ language }: { language: string }) {
  const english = "A little context goes a long way.";
  const supported = language === "English" || Object.hasOwn(examples, language);
  return (
    <div className="ls-bilingual-preview" aria-label="双语效果预览">
      <span className="ls-status-chip">
        效果预览 · {supported ? language : "简体中文示例"}
      </span>
      <p>{language === "English" ? examples["简体中文"] : english}</p>
      <p>
        {language === "English"
          ? english
          : supported
            ? examples[language]
            : examples["简体中文"]}
      </p>
      <small>
        {supported
          ? "静态示例，不发送翻译请求。原文保留在同一阅读位置。"
          : "此语言暂无静态示例；实际翻译使用你选择的目标语言。"}
      </small>
    </div>
  );
}
