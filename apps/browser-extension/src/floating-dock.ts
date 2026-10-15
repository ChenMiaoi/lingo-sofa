import {
  readFloatingPreferences,
  type FloatingPreferences,
} from "./floating-preferences.js";

export const floatingDockStyles = `
.dock .launcher::before{content:"";position:absolute;top:0;bottom:0;width:16px}.dock[data-side=right] .launcher::before{right:-16px}.dock[data-side=left] .launcher::before{left:-16px}
.dock[data-idle=true][data-side=right] .launcher[data-translation]::after{right:auto;left:4px}
.dock{width:48px;height:48px;pointer-events:none}.dock .launcher,.dock .pane{pointer-events:auto}.dock .launcher{position:relative;cursor:grab;user-select:none;transition:transform .2s ease,opacity .2s ease}.dock .launcher img{pointer-events:none;user-select:none}.dock[data-idle=true][data-side=right] .launcher{transform:translateX(48px);opacity:.5}.dock[data-idle=true][data-side=left] .launcher{transform:translateX(-48px);opacity:.5}.dock[data-dragging=true] .launcher{cursor:grabbing;transition:none}.dock-preferences{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}.dock-preferences h3{font-size:12px;font-weight:600;margin:0 0 10px}.dock-preferences .auto-row{border-top:0;margin:0;padding:0}.dock-preferences .auto-row strong{font-size:12px}.dock-preferences .hint{font-size:11px}.dock-hide{font-size:12px;width:100%;margin-top:14px}.dock-shortcut{font-size:11px;color:var(--ls-muted);margin:8px 0 0}@media(prefers-reduced-motion:reduce){.dock .launcher{transition:none}}
`;

