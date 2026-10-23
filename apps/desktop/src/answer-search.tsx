import React, { useEffect, useRef, useState, type RefObject } from "react";
import { isImeKey } from "./api";

type Match = {
  range: Range;
  element: HTMLElement;
  block: number;
  start: number;
  end: number;
};
const BLOCKS =
  ".answer-prose p,.answer-prose h1,.answer-prose h2,.answer-prose h3,.answer-prose h4,.answer-prose li,.answer-prose pre,.answer-prose td,.answer-prose th,.tool-body pre";
export function findAnswerMatches(root: HTMLElement, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  for (const [block, element] of root
    .querySelectorAll<HTMLElement>(BLOCKS)
    .entries()) {
    if (element.parentElement?.closest(BLOCKS)) continue;
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, 4);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (
        !node.parentElement?.closest(
          "button,.content-toolbar,.selection-actions",
        )
      )
        nodes.push(node as Text);
    }
    const source = nodes.map((node) => node.data).join("");
    // Literal, case-insensitive search; regex indices retain original UTF-16 offsets.
    const regex = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "giu",
    );
    let cursor = 0;
    let offset = 0;
    for (const match of source.matchAll(regex)) {
      const range = document.createRange();
      while (
        cursor < nodes.length - 1 &&
        match.index >= offset + nodes[cursor]!.length
      ) {
        offset += nodes[cursor++]!.length;
      }
      range.setStart(nodes[cursor]!, match.index - offset);
      const end = match.index + match[0].length;
      while (
        cursor < nodes.length - 1 &&
        end > offset + nodes[cursor]!.length
      ) {
        offset += nodes[cursor++]!.length;
      }
      range.setEnd(nodes[cursor]!, end - offset);
      matches.push({ range, element, block, start: match.index, end });
      if (matches.length === 1000) return matches;
    }
  }
  return matches;
}
export function AnswerSearch({
  root,
  content,
  onInspect,
}: {
  root: RefObject<HTMLDivElement | null>;
  content: unknown;
  onInspect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    query: string;
    open: boolean;
    matches: Match[];
  }>({ query: "", open: false, matches: [] });
  const matches = result.matches;
  const [index, setIndex] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const previousNavigation = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const inspect = useRef(onInspect);
  inspect.current = onInspect;
  const show = () => {
    if (!open) previous.current = document.activeElement as HTMLElement;
    inspect.current();
    setOpen(true);
  };
  const move = (step: number) => {
    setIndex((value) =>
      matches.length ? (value + step + matches.length) % matches.length : 0,
    );
    setNavigation((value) => value + 1);
  };
  const close = () => {
    setOpen(false);
    previous.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isImeKey(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (!open) previous.current = document.activeElement as HTMLElement;
        inspect.current();
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      }
      if (open && event.key === "F3") {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, matches.length]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    setIndex(0);
  }, [query, open]);
  useEffect(() => {
    const next =
      open && root.current ? findAnswerMatches(root.current, query) : [];
    setResult({ query, open, matches: next });
    setIndex((value) => Math.min(value, Math.max(next.length - 1, 0)));
  }, [query, open, content, root]);
  useEffect(() => {
    const api = globalThis as unknown as {
      CSS?: { highlights?: Map<string, unknown> };
      Highlight?: new (...ranges: Range[]) => unknown;
    };
    const registry = api.CSS?.highlights;
    const activeMatches =
      open && result.open && result.query === query ? matches : [];
    if (registry && api.Highlight) {
      registry.set(
        "answer-matches",
        new api.Highlight(...activeMatches.map((match) => match.range)),
      );
      registry.set(
        "answer-current",
        new api.Highlight(
          ...(activeMatches[index] ? [activeMatches[index]!.range] : []),
        ),
      );
    }
    const clear = () => {
      registry?.delete("answer-matches");
      registry?.delete("answer-current");
      root.current
        ?.querySelectorAll(".search-current-block")
        .forEach((element) => element.classList.remove("search-current-block"));
    };
    const match = activeMatches[index];
    if (!match) previousNavigation.current = null;
    if (match) {
      const target =
        match.range.startContainer.parentElement?.closest<HTMLElement>(
          ".code-line",
        ) || match.element;
      target.classList.add("search-current-block");
      // Semantic block/text offsets survive markdown node and range replacement.
      // Only explicit navigation or a changed match should move manual reading.
      const key = JSON.stringify([
        query,
        index,
        match.block,
        match.start,
        match.end,
        navigation,
      ]);
      if (previousNavigation.current === key) return clear;
      previousNavigation.current = key;
      let parent: HTMLElement | null = match.element;
      while (parent && parent !== root.current) {
        if (parent.tagName === "DETAILS")
          (parent as HTMLDetailsElement).open = true;
        parent = parent.parentElement;
      }
      target.dispatchEvent(
        new window.Event("reading-navigation", { bubbles: true }),
      );
      target.scrollIntoView({ block: "center", inline: "nearest" });
      const scroller = target.closest<HTMLElement>("pre,.answer-table");
      if (scroller && typeof match.range.getBoundingClientRect === "function") {
        const hit = match.range.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (hit.left < bounds.left || hit.right > bounds.right)
          scroller.scrollLeft += hit.left - bounds.left - 20;
        if (hit.top < bounds.top || hit.bottom > bounds.bottom)
          scroller.scrollTop += hit.top - bounds.top - 20;
      }
    }
    return clear;
  }, [
    matches,
    index,
    root,
    query,
    open,
    result.open,
    result.query,
    navigation,
  ]);
  return (
    <div className="answer-locator">
      <button
        className="answer-search-trigger"
        title="Ctrl+F / ⌘F"
        onClick={show}
      >
        搜索回答
      </button>
      {open && (
        <div
          className="answer-search"
          role="search"
          onKeyDown={(event) => {
            if (isImeKey(event.nativeEvent)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (event.key === "Enter" && event.target === input.current) {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        >
          <input
            ref={input}
            aria-label="搜索回答内容"
            placeholder="搜索回答…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span role="status">
            {query
              ? matches.length
                ? `${index + 1} / ${matches.length}${matches.length === 1000 ? "+" : ""}`
                : "无匹配"
              : "Enter 下一处"}
          </span>
          <button
            disabled={!matches.length}
            aria-label="上一个匹配"
            onClick={() => move(-1)}
          >
            ↑
          </button>
          <button
            disabled={!matches.length}
            aria-label="下一个匹配"
            onClick={() => move(1)}
          >
            ↓
          </button>
          <button aria-label="关闭回答搜索" onClick={close}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
