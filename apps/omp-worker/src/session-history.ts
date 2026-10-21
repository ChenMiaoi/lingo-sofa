import { mkdir, readFile, rename, writeFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import type * as SDK from "@oh-my-pi/pi-coding-agent";

type Manager = SDK.SessionManager;
export interface SessionMetadata {
  provider: string;
  modelId: string;
  operation?: string;
  context?: unknown;
}

/** OMP owns the transcript; this file stores only the selected session ID. */
export class SessionHistory {
  readonly directory: string;
  private readonly pointer: string;
  private selection = Promise.resolve();
  constructor(
    private readonly sdk: typeof SDK,
    private readonly cwd: string,
  ) {
    this.directory = join(cwd, "sessions");
    this.pointer = join(this.directory, "current.json");
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  select(id: string | null) {
    const write = async () => {
      await this.init();
      const temporary = this.pointer + ".tmp";
      await writeFile(temporary, JSON.stringify({ id }), { mode: 0o600 });
      await rename(temporary, this.pointer);
    };
    const result = this.selection.then(write, write);
    this.selection = result.catch(() => undefined);
    return result;
  }
  async current(): Promise<string | null> {
    try {
      const value = JSON.parse(await readFile(this.pointer, "utf8"));
      return typeof value.id === "string" ? value.id : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("session_pointer_invalid", { cause: error });
    }
  }
  async list() {
    await this.init();
    return (await this.sdk.SessionManager.list(this.cwd, this.directory)).sort(
      (a, b) => b.modified.getTime() - a.modified.getTime(),
    );
  }
  async open(id: string) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error("invalid_session_id");
    const item = (await this.list()).find((entry) => entry.id === id);
    if (
      !item ||
      dirname(await realpath(item.path)) !== (await realpath(this.directory))
    )
      throw new Error("session_not_found");
    return this.sdk.SessionManager.open(item.path, this.directory, undefined, {
      initialCwd: this.cwd,
      throwIfMissing: true,
      suppressBreadcrumb: true,
    });
  }
  async create(metadata: SessionMetadata) {
    await this.init();
    const manager = this.sdk.SessionManager.create(this.cwd, this.directory);
    manager.appendCustomEntry("lingo-sofa", metadata);
    await manager.ensureOnDisk();
    await manager.flush();
    await this.select(manager.getSessionId());
    return manager;
  }
  metadata(manager: Manager): SessionMetadata {
    const entry = manager
      .getEntries()
      .slice()
      .reverse()
      .find(
        (entry) => entry.type === "custom" && entry.customType === "lingo-sofa",
      );
    if (
      !entry ||
      entry.type !== "custom" ||
      !entry.data ||
      typeof entry.data !== "object"
    )
      throw new Error("session_metadata_missing");
    const value = entry.data as SessionMetadata;
    if (
      typeof value.provider !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(value.provider) ||
      typeof value.modelId !== "string" ||
      !value.modelId.length ||
      value.modelId.length > 512 ||
      Array.from(value.modelId).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("session_metadata_invalid");
    return value;
  }
}

/** Budget JSON-encoded bytes, including control-character escaping. */
export function displayText(text: string, budget: number) {
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <= budget)
      low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return { text: text.slice(0, low), truncated: low < text.length };
}
export function displayMetadata(metadata: SessionMetadata) {
  const context = metadata.context as {
    text?: unknown;
    origin?: unknown;
    kind?: unknown;
  } | null;
  const base = {
    provider: metadata.provider,
    modelId: metadata.modelId,
    operation: metadata.operation === "translate" ? "translate" : "ask",
  };
  if (!context || typeof context.text !== "string")
    return { ...base, context: null };
  const source = displayText(context.text, 12_000);
  return {
    ...base,
    context: {
      text: source.text + (source.truncated ? "\n…（原文显示摘要已截断）" : ""),
      origin: displayText(String(context.origin ?? ""), 512).text,
      kind: ["selection", "clipboard", "input"].includes(String(context.kind))
        ? context.kind
        : "input",
      anchor: null,
      anchorValid: false,
    },
  };
}

export function sessionSnapshot(session: SDK.AgentSession) {
  // Bounded display projection only. OMP restores the complete model context.
  const messages = session.messages.slice(-16).map((message) => {
    if (!("content" in message))
      return { role: message.role, content: "", truncated: false };
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => {
              if (part.type === "text") return part.text;
              if (part.type === "thinking") return `[思考]\n${part.thinking}`;
              if (part.type === "toolCall")
                return `[工具 ${part.name}]\n${JSON.stringify(part.arguments)}`;
              return "";
            })
            .join("\n");
    const preview = displayText(content, 1500);
    return {
      role: message.role,
      content: preview.text,
      truncated: preview.truncated,
    };
  });
  const assistant = session.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");
  const output =
    assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const stats = session.getSessionStats();
  const preview = displayText(output, 8000);
  const user = session.messages
    .slice()
    .reverse()
    .find((message) => message.role === "user");
  const question = user
    ? typeof user.content === "string"
      ? user.content
      : user.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
    : "";
  const questionPreview = displayText(question, 8000);
  return {
    question:
      questionPreview.text +
      (questionPreview.truncated ? "\n…（提问显示已截断）" : ""),
    messages,
    output:
      preview.text +
      (preview.truncated
        ? "\n…（显示摘要已截断，完整内容保存在会话文件中）"
        : ""),
    messageCount: session.messages.length,
    stats: {
      tokens: stats.tokens,
      toolCalls: stats.toolCalls,
      cost: stats.cost,
    },
  };
}
