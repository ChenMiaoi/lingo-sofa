import type { TranslationBilling } from "@lingo-sofa/protocol";
import {
  renderTranslationMarkdown,
  inlineTranslationStyle,
  appendTranslationBilling,
  formatTranslationBilling,
} from "@lingo-sofa/ui-shared";
import { inlineMarkdown } from "./inline-markdown.js";
export const TRANSLATION_ATTRIBUTE = "data-lingo-sofa";
const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"],#hnmain .titleline';
export const BLOCKS = `p,li,td,th,blockquote,${HEADINGS}`;
// Article headers carry reading titles. Site banners and utility metadata do
// not, even when they share the same heading, list or table tags.
const EXCLUDED = [
  "math,.katex,.MathJax,mjx-container,nav,footer,aside,pre,script,style,noscript",
  "header:not(main header):not(article header):not([role='main'] header)",
  "form,input,textarea,select,button,summary,time,relative-time,[role='banner'],[role='navigation'],[role='button'],[role='tablist'],[role='toolbar'],[role='complementary']",
  "[translate='no'],.notranslate,.sr-only,.visually-hidden,.sphinxsidebar,#mdbook-menu-bar,a.headerlink",
  "#navigation-bar,.topic-list .link-bottom-line,.topic-list .num,.topic-list .posters,.topic-post-badges,.topic-statuses",
  "#hnmain .subtext,#hnmain .rank,#hnmain .sitebit,#hnmain .pagetop,#hnmain .yclinks,#hnmain .morelink",
  ".mw-editsection,.mw-parser-output .infobox td,.mw-parser-output a[href*='action=edit']",
  "table[aria-labelledby='folders-and-files'],.Timeline-Item:has(> .TimelineBody)",
  "[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[data-lingo-sofa]",
].join(",");
type Presentation = "paragraph" | "heading" | "inline";
export interface Block {
  element: HTMLElement;
  text: string;
  presentation: Presentation;
  protectedParts: string[];
  markdown: string;
  links: Record<string, string>;
}
function presentation(element: HTMLElement, text: string): Presentation {
  if (element.matches(HEADINGS)) return "heading";
  if (element.matches("p,blockquote") || text.replace(/\s+/g, " ").length > 160)
    return "paragraph";
  return "inline";
}
function translatable(text: string): boolean {
  if (!/\p{L}/u.test(text)) return false;
  // Counts and relative timestamps are values, even when they have a suffix.
  return !/^(?:[\d.,]+\s*[kmb%]?|(?:\d+\s*(?:ms|s|m|h|d|w|mo|y)\s*)+(?:ago)?)$/i.test(
    text.trim(),
  );
}
function visible(
  element: HTMLElement,
  cache: WeakMap<HTMLElement, boolean>,
): boolean {
  const stored = cache.get(element);
  if (stored !== undefined) return stored;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const visuallyHidden =
    style?.clipPath === "inset(50%)" ||
    ((style?.position === "absolute" || style?.position === "fixed") &&
      Number.parseFloat(style.width) <= 1 &&
      Number.parseFloat(style.height) <= 1 &&
      style.overflow === "hidden");
  const result =
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
    style?.contentVisibility !== "hidden" &&
    !visuallyHidden &&
    (!element.parentElement || visible(element.parentElement, cache));
  cache.set(element, result);
  return result;
}
export function textOf(
  element: HTMLElement,
  cache = new WeakMap<HTMLElement, boolean>(),
  skipCode = false,
): string {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const parts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()))
    if (
      node.parentElement &&
      !node.parentElement.closest(EXCLUDED) &&
      (!skipCode || !node.parentElement.closest("code")) &&
      visible(node.parentElement, cache)
    )
      parts.push(node.textContent ?? "");
  return parts.join("").trim();
}
export function extract(root: ParentNode): Block[] {
  const visibility = new WeakMap<HTMLElement, boolean>();
  const elements = [
    ...(root instanceof HTMLElement && root.matches(BLOCKS) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(BLOCKS),
  ];
  return elements
    .filter((element) => {
      if (
        element.closest(`${EXCLUDED},code`) ||
        [...element.querySelectorAll(BLOCKS)].some(
          (block) => !block.closest(`${EXCLUDED},code`),
        )
      )
        return false;
      return (
        Boolean(textOf(element, visibility, true)) &&
        visible(element, visibility)
      );
    })
    .map((element) => {
      const text = textOf(element, visibility);
      return {
        element,
        text,
        presentation: presentation(element, text),
        ...inlineMarkdown(
          element,
          (node) => !node.closest(EXCLUDED) && visible(node, visibility),
        ),
      };
    })
    .filter(
      (block) =>
        block.text.length > 0 &&
        translatable(block.text) &&
        block.text.length <= 16_000 &&
        block.markdown.length <= 16_000,
    );
}
export function selectedContent(document: Document): {
  text: string;
  protectedParts: string[];
} {
  const selection = document.defaultView?.getSelection();
  if (!selection?.rangeCount) return { text: "", protectedParts: [] };
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const root =
    ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement;
  if (!root || root.closest(`${EXCLUDED},code`))
    return { text: "", protectedParts: [] };
  const walker = document.createTreeWalker(root, 4);
  const cache = new WeakMap<HTMLElement, boolean>();
  const parts: string[] = [];
  const protectedParts = new Map<Element, string>();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (
      !range.intersectsNode(node) ||
      !node.parentElement ||
      node.parentElement.closest(EXCLUDED) ||
      !visible(node.parentElement, cache)
    )
      continue;
    const text = node.textContent ?? "";
    const selected = text.slice(
      node === range.startContainer ? range.startOffset : 0,
      node === range.endContainer ? range.endOffset : text.length,
    );
    parts.push(selected);
    const protectedElement = node.parentElement.closest("code");
    if (protectedElement)
      protectedParts.set(
        protectedElement,
        (protectedParts.get(protectedElement) ?? "") + selected,
      );
  }
  const text = parts.join("").trim().slice(0, 16_000);
  return {
    text,
    protectedParts: [...protectedParts.values()].filter(
      (part) => part.length && text.includes(part),
    ),
  };
}
export function selectedText(document: Document): string {
  return selectedContent(document).text;
}
export function renderBlockTranslation(
  block: Block,
  translation:
    string | { text: string; billing?: TranslationBilling | undefined },
  targetLanguage: string,
  billingDisplay: "inline" | "tooltip" = "inline",
): HTMLElement {
  const node = block.element.ownerDocument.createElement("span");
  node.setAttribute(TRANSLATION_ATTRIBUTE, "translation");
  node.setAttribute("aria-label", "LingoSofa 译文");
  node.lang = targetLanguage === "简体中文" ? "zh-CN" : targetLanguage;
  const compact = block.presentation !== "paragraph";
  node.style.cssText = compact
    ? `display:${block.presentation === "heading" ? "block;margin-block:0.2em 0" : "inline;margin-inline-start:0.45em"};padding:0;border:0;color:inherit;font:inherit;font-size:0.92em;line-height:1.4;overflow-wrap:anywhere`
    : inlineTranslationStyle;
  node.innerHTML = renderTranslationMarkdown(
    typeof translation === "string" ? translation : translation.text,
    [...block.element.querySelectorAll<HTMLElement>("code")]
      .filter((code) => !code.closest("[data-lingo-sofa]"))
      .map((code) => textOf(code)),
    { breaks: false, inline: compact, links: block.links },
  );
  if (typeof translation !== "string") {
    const billing = formatTranslationBilling(translation.billing);
    node.title = `${billing.text}\n${billing.title}`;
    if (!compact && billingDisplay === "inline")
      appendTranslationBilling(node, translation.billing);
  }
  return node;
}
function fingerprint(block: Block | undefined): string | undefined {
  return (
    block &&
    JSON.stringify([
      block.text,
      block.markdown,
      block.links,
      block.presentation,
    ])
  );
}
interface State {
  fingerprint: string | undefined;
  id: string;
  revision: number;
  result?: HTMLElement;
  error?: string;
  pending?: string;
  controller?: AbortController;
}
export interface PageProgress {
  active: boolean;
  paused: boolean;
  total: number;
  completed: number;
  pending: number;
  failed: number;
  error?: string | undefined;
}
export interface PageTranslatorOptions {
  targetLanguage: string;
  translate: (
    block: Block,
    id: string,
    revision: string,
    signal: AbortSignal,
  ) => Promise<
    string | { text: string; billing?: TranslationBilling | undefined }
  >;
  onError?: (error: unknown) => void;
  observeVisibility?: boolean;
  manual?: boolean;
  onChange?: (progress: PageProgress) => void;
}
export class PageTranslator {
  private states = new Map<HTMLElement, State>();
  private observer: MutationObserver | undefined;
  private intersection: IntersectionObserver | undefined;
  private stopped = true;
  private paused = false;
  private manual: boolean;
  private visibleElements = new Set<HTMLElement>();
  private sequence = 0;
  constructor(
    private readonly document: Document,
    private readonly options: PageTranslatorOptions,
  ) {
    this.manual = options.manual ?? false;
  }
  get trackedCount(): number {
    return this.states.size;
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (
      this.options.observeVisibility !== false &&
      typeof IntersectionObserver !== "undefined"
    )
      this.intersection = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const element = entry.target as HTMLElement;
            if (entry.isIntersecting) {
              this.visibleElements.add(element);
              this.enqueue(element);
            } else this.visibleElements.delete(element);
          }
        },
        { rootMargin: "200px" },
      );
    if (!this.manual) this.scan(this.document);
    this.observer = new MutationObserver((mutations) => {
      const roots = new Set<HTMLElement>();
      for (const mutation of mutations) {
        const parent =
          mutation.target instanceof HTMLElement
            ? mutation.target
            : mutation.target.parentElement;
        if (parent?.closest(`[${TRANSLATION_ATTRIBUTE}]`)) continue;
        const block = parent?.closest<HTMLElement>(BLOCKS);
        if (block) roots.add(block);
        else if (mutation.type === "attributes" && parent) roots.add(parent);
        for (const node of mutation.addedNodes)
          if (
            node instanceof HTMLElement &&
            !node.hasAttribute(TRANSLATION_ATTRIBUTE)
          )
            roots.add(node);
      }
      for (const [element, state] of this.states)
        if (!element.isConnected) {
          state.controller?.abort();
          this.intersection?.unobserve(element);
          this.states.delete(element);
          this.visibleElements.delete(element);
        }
      for (const root of roots) this.scan(root);
      this.notify();
    });
    this.observer.observe(this.document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "aria-hidden",
        "contenteditable",
        "href",
        "class",
        "style",
        "role",
        "translate",
      ],
    });
    this.notify();
  }
  translateElement(element: HTMLElement): void {
    if (this.stopped) this.start();
    this.scan(element, true);
    this.enqueue(element, true);
    this.notify();
  }
  translatePage(): void {
    this.manual = false;
    // Keep completed manual translations when promoting to whole-page reading.
    for (const state of this.states.values())
      state.result
        ?.querySelector(":scope > .lingo-sofa-inline-usage")
        ?.remove();
    if (this.stopped) this.start();
    else {
      this.scan(this.document);
      this.notify();
    }
  }
  pause(): void {
    this.paused = true;
    for (const state of this.states.values()) {
      state.controller?.abort();
      delete state.controller;
      delete state.pending;
    }
    this.notify();
  }
  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    for (const element of this.states.keys())
      if (!this.intersection || this.visibleElements.has(element))
        this.enqueue(element);
    this.notify();
  }
  get progress(): PageProgress {
    const states = [...this.states.values()];
    return {
      active: !this.stopped,
      paused: this.paused,
      total: states.length,
      completed: states.filter(
        (state) =>
          state.result?.getAttribute(TRANSLATION_ATTRIBUTE) === "translation",
      ).length,
      failed: states.filter((state) => state.error).length,
      error: states.find((state) => state.error)?.error,
      pending: states.filter((state) => state.pending).length,
    };
  }
  private notify(): void {
    this.options.onChange?.(this.progress);
  }
  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.intersection?.disconnect();
    for (const state of this.states.values()) {
      state.controller?.abort();
      state.result?.remove();
    }
    this.states.clear();
    this.visibleElements.clear();
    this.paused = false;
    this.notify();
  }
  private scan(root: ParentNode, explicit = false): void {
    const candidates = extract(root).filter(
      (block) => !this.manual || explicit || this.states.has(block.element),
    );
    const eligible = new Set(candidates.map((block) => block.element));
    for (const [element, state] of this.states)
      if (
        root instanceof HTMLElement &&
        (root === element || root.contains(element)) &&
        !eligible.has(element)
      ) {
        state.controller?.abort();
        state.result?.remove();
        this.intersection?.unobserve(element);
        this.states.delete(element);
        this.visibleElements.delete(element);
      }
    for (const block of candidates) {
      const previous = this.states.get(block.element);
      if (previous?.fingerprint === fingerprint(block)) continue;
      previous?.controller?.abort();
      previous?.result?.remove();
      const state: State = {
        fingerprint: fingerprint(block),
        id: previous?.id ?? `block-${++this.sequence}`,
        revision: (previous?.revision ?? 0) + 1,
      };
      this.states.set(block.element, state);
      if (this.intersection) {
        this.intersection.unobserve(block.element);
        this.intersection.observe(block.element);
      } else this.enqueue(block.element);
    }
  }
  private enqueue(element: HTMLElement, explicit = false): void {
    const state = this.states.get(element);
    if (
      !state ||
      state.pending ||
      (state.result && !state.error) ||
      (state.error && !explicit) ||
      this.stopped ||
      (this.paused && !explicit)
    )
      return;
    const block = extract(element).find(
      (candidate) => candidate.element === element,
    );
    if (!block) return;
    state.result?.remove();
    delete state.result;
    delete state.error;
    const controller = new AbortController();
    state.controller = controller;
    state.pending = `${state.revision}`;
    this.notify();
    void this.options
      .translate(block, state.id, `${state.revision}`, controller.signal)
      .then((text) => {
        if (
          controller.signal.aborted ||
          this.stopped ||
          !element.isConnected ||
          this.states.get(element) !== state ||
          fingerprint(
            extract(element).find((candidate) => candidate.element === element),
          ) !== state.fingerprint
        )
          return;
        const node = renderBlockTranslation(
          block,
          text,
          this.options.targetLanguage,
          this.manual ? "inline" : "tooltip",
        );
        element.append(node);
        state.result = node;
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          element.isConnected &&
          fingerprint(
            extract(element).find((candidate) => candidate.element === element),
          ) === state.fingerprint &&
          !this.stopped &&
          this.states.get(element) === state
        ) {
          state.error = error instanceof Error ? error.message : "翻译失败";
          this.options.onError?.(error);
          // Automatic/page failures belong in the shared controls, not every paragraph.
          if (!explicit && !this.manual) return;
          const node = this.document.createElement("span");
          node.setAttribute(TRANSLATION_ATTRIBUTE, "error");
          const button = this.document.createElement("button");
          button.type = "button";
          node.style.cssText =
            "display:block;margin-top:6px;font:inherit;color:inherit";
          button.textContent = "重试翻译";
          button.title = state.error;
          button.setAttribute("aria-label", `重试翻译：${state.error}`);
          button.style.cssText =
            "font:inherit;font-size:.8em;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:2px 6px;cursor:pointer";
          button.addEventListener("click", () => {
            node.remove();
            delete state.result;
            this.enqueue(element, true);
          });
          node.append(button);
          element.append(node);
          state.result = node;
        }
      })
      .finally(() => {
        if (state.controller === controller) {
          delete state.pending;
          delete state.controller;
        }
        this.notify();
      });
  }
}
