import { invoke } from "@tauri-apps/api/core";
export interface Settings {
  target: string;
  pinned: boolean;
  translationDisplay: "panel" | "below";
  autoSelectionTranslation: boolean;
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
export interface SessionTurn {
  id: string;
  question: string;
  output: string;
  thinkingOutput: string;
  toolCalls: View["toolCalls"];
}
export type LoadActivity = (
  id: string,
  signal: AbortSignal,
) => Promise<{ turns: SessionTurn[] }>;
export async function loadActivity(
  id: string,
  signal: AbortSignal,
  invoke: typeof call = call,
): Promise<{ turns: SessionTurn[] }> {
  let offset = 0;
  let version: string | undefined;
  const chunks: string[] = [];
  for (;;) {
    signal.throwIfAborted();
    const page = await invoke<{
      chunk: string;
      next: number | null;
      version: string;
    }>("session_request", {
      request: { action: "activity", id, offset, version: version ?? null },
    });
    signal.throwIfAborted();
    if (
      typeof page.chunk !== "string" ||
      !page.version ||
      (version && version !== page.version) ||
      (page.next !== null &&
        (!page.chunk.length || page.next !== offset + page.chunk.length))
    )
      throw new Error("invalid_activity_page");
    version = page.version;
    chunks.push(page.chunk);
    if (page.next === null) break;
    offset = page.next;
  }
  return JSON.parse(chunks.join(""));
}
export type LoadSessions = (
  offset?: number,
  query?: string,
  snapshot?: string,
) => Promise<{ sessions: SessionInfo[]; total: number; snapshot?: string }>;
export const loadSessions: LoadSessions = (offset = 0, query = "", snapshot) =>
  call("session_request", {
    request: { action: "list", offset, query, snapshot },
  });
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
  settings: {
    target: "简体中文",
    pinned: true,
    translationDisplay: "below",
    autoSelectionTranslation: false,
  },
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
    external_url_invalid: "仅支持不含登录凭证的 HTTP 或 HTTPS 链接。",
    browser_open_failed: "无法打开浏览器，请复制链接后重试。",
    auto_selection_unavailable:
      "自动划词监听不可用。请关闭后重新开启，仍失败时重启应用；原有划词快捷键仍可使用。",
    selection_unsupported: "此应用暂不支持读取选区，可复制后翻译。",
    accessibility_permission_required: macos
      ? "请在系统设置 → 隐私与安全性 → 设备控制和数据访问（旧版称辅助功能）中允许系统提示的应用；从终端启动时需允许对应终端（如 Warp），安装版允许 LingoSofa。授权后重新打开应用；也可复制后翻译。"
      : "请在系统设置 → 隐私与安全性 → 辅助功能中允许 LingoSofa 读取选区；也可复制后翻译。",
    selection_empty: "没有选中文字，请先选中一段内容。",
    selection_unavailable: "未能定位选区，可复制后翻译。",
    selection_timeout: "取文超时，已停止辅助进程，可复制后翻译。",
    selection_helper_unavailable: "取文服务不可用，请重新启动应用。",
    ask_context_too_long: "原文较长，请先分段翻译，再围绕它提问。",
    account_required: "请先在模型与服务商中配置所选服务商的 API Key。",
    provider_unsupported: "该服务商暂不支持 API Key 配置。",
    auth: "账户认证失败，请检查凭证。",
    rate_limit: "请求过于频繁，请稍后重试。",
    context_limit: "上下文过长，请缩短文本或新建会话。",
    network: "网络连接失败，请检查网络后重试。",
    model_unavailable: "模型不可用，请切换模型。",
    history_changed: "会话列表已过期，请重新加载。",
    model_not_verified: "所选模型不可用，请刷新模型列表后重试。",
    invalid_model: "请选择有效模型。",
    update_task_active: "请等待当前翻译或 Ask 任务结束后安装更新。",
    settings_write_failed: "设置保存失败，原配置继续生效。",
    service_timeout: "模型服务响应超时，请重试。",
    service_busy: "操作较多，请稍后再试。",
    text_too_long:
      "文本或问题过长，请缩短或分段提交（最多 15000 UTF-8 字节，约 5000 个汉字）。",
    invalid_text: "请输入文本或问题。",
    clipboard_unavailable: "没有读到剪贴板文本，请先复制。",
    clipboard_write_failed: "复制失败，请稍后重试。",
    clipboard_text_too_long: "内容超过单次复制上限（4 MiB），请分段选择复制。",
    clipboard_text_invalid: "内容包含剪贴板不支持的空字符，请分段选择复制。",
    keychain_read_failed:
      "当前无法访问钥匙串凭证；本次启动不再重复请求，重新打开应用后可再次授权。",
    keychain_open_failed:
      "当前无法打开钥匙串，请解锁系统登录钥匙串后重新打开应用。",
    keychain_write_failed: "无法保存钥匙串凭证，请确认系统授权后重新打开应用。",
    ocr_review_ready: "已在本机识别，请校对后翻译或提问。",
    ocr_unsupported: "截图识别需要 Windows 或 macOS。",
    ocr_os_unsupported: "本机截图识别需要 macOS 11 或更新版本。",
    ocr_screen_permission_required:
      "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 LingoSofa，按系统提示重新打开应用后重试。",
    ocr_busy: "截图识别正在进行，请完成框选或按 Esc 取消。",
    ocr_capture_failed: "截图失败，请重新框选；受保护的画面可能无法截取。",
    ocr_failed: "本机文字识别失败，请重新框选清晰的文字。",
    ocr_resource_invalid:
      "本地 OCR 资源缺失或校验失败，请重新安装完整应用；不会改用其他引擎或联网下载。",
    ocr_runtime_unavailable:
      "本地 OCR 运行库无法载入。请安装 Microsoft Visual C++ 2015–2022 x64 运行库后重试。",
    ocr_model_invalid: "本地 OCR 模型与识别程序不匹配，请重新安装完整应用。",
    ocr_cross_screen: "请在同一屏幕内完成框选；跨屏区域不支持。",
    ocr_empty: "没有识别到文字，请重新框选更清晰的区域。",
    ocr_timeout: "截图或文字识别已超时，请重试或缩小区域。",
    ocr_image_too_large: macos
      ? "截图区域过大，请缩小到 1600 万像素以内。"
      : "OCR 区域或文字行过大。请缩小范围：最多 400 万像素、最长边 4096 像素；过长单行请分段识别。",
    ocr_text_too_long: "识别文字过长，请缩小区域后分段识别。",
    shortcut_duplicate: "快捷键不能重复；请为每个操作选择不同组合。",
    shortcuts_storage_failed:
      "快捷键保存失败，原设置继续生效。请检查本地数据目录后重试。",
  };
  const conflict = /^shortcut_conflict_([0-5])$/.exec(code);
  const invalid = /^shortcut_invalid_([0-5])$/.exec(code);
  const names = [
    "唤出输入面板",
    "翻译当前选区",
    "翻译剪贴板",
    "划词翻译另一种样式",
    "截图 OCR",
    "截图 OCR 另一种样式",
  ];
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

