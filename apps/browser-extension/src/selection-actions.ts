import { selectedContent } from "@lingo-sofa/web-extraction";
import { themeAliases, themeStyles } from "@lingo-sofa/ui-shared";
import { bindAppearance } from "./appearance.js";

/** Selection only reveals actions; text leaves the page after a trusted click. */
export function createSelectionActions(
  document: Document,
  actions: {
    enabled: () => boolean;
    translate: () => Promise<void>;
    ask: () => void;
  },
) {
  const window = document.defaultView!;
  const host = document.createElement("div");
  host.dataset.lingoSofa = "selection-actions";
  host.hidden = true;
  host.style.cssText = "position:fixed;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${themeStyles(":host")}
    :host{${themeAliases}font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
    :host([hidden]){display:none!important}
    .actions{display:flex;padding:4px;gap:2px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 4px 18px #0002}
    button{font:inherit;color:inherit;background:transparent;border:0;border-radius:6px;padding:7px 13px;cursor:pointer;white-space:nowrap}
    button:hover{background:var(--soft)}button:focus-visible{outline:2px solid var(--muted);outline-offset:-2px}
    button+button{border-left:1px solid var(--line)}
  `;
  const toolbar = document.createElement("div");
  toolbar.className = "actions";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "选中文字操作");
  let snapshot = "";
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    host.hidden = true;
    snapshot = "";
  };
  for (const [label, run] of [
    ["翻译", actions.translate],
    ["Ask", actions.ask],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    // Keep the source selection while clicking either action.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.onclick = (event) => {
      if (!event.isTrusted) return;
      const valid =
        actions.enabled() &&
        snapshot &&
        selectedContent(document).text === snapshot;
      hide();
      if (valid) void run();
    };
    toolbar.append(button);
  }
  shadow.append(style, toolbar);
  document.body.append(host);
  const unbind = bindAppearance(host);
  const show = () => {
    hide();
    if (
      dragging ||
      !actions.enabled() ||
      document.activeElement?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-lingo-sofa="ask"]',
      )
    )
      return;
    const text = selectedContent(document).text;
    const selection = document.getSelection();
    if (!text || selection?.isCollapsed || !selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight
    )
      return;
    snapshot = text;
    host.hidden = false;
    const box = host.getBoundingClientRect();
    host.style.left = `${Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.left + (rect.width - box.width) / 2))}px`;
    const top =
      rect.top >= box.height + 16 ? rect.top - box.height - 8 : rect.bottom + 8;
    host.style.top = `${Math.max(8, Math.min(window.innerHeight - box.height - 8, top))}px`;
  };
  const schedule = () => {
    hide();
    if (!dragging) timer = setTimeout(show, 160);
  };
  const down = (event: PointerEvent) => {
    if (event.composedPath().includes(host)) return;
    dragging = true;
    hide();
  };
  const up = (event: PointerEvent) => {
    if (event.composedPath().includes(host)) return;
    dragging = false;
    schedule();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") hide();
  };
  document.addEventListener("selectionchange", schedule);
  document.addEventListener("pointerdown", down);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  document.addEventListener("keydown", key);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  return {
    destroy() {
      hide();
      unbind();
      host.remove();
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    },
  };
}
