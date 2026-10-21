import { invoke } from "@tauri-apps/api/core";
export interface Settings {
  target: string;
  pinned: boolean;
}
export interface View {
  revision: number;
  phase: string;
  message: string;
  output: string;
  keyConfigured: boolean;
  sessionReady: boolean;
  taskId: number | null;
  queued: number;
  activeCalls: number;
  reportedTokens: number;
  unknownCalls: number;
  settings: Settings;
}
export const initialView: View = {
  revision: 0,
  phase: "ready",
  message: "复制一段文字，开始翻译。",
  output: "",
  keyConfigured: false,
  sessionReady: false,
  taskId: null,
  queued: 0,
  activeCalls: 0,
  reportedTokens: 0,
  unknownCalls: 0,
  settings: { target: "简体中文", pinned: true },
};
export function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}
export function errorMessage(error: unknown): string {
  const code = String(error);
  const messages: Record<string, string> = {
    selection_unsupported: "此应用暂不支持读取选区，可复制后翻译。",
    selection_empty: "没有选中文字，请先选中一段内容。",
    selection_unavailable: "未能定位选区，可复制后翻译。",
    selection_timeout: "取文超时，已停止辅助进程，可复制后翻译。",
    selection_helper_unavailable: "取文服务不可用，请重新启动应用。",
    ask_context_too_long: "原文较长，请先分段翻译，再围绕它提问。",
    account_required: "请先设置 DeepSeek API Key。",
    service_busy: "操作较多，请稍后再试。",
    text_too_long: "文本过长，请分段翻译。",
    invalid_text: "请输入需要翻译的文本。",
    clipboard_unavailable: "没有读到剪贴板文本，请先复制。",
    shortcut_duplicate: "三项快捷键不能重复；请为每个操作选择不同组合。",
    shortcuts_storage_failed:
      "快捷键保存失败，原设置继续生效。请检查本地数据目录后重试。",
  };
  const conflict = /^shortcut_conflict_([012])$/.exec(code);
  const invalid = /^shortcut_invalid_([012])$/.exec(code);
  const names = ["唤出输入面板", "翻译当前选区", "翻译剪贴板"];
  if (conflict)
    return `${names[Number(conflict[1])]}的快捷键无法注册，可能已被占用或由系统保留。请更换组合；原设置继续生效。`;
  if (invalid)
    return `${names[Number(invalid[1])]}的组合无效，请使用 Ctrl 或 Alt 搭配字母、数字、Space 或 F1–F24。`;
  return messages[code] ?? "暂时无法完成操作，请稍后重试。";
}

export function isImeKey(event: { isComposing: boolean; keyCode?: number }) {
  // IME confirmation may expose a processing key after isComposing becomes false.
  return event.isComposing || event.keyCode === 229;
}
export function shouldSubmitQuestion(
  event: { key: string; isComposing: boolean; keyCode?: number },
  busy: boolean,
  text: string,
): boolean {
  return (
    event.key === "Enter" && !isImeKey(event) && !busy && text.trim().length > 0
  );
}

export type Mode =
  "idle" | "menu" | "translation" | "ask" | "ask-result" | "input" | "settings";
export interface ReadingContext {
  text: string;
  origin: string;
  kind: "selection" | "clipboard" | "input";
  anchor: { x: number; y: number; width: number; height: number } | null;
  anchorValid: boolean;
}
export interface DesktopState {
  shortcuts: ShortcutSnapshot;
  desktop: {
    mode: Mode;
    context: ReadingContext | null;
    translation: string;
    notice: string;
    epoch: number;
    modelRevision: number;
    operation: string;
  };
  model: View;
}
export interface ShortcutBindings {
  input: string;
  selection: string;
  clipboard: string;
}
export interface ShortcutSnapshot {
  bindings: ShortcutBindings;
  registered: [boolean, boolean, boolean];
  revision: number;
  message: string;
}
export const defaultShortcuts: ShortcutBindings = {
  input: "Alt+Shift+Space",
  selection: "Alt+Shift+S",
  clipboard: "Alt+Shift+T",
};
export const initialState: DesktopState = {
  shortcuts: {
    bindings: defaultShortcuts,
    registered: [false, false, false],
    revision: 0,
    message: "",
  },
  desktop: {
    mode: "idle",
    context: null,
    translation: "",
    notice: "",
    epoch: 0,
    modelRevision: 0,
    operation: "translate",
  },
  model: initialView,
};
export const actions = [
  {
    id: "explain",
    label: "解释这段内容",
    detail: "提炼意思与关键表达",
    tag: "理解",
    icon: "chat",
    keywords: "解释 explain 理解",
    question: "请解释这段原文的意思与关键表达。",
  },
  {
    id: "translate",
    label: "翻译成中文",
    detail: "自动识别语言 · 保留原意",
    tag: "翻译",
    icon: "translate",
    keywords: "翻译 translate 中文",
    question: "请将这段原文翻译成简体中文，仅返回译文。",
  },
  {
    id: "polish",
    label: "润色这段英文",
    detail: "让表达更自然、更简洁",
    tag: "改写",
    icon: "pen",
    keywords: "润色 polish rewrite 改写 英文",
    question:
      "请润色这段原文，使表达更自然、简洁；保留事实和原意，仅返回修改后的文本。",
  },
] as const;
export function matchingActions(query: string) {
  const q = query.trim().toLowerCase();
  return actions.filter(
    (a) => !q || `${a.label} ${a.keywords}`.toLowerCase().includes(q),
  );
}
export function contextLabel(context: ReadingContext | null) {
  if (!context) return "独立提问";
  return context.kind === "selection"
    ? "已选文字"
    : context.kind === "clipboard"
      ? "剪贴板"
      : "输入文本";
}