// Input, translation and followups share the native UTF-8 budget.
export const MAX_TEXT_BYTES = 15_000;
export function textInputError(text: string): string | null {
  if (!text.trim()) return "invalid_text";
  return new TextEncoder().encode(text).length > MAX_TEXT_BYTES
    ? "text_too_long"
    : null;
}

export type Mode =
  | "idle"
  | "menu"
  | "translation"
  | "translation-detail"
  | "ask"
  | "ask-result"
  | "input"
  | "settings";
export interface ReadingContext {
  text: string;
  origin: string;
  kind: "selection" | "clipboard" | "input" | "ocr";
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
  selectionAlternate: string;
  ocr: string;
  ocrAlternate: string;
}
export interface ShortcutSnapshot {
  macos: boolean;
  ocr: boolean;
  bindings: ShortcutBindings;
  registered: boolean[];
  revision: number;
  message: string;
}
export const defaultShortcuts: ShortcutBindings = {
  input: "Alt+Shift+Space",
  selection: "Alt+Shift+S",
  clipboard: "Alt+Shift+T",
  selectionAlternate: "Ctrl+Alt+Shift+S",
  ocr: "Alt+Shift+O",
  ocrAlternate: "Ctrl+Alt+Shift+O",
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
    ocr: false,
    bindings: defaultShortcuts,
    registered: [false, false, false, false],
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
      : context.kind === "ocr"
        ? "截图识别"
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
