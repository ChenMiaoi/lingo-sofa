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
