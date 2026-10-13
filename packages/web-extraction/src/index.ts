export const TRANSLATION_ATTRIBUTE = "data-lingo-sofa";
export const BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
const EXCLUDED =
  "nav,header,footer,aside,pre,script,style,noscript,form,input,textarea,select,button,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[data-lingo-sofa]";
export interface Block {
  element: HTMLElement;
  text: string;
  protectedParts: string[];
}
export function textOf(element: HTMLElement): string {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const parts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest(EXCLUDED)) continue;
    let visible = true;
    for (
      let parent = node.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(parent);
      if (style?.display === "none" || style?.visibility === "hidden") {
        visible = false;
        break;
      }
    }
    if (visible) parts.push(node.textContent ?? "");
  }
  return parts.join("").trim();
}
export function extract(root: ParentNode): Block[] {
  const elements = [
    ...(root instanceof HTMLElement && root.matches(BLOCKS) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(BLOCKS),
  ];
  return elements
    .filter((element) => {
      if (element.closest(EXCLUDED) || element.querySelector(BLOCKS))
        return false;
      const view = element.ownerDocument.defaultView;
      for (
        let ancestor: HTMLElement | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = view?.getComputedStyle(ancestor);
        if (style?.display === "none" || style?.visibility === "hidden")
          return false;
      }
      return true;
    })
    .map((element) => ({
      element,
      text: textOf(element),
      protectedParts: [...element.querySelectorAll("code,a")]
        .filter((node) => !node.closest(EXCLUDED))
        .map((node) => node.textContent ?? "")
        .filter(Boolean),
    }))
    .filter((block) => block.text.length > 0 && block.text.length <= 16_000);
}
interface State {
  id: string;
  revision: number;
  text: string;
  result?: HTMLElement;
  pending?: string;
  controller?: AbortController;
}
export interface PageTranslatorOptions {
  targetLanguage: string;
  translate: (
    block: Block,
    id: string,
    revision: string,
    signal: AbortSignal,
  ) => Promise<string>;
  onError?: (error: unknown) => void;
  observeVisibility?: boolean;
}
export class PageTranslator {
  private states = new Map<HTMLElement, State>();
  private observer: MutationObserver | undefined;
  private intersection: IntersectionObserver | undefined;
  private stopped = true;
  private sequence = 0;
  constructor(
    private readonly document: Document,
    private readonly options: PageTranslatorOptions,
  ) {}
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
          for (const entry of entries)
            if (entry.isIntersecting) this.enqueue(entry.target as HTMLElement);
        },
        { rootMargin: "200px" },
      );
    this.scan(this.document);
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
        }
      for (const root of roots) this.scan(root);
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
  }
  private scan(root: ParentNode): void {
    const candidates = extract(root);
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
  private enqueue(element: HTMLElement): void {
    const state = this.states.get(element);
    if (!state || state.pending || state.result || this.stopped) return;
    const block = extract(element).find(
      (candidate) => candidate.element === element,
    );
    if (!block) return;
    const controller = new AbortController();
    state.controller = controller;
    state.pending = `${state.revision}`;
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
        node.style.cssText =
          "display:block;margin-block:0.4em;color:inherit;opacity:0.88;border-inline-start:2px solid #238363;padding-inline-start:0.6em;white-space:pre-wrap";
        node.textContent = text;
        node.setAttribute("aria-label", "LingoSofa 译文");
        element.append(node);
        state.result = node;
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
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
        delete state.pending;
      });
  }
}
