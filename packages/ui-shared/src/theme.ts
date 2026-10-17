/** One palette for every LingoSofa surface; host adapters only map aliases. */
const palettes = {
  light: {
    canvas: "#fafafa",
    surface: "#ffffff",
    subtle: "#f0f1f3",
    border: "#e3e4e8",
    text: "#24262b",
    muted: "#737780",
    accent: "#286856",
    tint: "#eaf3ee",
    "on-accent": "#ffffff",
    error: "#b33e40",
    "toggle-knob": "#ffffff",
  },
  dark: {
    canvas: "#1e1f22",
    surface: "#27282d",
    subtle: "#303137",
    border: "#3b3d44",
    text: "#eeeff2",
    muted: "#a0a3ad",
    accent: "#a6d9bf",
    tint: "#2b3b34",
    "on-accent": "#25262b",
    error: "#ffb4b8",
    "toggle-knob": "#ffffff",
  },
} as const;
export type ColorTheme = "system" | "light" | "dark";

export function themeDeclarations(theme: "light" | "dark") {
  return (
    Object.entries(palettes[theme])
      .map(([key, value]) => `--ls-${key}:${value}`)
      .join(";") + `;color-scheme:${theme};`
  );
}

/** Scoped to product surfaces, including Shadow DOM and Discord host themes. */
export function themeStyles(selector: string) {
  const root = selector.includes(",") ? `:is(${selector})` : selector;
  const rule = (theme: "light" | "dark") => {
    const own =
      root === ":host"
        ? `:host([data-theme=${theme}])`
        : `${root}[data-theme=${theme}]`;
    const ancestor =
      root === ":host"
        ? ""
        : `:is([data-theme=${theme}],.theme-${theme}) ${root},`;
    return `${ancestor}${own}{${themeDeclarations(theme)}}`;
  };
  return `${root}{${themeDeclarations("light")}}
@media(prefers-color-scheme:dark){${root}{${themeDeclarations("dark")}}}
${rule("light")}
${rule("dark")}`;
}

export const themeAliases = `
--canvas:var(--ls-canvas);--bg:var(--ls-surface);--surface:var(--ls-surface);--soft:var(--ls-subtle);--ink:var(--ls-text);--muted:var(--ls-muted);--line:var(--ls-border);--accent:var(--ls-accent);--accent-hover:var(--ls-text);--on-accent:var(--ls-on-accent);--error:var(--ls-error);
--lingo-text:var(--ls-text);--lingo-surface:var(--ls-surface);--lingo-border:var(--ls-border);
`;
