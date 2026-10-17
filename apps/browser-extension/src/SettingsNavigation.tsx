import { useEffect, useState, type RefObject } from "react";
export const sections = [
  ["translation", "翻译偏好"],
  ["intelligence", "问答设置"],
  ["accounts", "供应商"],
  ["connection", "连接方式"],
  ["usage", "用量与费用"],
  ["glossary", "术语表"],
  ["history", "请求历史"],
  ["shortcuts", "快捷键"],
  ["appearance", "外观"],
  ["privacy", "隐私与数据"],
] as const;

const settingsIndex = [
  ["translation", "翻译引擎", "必应 谷歌 免费 bing google 模型"],
  ["translation", "目标语言", "语言 中文 英文 日语"],
  ["translation", "显示方式", "双语 译文"],
  ["translation", "网站规则", "自动翻译 网站"],
  ["intelligence", "Ask 默认模型", "问答 AI Pi"],
  ["connection", "连接方式", "本地助手 直连 Discord"],
  ["accounts", "供应商", "账户 API Key 登录"],
  ["usage", "用量与费用", "消耗 tokens 费用 余额"],
  ["glossary", "术语表", "词汇 译法"],
  ["history", "请求历史", "记录 失败 耗时"],
  ["shortcuts", "快速打开 Ask", "快捷键 键盘"],
  ["appearance", "颜色主题", "外观 深色 浅色 系统"],
  ["privacy", "本地译文缓存", "缓存 复用"],
  ["privacy", "历史保留天数", "记录 保存 保留"],
  ["privacy", "统计时区", "时间"],
  ["privacy", "清理数据", "删除 清除 隐私"],
] as const;

export function SettingsNavigation({
  section,
  onSelect,
  content,
}: {
  section: string;
  onSelect: (id: string) => void;
  content: RefObject<HTMLDivElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ title: string }>();
  const needle = query.trim().toLocaleLowerCase();
  const results = settingsIndex.filter(([id, title, keywords]) =>
    `${sections.find(([key]) => key === id)?.[1]} ${title} ${keywords}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  useEffect(() => {
    const root = content.current;
    if (!target || !root) return;
    let highlighted: HTMLElement | undefined;
    const locate = () => {
      const label = [
        ...root.querySelectorAll<HTMLElement>("h1,h2,strong,summary,button"),
      ].find(
        (node) =>
          node.textContent?.trim() === target.title &&
          !node.closest("[hidden]"),
      );
      if (!label) return;
      highlighted =
        label.closest<HTMLElement>(
          ".ls-setting-row,.ls-design-card,details,.ls-design-heading",
        ) ?? label;
      if (highlighted instanceof HTMLDetailsElement) highlighted.open = true;
      highlighted.classList.add("ls-search-highlight");
      highlighted.tabIndex = -1;
      highlighted.scrollIntoView({ block: "center" });
      highlighted.focus({ preventScroll: true });
      observer.disconnect();
    };
    const observer = new MutationObserver(locate);
    observer.observe(root, { childList: true, subtree: true });
    locate();
    return () => {
      observer.disconnect();
      highlighted?.classList.remove("ls-search-highlight");
      highlighted?.removeAttribute("tabindex");
    };
  }, [target, section, content]);
  return (
    <>
      <input
        className="ls-settings-search"
        type="search"
        aria-label="搜索设置"
        placeholder="搜索设置，如语言、缓存"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {needle ? (
        <nav aria-label="设置搜索结果">
          {results.map(([id, title]) => (
            <button
              key={`${id}:${title}`}
              onClick={() => {
                onSelect(id);
                setTarget({ title });
                setQuery("");
              }}
            >
              <strong>{title}</strong>
              <small>{sections.find(([key]) => key === id)?.[1]}</small>
            </button>
          ))}
          {!results.length && (
            <p role="status" className="ls-search-empty">
              没有匹配的设置
            </p>
          )}
        </nav>
      ) : (
        <nav aria-label="设置导航">
          {sections.map(([id, label]) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                setTarget(undefined);
                onSelect(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
