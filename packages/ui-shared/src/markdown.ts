import { Marked } from "marked";

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (value) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[value]!,
  );
}

// Model output is untrusted. Only the parser's generated formatting is HTML;
// source HTML stays text, links have an explicit protocol allowlist, and images
// stay labels rather than causing unsolicited network requests.
const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return label;
      }
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return label;
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
    checkbox({ checked }) {
      return checked ? "☑ " : "☐ ";
    },
    paragraph({ tokens }) {
      return `<span style="display:block;margin:0.35em 0;color:inherit;font:inherit">${this.parser.parseInline(tokens)}</span>`;
    },
    heading({ tokens }) {
      return `<span style="display:block;margin:0.35em 0"><strong>${this.parser.parseInline(tokens)}</strong></span>`;
    },
  },
});

const styles: Record<string, string> = {
  ul: "margin:0.35em 0;padding-inline-start:1.5em;list-style-type:disc",
  ol: "margin:0.35em 0;padding-inline-start:1.5em;list-style-type:decimal",
  li: "display:list-item;margin:0.15em 0;list-style-type:inherit",
  strong: "font-weight:700",
  em: "font-style:italic",
  del: "text-decoration:line-through",
  blockquote:
    "margin:0.35em 0;padding-inline-start:0.7em;border-inline-start:2px solid currentColor",
  pre: "margin:0.35em 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:0.9em",
  code: "font-family:ui-monospace,monospace;white-space:pre-wrap",
  table: "border-collapse:collapse;font:inherit",
  th: "padding:0.25em 0.5em;border:1px solid currentColor",
  td: "padding:0.25em 0.5em;border:1px solid currentColor",
};

export function renderTranslationMarkdown(text: string): string {
  const html = (markdown.parse(text) as string).trim();
  return html.replace(
    /<(ul|ol|li|strong|em|del|blockquote|pre|code|table|th|td)(?=[\s>])/g,
    (_, tag: string) => `<${tag} style="${styles[tag]}"`,
  );
}

export const inlineTranslationStyle =
  "display:block;margin-block:0.5em;padding-block-start:0.4em;border-block-start:1px solid color-mix(in srgb,currentColor 18%,transparent);color:inherit;font:inherit;line-height:1.5;overflow-wrap:anywhere";
