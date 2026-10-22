import React, { useEffect, useRef, useState } from "react";
import {
  defaultShortcuts,
  errorMessage,
  isImeKey,
  type ShortcutBindings,
  type ShortcutSnapshot,
} from "./api";
import { capturedShortcut, editableShortcut, formatShortcut } from "./keyboard";
import type { Perform } from "./view";

const fields = [
  ["input", "唤出输入面板"],
  ["selection", "翻译当前选区"],
  ["clipboard", "翻译剪贴板"],
  ["selectionAlternate", "划词翻译"],
  ["ocr", "截图 OCR"],
  ["ocrAlternate", "截图 OCR"],
] as const;

function editableBindings(
  bindings: ShortcutBindings,
  macos: boolean,
): ShortcutBindings {
  return {
    input: editableShortcut(bindings.input, macos),
    selection: editableShortcut(bindings.selection, macos),
    clipboard: editableShortcut(bindings.clipboard, macos),
    selectionAlternate: editableShortcut(bindings.selectionAlternate, macos),
    ocr: editableShortcut(bindings.ocr, macos),
    ocrAlternate: editableShortcut(bindings.ocrAlternate, macos),
  };
}

function sameBindings(a: ShortcutBindings, b: ShortcutBindings): boolean {
  return fields.every(([name]) => a[name] === b[name]);
}

