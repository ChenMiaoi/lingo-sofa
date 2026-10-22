import { useEffect, useRef, type RefObject } from "react";

const STORE = "lingo-reading-v1";
type Position = { top: number; left: number; open?: number[] };
export function readingHash(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${hash >>> 0}`;
}
export function readReading<T>(key: string | null): T | undefined {
  if (!key) return;
  try {
    return JSON.parse(window.localStorage.getItem(STORE) || "{}")[key] as T;
  } catch {
    return;
  }
}
export function saveReading(key: string | null, value: unknown) {
  if (!key) return;
  try {
    const entries = JSON.parse(window.localStorage.getItem(STORE) || "{}");
    delete entries[key];
    entries[key] = value;
    const recent = Object.entries(entries).slice(-120);
    window.localStorage.setItem(
      STORE,
      JSON.stringify(Object.fromEntries(recent)),
    );
  } catch {
    /* Reading must continue when local storage is unavailable. */
  }
}
export function useReadingPosition(
  ref: RefObject<HTMLElement | null>,
  key: string | null,
  onRestore?: () => void,
) {
  const restore = useRef(onRestore);
  restore.current = onRestore;
  useEffect(() => {
    const element = ref.current;
    if (!key || !element) return;
    const saved = readReading<Position>(key);
    const valid =
      saved && Number.isFinite(saved.top) && Number.isFinite(saved.left);
    const ancestors: HTMLDetailsElement[] = [];
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (parent.tagName === "DETAILS")
        ancestors.push(parent as HTMLDetailsElement);
    let pending = false;
    const apply = () => {
      if (!valid) return;
      pending = ancestors.some((detail) => !detail.open);
      if (pending) return;
      element.scrollTop = Math.max(0, saved.top);
      element.scrollLeft = Math.max(0, saved.left);
    };
    if (valid) {
      element.querySelectorAll("details").forEach((detail, index) => {
        detail.open = Array.isArray(saved.open) && saved.open.includes(index);
      });
      apply();
      restore.current?.();
    } else {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
    const navigate = () => {
      pending = false;
    };
    element.addEventListener("reading-navigation", navigate);
    const onReveal = () => {
      if (pending) apply();
    };
    ancestors.forEach((detail) => detail.addEventListener("toggle", onReveal));
    let latest: Position = valid
      ? saved
      : { top: element.scrollTop, left: element.scrollLeft };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => saveReading(key, latest);
    const capture = () => {
      if (pending) return;
      latest = {
        top: element.scrollTop,
        left: element.scrollLeft,
        open: Array.from(element.querySelectorAll("details")).flatMap(
          (detail, index) => (detail.open ? [index] : []),
        ),
      };
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    element.addEventListener("scroll", capture);
    element.addEventListener("toggle", capture, true);
    window.addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      ancestors.forEach((detail) =>
        detail.removeEventListener("toggle", onReveal),
      );
      element.removeEventListener("reading-navigation", navigate);
      element.removeEventListener("scroll", capture);
      element.removeEventListener("toggle", capture, true);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [key, ref]);
}
