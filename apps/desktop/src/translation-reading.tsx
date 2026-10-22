import { dragWindow } from "./window-drag";
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
    let disposed = false;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      if (disposed || !root.current || !viewport.current || !copy.current)
        return;
      // Measure the rendered copy at the actual window width, including its
      // padding. The remaining space belongs to the toolbar and outer padding.
      const height = Math.ceil(
        root.current.getBoundingClientRect().height -
          viewport.current.getBoundingClientRect().height +
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
    // Window resizing must run outside ResizeObserver delivery; otherwise its
    // layout feedback can trigger another observation in the same frame.
    const schedule = () => {
      if (!disposed && frame === undefined)
        frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new window.ResizeObserver(schedule);
    if (root.current) observer.observe(root.current);
    if (copy.current) observer.observe(copy.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => {
      disposed = true;
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [epoch, detail, text, perform]);
  return (
    <main
      ref={root}
      className={`reading${detail ? " reading-detail" : ""}${error ? " has-error" : ""}`}
    >
      {detail && (
        <header className="reading-heading" onMouseDown={dragWindow}>
          <strong>完整译文</strong>
          <span>滚动阅读 · Esc 返回</span>
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
