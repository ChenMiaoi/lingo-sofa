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
