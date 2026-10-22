import { createHash } from "node:crypto";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { displayText } from "./session-history";

interface Turn {
  id: string;
  question: string;
  output: string;
  thinkingOutput: string;
  toolCalls: {
    type: string;
    id: string;
    name: string;
    text: string;
    isError?: boolean;
  }[];
}

/** Read the durable active branch, including messages before compaction. Never replay tools. */
export function sessionActivity(manager: Pick<SessionManager, "getBranch">) {
  const turns: Turn[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const question =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n");
      turns.push({
        id: entry.id,
        question,
        output: "",
        thinkingOutput: "",
        toolCalls: [],
      });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "thinking")
          turn.thinkingOutput +=
            (turn.thinkingOutput ? "\n\n" : "") + part.thinking;
        if (part.type === "text")
          turn.output += (turn.output ? "\n\n" : "") + part.text;
        if (part.type === "toolCall")
          turn.toolCalls.push({
            type: "tool_execution_start",
            id: part.id,
            name: part.name,
            text: JSON.stringify(part.arguments),
          });
      }
    } else if (message.role === "toolResult") {
      turn.toolCalls.push({
        type: "tool_execution_end",
        id: message.toolCallId,
        name: message.toolName,
        text: message.content
          .map((p) => (p.type === "text" ? p.text : "[非文本结果]"))
          .join("\n"),
        isError: message.isError,
      });
    }
  }
  return { turns };
}

export function activityChunk(
  manager: Pick<SessionManager, "getBranch">,
  offset: number,
  version?: string,
) {
  const serialized = JSON.stringify(sessionActivity(manager));
  const currentVersion = createHash("sha256").update(serialized).digest("hex");
  if (version !== undefined && version !== currentVersion)
    throw new Error("session_activity_changed");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length)
    throw new Error("invalid_page");
  const chunk = displayText(serialized.slice(offset), 24_000).text;
  const next = offset + chunk.length;
  return {
    chunk,
    version: currentVersion,
    next: next < serialized.length ? next : null,
  };
}
