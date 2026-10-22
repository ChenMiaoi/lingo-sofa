import React, { useLayoutEffect, useRef } from "react";
import type { Perform } from "./view";

export function TranslationReading({
  text,
  loading,
  error,
  detail,
  epoch,
  perform,
  children,
}: {
  text: string;
  loading: boolean;
  error: boolean;
  detail: boolean;
  epoch: number;
  perform: Perform;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const measured = useRef({ epoch: -1, height: 0 });
  useLayoutEffect(() => {
    viewport.current?.scrollTo?.(0, 0);
    if (detail) viewport.current?.focus();
  }, [epoch, detail]);
  useLayoutEffect(() => {
    if (detail) return;
    const measure = () => {
      if (!root.current || !viewport.current || !copy.current) return;
      // Measure the rendered copy at the actual window width, including its
      // padding. The remaining space belongs to the toolbar and outer padding.
      const height = Math.ceil(
        root.current.clientHeight -
          viewport.current.clientHeight +
          copy.current.scrollHeight,
      );
      if (
        height > 0 &&
        (measured.current.epoch !== epoch || measured.current.height !== height)
      ) {
        measured.current = { epoch, height };
        void perform("resize_translation", { epoch, height });
      }
    };
    measure();
    const observer = new window.ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    if (copy.current) observer.observe(copy.current);
    return () => observer.disconnect();
  }, [epoch, detail, text, perform]);
  return (
    <main
      ref={root}
      className={`reading${detail ? " reading-detail" : ""}${error ? " has-error" : ""}`}
    >
      {detail && (
        <header className="reading-heading" data-tauri-drag-region>
          <strong data-tauri-drag-region>完整译文</strong>
          <span data-tauri-drag-region>滚动阅读 · Esc 返回</span>
        </header>
      )}
      <section
        ref={viewport}
        className="annotation"
        aria-label="译文"
        tabIndex={0}
      >
        <div ref={copy} className="translation-copy">
          <p className={loading ? "loading" : ""} role="status">
            {text}
          </p>
        </div>
      </section>
      <div className="reading-controls">{children}</div>
    </main>
  );
}