/** Pointer, keyboard and idle behavior belong to the host UI, not translation. */
export function createFloatingDock(
  document: Document,
  dock: HTMLElement,
  launcher: HTMLButtonElement,
  options: {
    load: () => Promise<FloatingPreferences>;
    save: (patch: Partial<FloatingPreferences>) => Promise<void>;
    close: () => void;
    moved: () => void;
    changed: (preferences: FloatingPreferences) => void;
    error: () => void;
  },
) {
  const view = document.defaultView!;
  const size = 48;
  const margin = 16;
  let preferences = readFloatingPreferences(undefined);
  let active = true;
  let positionTouched = false;
  let autoHideTouched = false;
  let open = false;
  let busy = false;
  let hovered = false;
  let keyboardFocus = false;
  let hidden = false;
  let suppressClick = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let write = Promise.resolve();
  let drag:
    | {
        pointer: number;
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
      }
    | undefined;
  const clamp = (value: number, extent: number) =>
    Math.max(margin, Math.min(value, Math.max(margin, extent - size - margin)));
  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  function wake() {
    clearIdle();
    dock.dataset.idle = "false";
  }
  function scheduleIdle() {
    clearIdle();
    if (
      !active ||
      !preferences.autoHide ||
      open ||
      busy ||
      hovered ||
      keyboardFocus ||
      hidden ||
      drag ||
      document.hidden
    )
      return;
    idleTimer = setTimeout(() => {
      dock.dataset.idle = "true";
    }, 2_500);
  }
  function draw() {
    dock.dataset.side = preferences.side;
    dock.style.left = preferences.side === "left" ? `${margin}px` : "";
    dock.style.right = preferences.side === "right" ? `${margin}px` : "";
    dock.style.top = `${margin + preferences.y * Math.max(0, view.innerHeight - size - margin * 2)}px`;
    options.moved();
  }
  function save(patch: Partial<FloatingPreferences>) {
    const operation = write.then(() => options.save(patch));
    write = operation.catch(() => undefined);
    return operation;
  }
  function savePosition() {
    positionTouched = true;
    void save({ side: preferences.side, y: preferences.y }).catch(
      options.error,
    );
  }
  function positionAt(left: number, top: number) {
    preferences.side = left + size / 2 < view.innerWidth / 2 ? "left" : "right";
    preferences.y =
      (clamp(top, view.innerHeight) - margin) /
      Math.max(1, view.innerHeight - size - margin * 2);
    draw();
  }
  const enter = () => {
    hovered = true;
    wake();
  };
  const leave = () => {
    hovered = false;
    scheduleIdle();
  };
  const focus = () => {
    keyboardFocus = Boolean(dock.querySelector(":focus-visible"));
    wake();
    scheduleIdle();
  };
  const blur = () => {
    queueMicrotask(() => {
      if (active) focus();
    });
  };
  const down = (event: PointerEvent) => {
    if (!event.isTrusted || event.button !== 0 || !event.isPrimary) return;
    wake();
    keyboardFocus = false;
    suppressClick = false;
    const bounds = dock.getBoundingClientRect();
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      moved: false,
    };
    launcher.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer || !event.isTrusted) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6
    )
      return;
    if (!drag.moved) options.close();
    drag.moved = true;
    suppressClick = true;
    positionTouched = true;
    dock.dataset.dragging = "true";
    dock.style.left = `${clamp(drag.left + event.clientX - drag.x, view.innerWidth)}px`;
    dock.style.right = "auto";
    dock.style.top = `${clamp(drag.top + event.clientY - drag.y, view.innerHeight)}px`;
    options.moved();
  };
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    const bounds = dock.getBoundingClientRect();
    drag = undefined;
    delete dock.dataset.dragging;
    if (event.type === "pointerup" && moved) {
      positionAt(bounds.left, bounds.top);
      savePosition();
    } else if (moved) draw();
    if (launcher.hasPointerCapture(event.pointerId))
      launcher.releasePointerCapture(event.pointerId);
    hovered = launcher.matches(":hover");
    scheduleIdle();
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    wake();
    keyboardFocus = true;
    suppressClick = false;
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    const bounds = dock.getBoundingClientRect();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      preferences.side = event.key === "ArrowLeft" ? "left" : "right";
    else
      preferences.y =
        (clamp(
          bounds.top + (event.key === "ArrowUp" ? -24 : 24),
          view.innerHeight,
        ) -
          margin) /
        Math.max(1, view.innerHeight - size - margin * 2);
    draw();
    savePosition();
  };
  const preventDrag = (event: DragEvent) => event.preventDefault();
  const resize = () => {
    if (!drag) draw();
  };
  const visibility = () => {
    if (document.hidden) clearIdle();
    else scheduleIdle();
  };
  dock.addEventListener("pointerenter", enter);
  dock.addEventListener("pointerleave", leave);
  dock.addEventListener("focusin", focus);
  dock.addEventListener("focusout", blur);
  launcher.addEventListener("pointerdown", down);
  launcher.addEventListener("pointermove", move);
  launcher.addEventListener("pointerup", finish);
  launcher.addEventListener("pointercancel", finish);
  launcher.addEventListener("lostpointercapture", finish);
  launcher.addEventListener("keydown", key);
  launcher.addEventListener("dragstart", preventDrag);
  view.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", visibility);
  for (const image of launcher.querySelectorAll("img")) image.draggable = false;
  draw();
  scheduleIdle();
  void options
    .load()
    .then((value) => {
      if (!active) return;
      const stored = readFloatingPreferences(value);
      preferences = {
        side: positionTouched ? preferences.side : stored.side,
        y: positionTouched ? preferences.y : stored.y,
        autoHide: autoHideTouched ? preferences.autoHide : stored.autoHide,
      };
      if (!drag) draw();
      options.changed(preferences);
      wake();
      scheduleIdle();
    })
    .catch(() => {
      /* Defaults keep the entry usable when storage is unavailable. */
    });
  return {
    consumeClick(event: MouseEvent) {
      const consume = event.detail !== 0 && suppressClick;
      suppressClick = false;
      return consume;
    },
    setOpen(value: boolean) {
      open = value;
      wake();
      scheduleIdle();
    },
    setBusy(value: boolean) {
      if (busy === value) return;
      busy = value;
      if (value) wake();
      else scheduleIdle();
    },
    reveal() {
      hidden = false;
      launcher.hidden = false;
      wake();
      scheduleIdle();
    },
    hide() {
      options.close();
      hidden = true;
      clearIdle();
      launcher.hidden = true;
      (dock.querySelector(":focus") as HTMLElement | null)?.blur();
    },
    async setAutoHide(value: boolean) {
      const previous = preferences.autoHide;
      autoHideTouched = true;
      preferences.autoHide = value;
      wake();
      scheduleIdle();
      try {
        await save({ autoHide: value });
      } catch (error) {
        preferences.autoHide = previous;
        options.changed(preferences);
        wake();
        scheduleIdle();
        throw error;
      }
    },
    destroy() {
      active = false;
      clearIdle();
      dock.removeEventListener("pointerenter", enter);
      dock.removeEventListener("pointerleave", leave);
      dock.removeEventListener("focusin", focus);
      dock.removeEventListener("focusout", blur);
      launcher.removeEventListener("pointerdown", down);
      launcher.removeEventListener("pointermove", move);
      launcher.removeEventListener("pointerup", finish);
      launcher.removeEventListener("pointercancel", finish);
      launcher.removeEventListener("lostpointercapture", finish);
      launcher.removeEventListener("keydown", key);
      launcher.removeEventListener("dragstart", preventDrag);
      view.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
