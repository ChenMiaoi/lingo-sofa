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
  question: string;
  keyConfigured: boolean;
  defaultModel: ModelSelection;
  configuredProviders: string[];
  sessionReady: boolean;
  taskId: number | null;
  queued: number;
  activeCalls: number;
  reportedTokens: number;
  unknownCalls: number;
  settings: Settings;
  sessionId: string | null;
  messages: { role: string; content: string; truncated: boolean }[];
  messageCount: number;
  thinking: string;
  toolsEnabled: boolean;
  thinkingOutput: string;
  toolCalls: {
    type: string;
    id: string;
    name: string;
    text: string;
    isError?: boolean;
  }[];
  toolApprovals: { id: string; name: string; args: string; cwd: string }[];
  estimatedCost: number;
  unpricedCalls: number;
  sessionStats: {
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    toolCalls: number;
  } | null;
  sessionEstimatedCost: number;
  sessionUnpricedCalls: number;
}
export interface SessionInfo {
  id: string;
  title: string;
  modified: string;
  messageCount: number;
}
export type LoadSessions = (
  offset?: number,
) => Promise<{ sessions: SessionInfo[]; total: number }>;
export const loadSessions: LoadSessions = (offset = 0) =>
  call("session_request", { request: { action: "list", offset } });
export const initialView: View = {
  revision: 0,
  phase: "ready",
  message: "复制一段文字，开始翻译。",
  output: "",
  question: "",
  keyConfigured: false,
  defaultModel: { provider: "deepseek", modelId: "deepseek-flash" },
  configuredProviders: [],
  sessionReady: false,
  taskId: null,
  queued: 0,
  activeCalls: 0,
  reportedTokens: 0,
  unknownCalls: 0,
  settings: { target: "简体中文", pinned: true },
  sessionId: null,
  messages: [],
  messageCount: 0,
  thinking: "off",
  toolsEnabled: false,
  thinkingOutput: "",
  toolCalls: [],
  toolApprovals: [],
  estimatedCost: 0,
  unpricedCalls: 0,
  sessionStats: null,
  sessionEstimatedCost: 0,
  sessionUnpricedCalls: 0,
};
export function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}
export function errorMessage(error: unknown, macos = false): string {
  const code = String(error);
  const messages: Record<string, string> = {
    selection_unsupported: "此应用暂不支持读取选区，可复制后翻译。",
    accessibility_permission_required:
      "请在系统设置 → 隐私与安全性 → 辅助功能中允许 LingoSofa 读取选区；也可复制后翻译。",
    selection_empty: "没有选中文字，请先选中一段内容。",
    selection_unavailable: "未能定位选区，可复制后翻译。",
    selection_timeout: "取文超时，已停止辅助进程，可复制后翻译。",
    selection_helper_unavailable: "取文服务不可用，请重新启动应用。",
    ask_context_too_long: "原文较长，请先分段翻译，再围绕它提问。",
    account_required: "请先在模型与服务商中配置所选服务商的 API Key。",
    provider_unsupported: "该服务商暂不支持 API Key 配置。",
    model_not_verified: "所选模型不可用，请刷新模型列表后重试。",
    invalid_model: "请选择有效模型。",
    update_task_active: "请等待当前翻译或 Ask 任务结束后安装更新。",
    settings_write_failed: "设置保存失败，原配置继续生效。",
    service_timeout: "模型服务响应超时，请重试。",
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
    return `${names[Number(invalid[1])]}的组合无效，请使用 ${macos ? "Command、Option 或 Control" : "Ctrl 或 Alt"} 搭配字母、数字、Space 或 F1–F24。`;
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
export interface UpdateSnapshot {
  currentVersion: string;
  autoCheck: boolean;
  phase:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "up-to-date"
    | "no-release"
    | "error";
  availableVersion: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  lastChecked: number | null;
  error: string | null;
}
export interface DesktopState {
  updates: UpdateSnapshot;
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
  macos: boolean;
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
  updates: {
    currentVersion: "",
    autoCheck: true,
    phase: "idle",
    availableVersion: null,
    notes: null,
    downloaded: 0,
    total: null,
    lastChecked: null,
    error: null,
  },
  shortcuts: {
    macos: false,
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

export interface ModelSelection {
  provider: string;
  modelId: string;
}
export interface ProviderInfo {
  apiKey?: boolean;
  login?: string;
  loginMethod?: string;
  id: string;
  name: string;
  supported: boolean;
  modelCount: number;
}
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
}
export interface ModelCatalog {
  providers: ProviderInfo[];
  supported?: boolean;
  models: ModelInfo[];
  total: number;
}

export function loadModelCatalog(
  provider?: string,
  offset = 0,
): Promise<ModelCatalog> {
  return call("model_catalog", { provider: provider ?? null, offset });
}

export interface LoginProvider {
  method?: string;
  modelsSupported?: boolean;
  id: string;
  name: string;
  provider: string;
}
export interface LoginState {
  attempt: string;
  provider: string;
  phase: "waiting" | "prompt" | "complete" | "error" | "cancelled";
  url?: string;
  instructions?: string;
  prompt?: {
    id: number;
    message: string;
    secret: boolean;
    allowEmpty: boolean;
    browser?: { url: string; cookieNames: readonly string[] };
  };
}
export type LoginRequest =
  | { action: "providers" }
  | { action: "start"; provider: string }
  | { action: "status" | "cancel"; attempt: string }
  | { action: "input"; attempt: string; prompt: number; value: string };
export type RequestLogin = (
  request: LoginRequest,
) => Promise<{ providers?: LoginProvider[] } & Partial<LoginState>>;
export const subscriptionLogin: RequestLogin = (request) =>
  call("subscription_login", { request });
