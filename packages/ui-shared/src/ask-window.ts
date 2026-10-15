export interface AskAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Keep a contextual conversation beside its source, within the usable viewport. */
export function placeAskWindow(
  anchor: AskAnchorRect | null,
  viewport: { width: number; height: number },
  preferredHeight = 660,
) {
  const margin = 12;
  const gap = 12;
  let width = Math.min(420, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(
    preferredHeight,
    Math.max(0, viewport.height - margin * 2),
  );
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(value, max));
  let left = viewport.width - width - margin;
  let top = viewport.height - height - margin;
  let side: "right" | "left" | "below" | "above" | "edge" = "edge";
  if (anchor) {
    top = anchor.top;
    const rightSpace = viewport.width - anchor.right - gap - margin;
    const leftSpace = anchor.left - gap - margin;
    if (
      rightSpace < width &&
      leftSpace < width &&
      Math.max(rightSpace, leftSpace) >= 320
    )
      width = Math.min(width, Math.max(rightSpace, leftSpace));
    if (rightSpace >= width) {
      left = anchor.right + gap;
      side = "right";
    } else if (leftSpace >= width) {
      left = anchor.left - gap - width;
      side = "left";
    } else {
      left = anchor.right - width;
      const below = viewport.height - anchor.bottom - gap - margin;
      const above = anchor.top - gap - margin;
      if (below >= Math.min(height, 420)) {
        top = anchor.bottom + gap;
        side = "below";
      } else if (above >= Math.min(height, 420)) {
        top = anchor.top - gap - Math.min(height, above);
        side = "above";
      }
    }
  }
  const availableHeight =
    side === "below" && anchor
      ? viewport.height - anchor.bottom - gap - margin
      : side === "above" && anchor
        ? anchor.top - gap - margin
        : height;
  const finalHeight = Math.min(height, availableHeight);
  return {
    left: clamp(left, margin, viewport.width - width - margin),
    top: clamp(top, margin, viewport.height - finalHeight - margin),
    width,
    height: finalHeight,
    side,
  };
}

export function textAnchorRect(element: HTMLElement): AskAnchorRect {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : element.getBoundingClientRect();
}

/** Nonmodal dialog: the page stays usable and only the conversation can scroll. */
export function attachAskWindow(
  dialog: HTMLDialogElement,
  anchor: (() => AskAnchorRect | null) | undefined,
  onClose: () => void,
) {
  const document = dialog.ownerDocument;
  const view = document.defaultView!;
  const previous = document.activeElement as HTMLElement | null;
  let frame = 0;
  function position() {
    frame = 0;
    const rect = anchor?.() ?? null;
    if (anchor && !rect) {
      onClose();
      return;
    }
    const viewport = view.visualViewport;
    const visibleRect =
      rect && viewport
        ? {
            left: rect.left - viewport.offsetLeft,
            right: rect.right - viewport.offsetLeft,
            top: rect.top - viewport.offsetTop,
            bottom: rect.bottom - viewport.offsetTop,
          }
        : rect;
    const empty =
      dialog.matches('[data-ask-state="empty"]') ||
      Boolean(dialog.querySelector('[data-ask-state="empty"]'));
    const placement = placeAskWindow(
      visibleRect,
      {
        width: viewport?.width ?? view.innerWidth,
        height: viewport?.height ?? view.innerHeight,
      },
      empty ? 440 : 660,
    );
    Object.assign(dialog.style, {
      position: "fixed",
      margin: "0",
      inset: "auto",
      left: `${placement.left + (viewport?.offsetLeft ?? 0)}px`,
      top: `${placement.top + (viewport?.offsetTop ?? 0)}px`,
      width: `${placement.width}px`,
      height: `${placement.height}px`,
      maxHeight: "none",
      maxWidth: "none",
      zIndex: "2147483647",
    });
    dialog.dataset.placement = placement.side;
  }
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(position);
  };
  const key = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          !dialog.contains(record.target) ||
          record.attributeName === "data-ask-state",
      )
    )
      schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-ask-state"],
  });
  dialog.addEventListener("close", onClose);
  document.addEventListener("keydown", key, true);
  document.addEventListener("scroll", schedule, true);
  view.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("scroll", schedule);
  dialog.setAttribute("aria-modal", "false");
  dialog.show();
  position();
  return () => {
    observer.disconnect();
    dialog.removeEventListener("close", onClose);
    if (frame) view.cancelAnimationFrame(frame);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("scroll", schedule, true);
    view.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("scroll", schedule);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}

export function registerAskShortcut(document: Document, open: () => boolean) {
  const key = (event: KeyboardEvent) => {
    if (
      !event.isTrusted ||
      event.repeat ||
      event.isComposing ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !event.shiftKey ||
      event.code !== "KeyA"
    )
      return;
    const target = event.target as Element | null;
    if (
      target?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.ls-ask,.ls-ask-shell',
      )
    )
      return;
    if (open()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  document.addEventListener("keydown", key);
  return () => document.removeEventListener("keydown", key);
}
