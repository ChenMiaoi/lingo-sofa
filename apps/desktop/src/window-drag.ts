import type { MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

const interactive =
  'button, a, input, textarea, select, label, summary, [contenteditable], [tabindex], [role="button"], [data-no-drag]';

export function canDragWindow(
  target: EventTarget | null,
  button: number,
): boolean {
  return (
    button === 0 && target instanceof Element && !target.closest(interactive)
  );
}

export function dragWindow(event: MouseEvent<HTMLElement>) {
  if (!canDragWindow(event.target, event.button)) return;
  event.preventDefault();
  event.stopPropagation();
  void invoke("drag_window").catch(console.error);
}
