import { useEffect, useRef, useState, type RefObject } from "react";
import { settingsIndex } from "./settings-index.js";
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

const sectionGroups = [
  ["阅读", ["translation", "shortcuts"]],
  ["模型与连接", ["intelligence", "accounts", "connection"]],
  ["数据", ["usage", "glossary", "history"]],
  ["应用", ["appearance", "privacy"]],
] as const;

const sectionLabel = (id: string) =>
  sections.find(([key]) => key === id)?.[1] ?? id;

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
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const [target, setTarget] = useState<{ id: string }>();
  const needle = query.trim().toLocaleLowerCase();
  const results = settingsIndex.filter(([id, , title, keywords]) =>
    `${sectionLabel(id)} ${title} ${keywords}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  useEffect(() => {
    const root = content.current;
    if (!target || !root) return;
    let highlighted: HTMLElement | undefined;
    const locate = () => {
      const label = [
        ...root.querySelectorAll<HTMLElement>(`[data-setting="${target.id}"]`),
      ].find((node) => !node.closest("[hidden]"));
      if (!label) return;
      highlighted = label;
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
      <button
        ref={searchToggle}
        className="ls-settings-search-toggle"
        aria-label="搜索"
        aria-expanded={searchOpen}
        aria-controls="ls-settings-search-panel"
        onClick={() => {
          setSearchOpen(!searchOpen);
          if (searchOpen) setQuery("");
        }}
      >
        ⌕
      </button>
      <div
        id="ls-settings-search-panel"
        className={`ls-settings-search-box${searchOpen ? " ls-search-open" : ""}`}
      >
        <input
          ref={search}
          className="ls-settings-search"
          type="search"
          aria-label="搜索设置"
          placeholder="搜索设置，如语言、缓存"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              setSearchOpen(false);
              searchToggle.current?.focus();
            }
          }}
        />
      </div>
      {needle ? (
        <nav aria-label="设置搜索结果">
          {results.map(([id, settingId, title]) => (
            <button
              key={`${id}:${title}`}
              onClick={() => {
                onSelect(id);
                setTarget({ id: settingId });
                setQuery("");
                setSearchOpen(false);
              }}
            >
              <strong>{title}</strong>
              <small>{sectionLabel(id)}</small>
            </button>
          ))}
          {!results.length && (
            <p role="status" className="ls-search-empty">
              没有匹配的设置
            </p>
          )}
        </nav>
      ) : (
        <>
          <nav className="ls-settings-desktop-nav" aria-label="设置导航">
            {sectionGroups.map(([group, ids]) => (
              <div className="ls-settings-nav-group" key={group}>
                <span>{group}</span>
                {ids.map((id) => (
                  <button
                    key={id}
                    aria-current={section === id ? "page" : undefined}
                    onClick={() => {
                      setTarget(undefined);
                      onSelect(id);
                    }}
                  >
                    {sectionLabel(id)}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <nav className="ls-settings-mobile-nav" aria-label="设置导航">
            <label>
              <span>设置栏目</span>
              <select
                aria-label="设置栏目"
                value={section}
                onChange={(event) => {
                  setTarget(undefined);
                  onSelect(event.target.value);
                }}
              >
                {sectionGroups.map(([group, ids]) => (
                  <optgroup key={group} label={group}>
                    {ids.map((id) => (
                      <option key={id} value={id}>
                        {sectionLabel(id)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </nav>
        </>
      )}
    </>
  );
}
