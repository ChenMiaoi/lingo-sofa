import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { call, errorMessage, initialState, type DesktopState } from "./api";
import { Desktop } from "./view";
import "./style.css";
function App() {
  const [state, setState] = useState<DesktopState>(initialState);
  const [notice, setNotice] = useState("");
  const perform = async (command: string, args?: Record<string, unknown>) => {
    setNotice("");
    try {
      await call(command, args);
      return true;
    } catch (e) {
      setNotice(errorMessage(e, state.shortcuts.macos));
      return false;
    }
  };
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await call<DesktopState>("desktop_state");
        if (!disposed) setState(next);
      } catch {
        if (!disposed) setNotice("请在 LingoSofa 桌面应用中打开。");
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
  }, []);
  return <Desktop state={state} notice={notice} perform={perform} />;
}
createRoot(document.getElementById("root")!).render(<App />);
