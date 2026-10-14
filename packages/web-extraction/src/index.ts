import type { TranslationBilling } from "@lingo-sofa/protocol";
import {
  renderTranslationMarkdown,
  inlineTranslationStyle,
  appendTranslationBilling,
} from "@lingo-sofa/ui-shared";
export const TRANSLATION_ATTRIBUTE = "data-lingo-sofa";
export const BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
const EXCLUDED =
  "nav,header,footer,aside,pre,script,style,noscript,form,input,textarea,select,button,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[data-lingo-sofa]";
export interface Block {
  element: HTMLElement;
  text: string;
  protectedParts: string[];
}
function visible(
  element: HTMLElement,
  cache: WeakMap<HTMLElement, boolean>,
): boolean {
  const stored = cache.get(element);
  if (stored !== undefined) return stored;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const result =
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
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
          (block) => !block.closest("[data-lingo-sofa]"),
        )
      )
        return false;
      return (
        Boolean(textOf(element, visibility, true)) &&
        visible(element, visibility)
      );
    })
    .map((element) => ({
      element,
      text: textOf(element, visibility),
      protectedParts: [...element.querySelectorAll("code,a")]
        .filter((node) => !node.closest(EXCLUDED))
        .map((node) => textOf(node as HTMLElement, visibility))
        .filter(Boolean),
    }))
    .filter((block) => block.text.length > 0 && block.text.length <= 16_000);
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
    const protectedElement = node.parentElement.closest("code,a");
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
interface State {
  id: string;
  revision: number;
  text: string;
  result?: HTMLElement;
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
        "class",
        "style",
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
      failed: states.filter(
        (state) =>
          state.result?.getAttribute(TRANSLATION_ATTRIBUTE) === "error",
      ).length,
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
      if (previous?.text === block.text) continue;
      previous?.controller?.abort();
      previous?.result?.remove();
      const state: State = {
        id: previous?.id ?? `block-${++this.sequence}`,
        revision: (previous?.revision ?? 0) + 1,
        text: block.text,
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
      state.result ||
      this.stopped ||
      (this.paused && !explicit)
    )
      return;
    const block = extract(element).find(
      (candidate) => candidate.element === element,
    );
    if (!block) return;
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
          textOf(element) !== state.text
        )
          return;
        const node = this.document.createElement("span");
        node.setAttribute(TRANSLATION_ATTRIBUTE, "translation");
        node.lang =
          this.options.targetLanguage === "简体中文"
            ? "zh-CN"
            : this.options.targetLanguage;
        node.style.cssText = inlineTranslationStyle;
        node.innerHTML = renderTranslationMarkdown(
          typeof text === "string" ? text : text.text,
        );
        if (typeof text !== "string")
          appendTranslationBilling(node, text.billing);
        node.setAttribute("aria-label", "LingoSofa 译文");
        element.append(node);
        state.result = node;
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          element.isConnected &&
          textOf(element) === state.text &&
          !this.stopped &&
          this.states.get(element) === state
        ) {
          this.options.onError?.(error);
          const node = this.document.createElement("span");
          node.setAttribute(TRANSLATION_ATTRIBUTE, "error");
          const button = this.document.createElement("button");
          button.type = "button";
          button.textContent = "LingoSofa：翻译失败，重试";
          button.addEventListener("click", () => {
            node.remove();
            delete state.result;
            this.enqueue(element);
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
