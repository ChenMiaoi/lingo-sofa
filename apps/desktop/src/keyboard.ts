const macModifiers: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  shift: "⇧",
  super: "⌘",
  command: "⌘",
  cmd: "⌘",
  meta: "⌘",
};

export function listIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index + count - 1) % count;
  if (key === "PageDown") return Math.min(index + 8, count - 1);
  if (key === "PageUp") return Math.max(index - 8, 0);
  return null;
}

export function formatShortcut(value: string, macos: boolean): string {
  if (!macos) return value;
  return value
    .split("+")
    .map((part) => {
      const key = part.trim().toLowerCase();
      return macModifiers[key] ?? (key === "enter" ? "↩" : part.trim());
    })
    .join("");
}

export function editableShortcut(value: string, macos: boolean): string {
  if (!macos) return value;
  return value
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "super":
          return "Command";
        case "alt":
          return "Option";
        default:
          return part;
      }
    })
    .join("+");
}

export function capturedShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
  macos: boolean,
): { preview: string; value: string | null } {
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? (macos ? "Option" : "Alt") : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? (macos ? "Command" : "Win") : "",
  ].filter(Boolean);
  const preview = modifiers.length ? `${modifiers.join("+")}+…` : "";
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key))
    return { preview, value: null };
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
  const key = physical
    ? physical[1] || physical[2]
    : event.code === "Space" || event.key === " "
      ? "Space"
      : /^(?:F[1-9]|F1[0-9]|F2[0-4])$/.test(event.key)
        ? event.key
        : /^[a-z0-9]$/i.test(event.key)
          ? event.key.toUpperCase()
          : "";
  if (
    !key ||
    (!macos && event.metaKey) ||
    !(event.ctrlKey || event.altKey || (macos && event.metaKey))
  )
    return { preview, value: null };
  return {
    preview: [...modifiers, key].join("+"),
    value: [...modifiers, key].join("+"),
  };
}
