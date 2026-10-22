import React, { useEffect, useState } from "react";
import {
  call,
  errorMessage,
  initialState,
  textInputError,
  type DesktopState,
} from "./api";
import { Desktop } from "./view";

interface Notice {
  message: string;
  epoch: number;
  revision: number;
}
function scopedNotice(message: string, state: DesktopState): Notice {
  return {
    message,
    epoch: state.desktop.epoch,
    revision: state.desktop.modelRevision,
  };
}
export function App({ invoke = call }: { invoke?: typeof call }) {
  const [state, setState] = useState<DesktopState>(initialState);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const perform = async (command: string, args?: Record<string, unknown>) => {
    setNotice(null);
    const origin = state;
    try {
      const text =
        command === "ask_question"
          ? args?.question
          : command === "translate_text" || command === "ask_text"
            ? args?.text
            : undefined;
      if (typeof text === "string") {
        const error = textInputError(text);
        if (error) throw error;
      }
      await invoke(command, args);
      return true;
    } catch (error) {
      setNotice(
        scopedNotice(errorMessage(error, origin.shortcuts.macos), origin),
      );
      return false;
    }
  };
  useEffect(() => {
    let disposed = false;
    void invoke("session_request", { request: { action: "restore" } }).catch(
      (error) => {
        if (!disposed)
          setNotice(scopedNotice(errorMessage(error), initialState));
      },
    );
    return () => {
      disposed = true;
    };
  }, [invoke]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await invoke<DesktopState>("desktop_state");
        if (!disposed) {
          setState(next);
          setDisconnected(false);
        }
      } catch {
        if (!disposed) setDisconnected(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 120);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [invoke]);
  // Global shortcuts can start a new task without going through perform().
  // A failure from an earlier view or startup restore must not mask its result.
  const currentNotice =
    notice?.epoch === state.desktop.epoch &&
    notice.revision === state.desktop.modelRevision
      ? notice.message
      : "";
  return (
    <Desktop
      state={state}
      notice={disconnected ? "请在 LingoSofa 桌面应用中打开。" : currentNotice}
      perform={perform}
    />
  );
}