export function ShortcutSettings({
  snapshot,
  notice,
  perform,
  display = "below",
  active = true,
}: {
  active?: boolean;
  display?: "panel" | "below";
  snapshot: ShortcutSnapshot;
  notice: string;
  perform: Perform;
}) {
  const [draft, setDraft] = useState(() =>
    editableBindings(snapshot.bindings, snapshot.macos),
  );
  const [saved, setSaved] = useState(draft);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [recovering, setRecovering] = useState(true);
  const [capture, setCapture] = useState<{
    name: keyof ShortcutBindings;
    token: string | null;
    phase: "preparing" | "ready" | "restoring" | "failed";
    preview: string;
    candidate: string | null;
  } | null>(null);
  const captureRef = useRef(capture);
  const captureRequest = useRef(0);
  const altGraphDown = useRef(false);
  const captureQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const performRef = useRef(perform);
  performRef.current = perform;
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const editVersion = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const awaitingSnapshot = useRef<{
    revision: number;
    editVersion: number;
  } | null>(null);
  const canonical = JSON.stringify(
    editableBindings(snapshot.bindings, snapshot.macos),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const waiting = awaitingSnapshot.current;
    if (waiting && snapshot.revision <= waiting.revision) return;
    const next: ShortcutBindings = JSON.parse(canonical);
    const adoptDraft = waiting
      ? editVersion.current === waiting.editVersion
      : sameBindings(draftRef.current, savedRef.current);
    awaitingSnapshot.current = null;
    savedRef.current = next;
    setSaved(next);
    if (adoptDraft) {
      setFeedback("");
      draftRef.current = next;
      setDraft(next);
    }
  }, [canonical, snapshot.revision]);
  const dirty = !sameBindings(draft, saved);
  const edit = (next: ShortcutBindings) => {
    editVersion.current += 1;
    draftRef.current = next;
    setDraft(next);
    setFeedback("");
  };
  const updateCapture = (next: typeof capture) => {
    captureRef.current = next;
    if (mounted.current) setCapture(next);
  };
  const finishCapture = (commit: boolean) => {
    const current = captureRef.current;
    if (!current) return captureQueue.current;
    if (current.phase === "restoring") return captureQueue.current;
    if (commit && current.candidate && mounted.current)
      edit({ ...draftRef.current, [current.name]: current.candidate });
    updateCapture({ ...current, phase: "restoring", candidate: null });
    captureQueue.current = captureQueue.current.then(async () => {
      let restored = false;
      try {
        restored =
          (await performRef.current("end_shortcut_recording", {
            token: current.token,
          })) !== false;
      } catch {
        /* The local status also covers callers without App's scoped notice. */
      }
      if (captureRef.current?.token === current.token) {
        updateCapture(
          restored ? null : { ...current, phase: "failed", candidate: null },
        );
        if (!restored && mounted.current)
          setFeedback("部分快捷键未恢复，请重试恢复。");
        if (restored && current.phase === "failed" && mounted.current)
          setFeedback("");
      }
      return restored;
    });
    return captureQueue.current;
  };
  const startCapture = async (name: keyof ShortcutBindings) => {
    if (saving || !active || captureRef.current?.phase === "failed") return;
    if (
      captureRef.current?.name === name &&
      captureRef.current.phase !== "restoring"
    )
      return;
    const request = ++captureRequest.current;
    if (
      !(await finishCapture(true)) ||
      request !== captureRequest.current ||
      !mounted.current
    )
      return;
    if (document.activeElement?.id !== `shortcut-${name}`) return;
    const current = {
      name,
      token: crypto.randomUUID(),
      phase: "preparing" as const,
      preview: "",
      candidate: null,
    };
    altGraphDown.current = false;
    updateCapture(current);
    setFeedback("");
    captureQueue.current = captureQueue.current.then(async () => {
      let ready = false;
      try {
        ready =
          (await performRef.current("begin_shortcut_recording", {
            token: current.token,
          })) !== false;
      } catch {
        /* Refuse capture unless native suspension was acknowledged. */
      }
      if (
        captureRef.current?.token === current.token &&
        captureRef.current.phase === "preparing"
      ) {
        if (ready) updateCapture({ ...current, phase: "ready" });
        else {
          if (mounted.current) setFeedback("暂时无法开始录入，请重试。");
          void finishRef.current(false);
        }
      }
      return true;
    });
  };
  const finishRef = useRef(finishCapture);
  finishRef.current = finishCapture;
  useEffect(() => {
    captureQueue.current = captureQueue.current.then(async () => {
      let restored = false;
      try {
        restored =
          (await performRef.current("end_shortcut_recording", {
            token: null,
          })) !== false;
      } catch {
        /* A remounted page can recover a lease whose old token was lost. */
      }
      if (!restored) {
        updateCapture({
          name: "input",
          token: null,
          phase: "failed",
          preview: "",
          candidate: null,
        });
        if (mounted.current) setFeedback("部分快捷键未恢复，请重试恢复。");
      }
      if (mounted.current) setRecovering(false);
      return restored;
    });
    const cancel = () => {
      captureRequest.current += 1;
      void finishRef.current(false);
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, []);
  useEffect(() => {
    if (!active) {
      captureRequest.current += 1;
      void finishRef.current(false);
    }
  }, [active]);
  const suspended =
    snapshot.recording || (!!capture && capture.phase !== "failed");
  return (
    <section className="shortcut-settings" aria-label="全局快捷键">
      <h2>全局快捷键</h2>
      <p id="shortcut-help">
        {snapshot.macos
          ? "点击输入框后按组合键，须包含 Command、Option 或 Control。"
          : "点击输入框后按组合键，须包含 Ctrl 或 Alt。"}
        支持 Shift、字母、数字、Space 和 F1–F24。Esc 取消，Tab
        移至下一项；保存后生效。
      </p>
      {fields
        .filter((_, index) => snapshot.ocr || index < 4)
        .map(([name, label], index) => (
          <div className="shortcut-row" key={name}>
            <label htmlFor={`shortcut-${name}`}>
              {label}
              {name === "selection" || name === "ocr"
                ? ` · ${display === "below" ? "原文下方" : "悬浮栏"}`
                : name.endsWith("Alternate")
                  ? ` · ${display === "below" ? "悬浮栏" : "原文下方"}`
                  : ""}
            </label>
            <div className="shortcut-edit">
              <input
                id={`shortcut-${name}`}
                aria-describedby={`shortcut-help${snapshot.macos ? ` shortcut-preview-${name}` : ""}`}
                maxLength={48}
                value={
                  capture?.name === name && capture.preview
                    ? capture.preview
                    : draft[name]
                }
                spellCheck={false}
                disabled={saving}
                readOnly
                onFocus={() => void startCapture(name)}
                onClick={() => void startCapture(name)}
                onBlur={() => {
                  captureRequest.current += 1;
                  void finishCapture(true);
                }}
                onKeyDown={(event) => {
                  const current = captureRef.current;
                  if (!current || current.name !== name) return;
                  if (event.key === "Tab") {
                    captureRequest.current += 1;
                    void finishCapture(true);
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    captureRequest.current += 1;
                    void finishCapture(false);
                    return;
                  }
                  if (
                    current.phase !== "ready" ||
                    event.repeat ||
                    isImeKey(event.nativeEvent)
                  )
                    return;
                  // Windows layouts may report the AltGraph state for Ctrl+Alt;
                  // require the actual AltGraph/right-Alt press before rejecting it.
                  if (
                    event.key === "AltGraph" ||
                    (!snapshot.macos &&
                      event.code === "AltRight" &&
                      event.getModifierState("AltGraph"))
                  )
                    altGraphDown.current = true;
                  if (altGraphDown.current) {
                    setFeedback(
                      "不支持 AltGraph，请使用 Ctrl、Alt 或平台修饰键组合。",
                    );
                    updateCapture({ ...current, preview: "", candidate: null });
                    return;
                  }
                  const result = capturedShortcut(
                    event.nativeEvent,
                    snapshot.macos,
                  );
                  setFeedback(
                    result.value ||
                      ["Control", "Alt", "Shift", "Meta", "OS"].includes(
                        event.key,
                      )
                      ? ""
                      : snapshot.macos
                        ? "请组合 Command、Option 或 Control 与字母、数字、Space 或 F1–F24。"
                        : "请组合 Ctrl 或 Alt 与字母、数字、Space 或 F1–F24。",
                  );
                  updateCapture({
                    ...current,
                    preview: result.preview,
                    candidate: result.value,
                  });
                }}
                onKeyUp={(event) => {
                  if (event.key === "AltGraph" || event.code === "AltRight")
                    altGraphDown.current = false;
                  const current = captureRef.current;
                  if (
                    !current ||
                    current.name !== name ||
                    current.phase !== "ready"
                  )
                    return;
                  if (
                    current.candidate &&
                    !(
                      event.ctrlKey ||
                      event.altKey ||
                      event.shiftKey ||
                      event.metaKey
                    )
                  ) {
                    void finishCapture(true);
                  } else if (!current.candidate) {
                    updateCapture({
                      ...current,
                      preview: capturedShortcut(
                        event.nativeEvent,
                        snapshot.macos,
                      ).preview,
                    });
                  }
                }}
              />
              {snapshot.macos && (
                <output
                  id={`shortcut-preview-${name}`}
                  className="shortcut-preview"
                >
                  {formatShortcut(draft[name], true)}
                </output>
              )}
            </div>
            <span
              className={
                suspended
                  ? ""
                  : snapshot.registered[index]
                    ? "shortcut-ready"
                    : "shortcut-unavailable"
              }
            >
              {suspended
                ? "录入期间暂停"
                : draft[name] !== saved[name]
                  ? "待保存"
                  : saved[name] !==
                      editableShortcut(snapshot.bindings[name], snapshot.macos)
                    ? "已保存"
                    : snapshot.registered[index]
                      ? "已启用"
                      : "未启用"}
            </span>
          </div>
        ))}
      <div className="shortcut-buttons">
        <button
          disabled={saving || recovering || !!capture}
          onClick={() => {
            edit(editableBindings(defaultShortcuts, snapshot.macos));
          }}
        >
          恢复默认
        </button>
        <button
          disabled={
            saving ||
            recovering ||
            !!capture ||
            (!dirty && snapshot.registered.every(Boolean))
          }
          onClick={async () => {
            if (inFlight.current || recovering || captureRef.current) return;
            inFlight.current = true;
            const submitted = { ...draftRef.current };
            const version = editVersion.current;
            // A preceding acknowledged save may not have reached the polling snapshot yet.
            const revision = Math.max(
              latestSnapshot.current.revision,
              awaitingSnapshot.current
                ? awaitingSnapshot.current.revision + 1
                : 0,
            );
            setSaving(true);
            setFeedback("");
            try {
              const result = await perform("save_shortcuts", {
                bindings: submitted,
              });
              if (!mounted.current) return;
              if (result === false) {
                if (version === editVersion.current)
                  setFeedback("保存失败，草稿已保留，原快捷键继续生效。");
                return;
              }
              const latest = latestSnapshot.current;
              const confirmed = latest.revision > revision;
              const next = confirmed
                ? editableBindings(latest.bindings, latest.macos)
                : submitted;
              awaitingSnapshot.current = confirmed
                ? null
                : { revision, editVersion: version };
              savedRef.current = next;
              setSaved(next);
              if (version === editVersion.current) {
                draftRef.current = next;
                setDraft(next);
                setFeedback(
                  confirmed
                    ? latest.message || "快捷键已保存。"
                    : "快捷键已保存。",
                );
              }
            } catch (reason) {
              if (mounted.current && version === editVersion.current)
                setFeedback(
                  `${errorMessage(reason, latestSnapshot.current.macos)} 草稿已保留。`,
                );
            } finally {
              inFlight.current = false;
              if (mounted.current) setSaving(false);
            }
          }}
        >
          {saving ? "正在保存…" : "保存快捷键"}
        </button>
      </div>
      {capture?.phase === "failed" && (
        <button onClick={() => void finishCapture(false)}>
          重试恢复快捷键
        </button>
      )}
      <p role="status" className="shortcut-status">
        {(capture && capture.phase !== "failed"
          ? capture.phase === "preparing"
            ? "正在准备录入…"
            : capture.phase === "restoring"
              ? "正在恢复快捷键…"
              : feedback || "请按组合键，松开后完成；Esc 取消。"
          : "") ||
          notice ||
          feedback ||
          (dirty
            ? "修改尚未保存，原快捷键继续生效。"
            : snapshot.message || "修改后保存，即时生效并在重启后保留。")}
      </p>
      {!suspended && snapshot.registered.includes(false) && (
        <p className="shortcut-warning">
          未启用的组合可能被其他应用占用或由系统保留，请更换后保存。仍可使用边缘入口或托盘。
        </p>
      )}
    </section>
  );
}
