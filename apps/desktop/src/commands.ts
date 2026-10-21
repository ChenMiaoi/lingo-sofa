import type { ModelSelection, Settings } from "./api";
import type { SettingsPage } from "./settings";

export const slashCommands = [
  {
    command: "/settings",
    label: "打开设置",
    detail: "/settings [models|preferences|shortcuts]",
  },
  {
    command: "/model",
    label: "选择默认模型",
    detail: "/model [搜索词或服务商/模型 ID]",
  },
  {
    command: "/language",
    label: "修改翻译语言",
    detail: "/language [简体中文|English|日本語|한국어]",
  },
  { command: "/pin", label: "修改窗口置顶", detail: "/pin [on|off]" },
  { command: "/shortcuts", label: "打开快捷键设置", detail: "/shortcuts" },
  { command: "/new", label: "新建会话", detail: "/new" },
  { command: "/help", label: "查看应用命令", detail: "/help" },
] as const;
export type ParsedCommand =
  | { kind: "settings"; page: SettingsPage }
  | { kind: "model_picker"; search: string }
  | { kind: "new" }
  | { kind: "model"; model: ModelSelection }
  | { kind: "preferences"; patch: Partial<Settings> }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export function isCommandInput(text: string): boolean {
  return /^\/(?!\/)/.test(text.trimStart());
}
export function commandSuggestions(text: string) {
  const name = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return slashCommands.filter((entry) => entry.command.startsWith(name));
}
export function unescapeCommandText(text: string) {
  return text.replace(/^(\s*)\/\//, "$1/");
}
export function parseCommand(text: string): ParsedCommand | null {
  if (!isCommandInput(text)) return null;
  const [name, ...args] = text.trim().split(/\s+/);
  const invalid = (usage: string): ParsedCommand => ({
    kind: "invalid",
    message: `命令格式：${usage}`,
  });
  if (/[\r\n]/.test(text.trim()))
    return invalid("请单独输入一行命令；以 // 开头可提交斜杠正文。");
  switch (name?.toLowerCase()) {
    case "/settings": {
      const page = args[0] ?? "home";
      if (
        args.length > 1 ||
        !["home", "models", "preferences", "shortcuts"].includes(page)
      )
        return invalid("/settings [models|preferences|shortcuts]");
      return { kind: "settings", page: page as SettingsPage };
    }
    case "/model": {
      if (!args.length || !args.join(" ").includes("/"))
        return { kind: "model_picker", search: args.join(" ") };
      const selector = args[0] ?? "";
      const slash = selector.indexOf("/");
      const provider = selector.slice(0, slash);
      const modelId = selector.slice(slash + 1);
      if (
        args.length !== 1 ||
        slash < 1 ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(provider) ||
        !modelId ||
        modelId.length > 512 ||
        Array.from(modelId).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return invalid(
          "/model 服务商/模型ID，例如 /model deepseek/deepseek-flash",
        );
      return { kind: "model", model: { provider, modelId } };
    }
    case "/language": {
      if (!args.length) return { kind: "settings", page: "preferences" };
      const aliases: Record<string, string> = {
        zh: "简体中文",
        en: "English",
        ja: "日本語",
        ko: "한국어",
        english: "English",
        简体中文: "简体中文",
        日本語: "日本語",
        한국어: "한국어",
      };
      const target = aliases[args[0]!.toLowerCase()];
      if (args.length !== 1 || typeof target !== "string")
        return invalid(
          "/language 简体中文|English|日本語|한국어（或 zh/en/ja/ko）",
        );
      return { kind: "preferences", patch: { target } };
    }
    case "/pin":
      if (!args.length) return { kind: "settings", page: "preferences" };
      if (args.length !== 1 || !["on", "off"].includes(args[0]!))
        return invalid("/pin on|off");
      return { kind: "preferences", patch: { pinned: args[0] === "on" } };
    case "/shortcuts":
      return args.length
        ? invalid("/shortcuts")
        : { kind: "settings", page: "shortcuts" };
    case "/new":
      return args.length ? invalid("/new") : { kind: "new" };
    case "/help":
      return args.length ? invalid("/help") : { kind: "help" };
    default:
      return {
        kind: "invalid",
        message: "未找到应用命令。输入 / 查看命令；以 // 开头可提交斜杠正文。",
      };
  }
}
