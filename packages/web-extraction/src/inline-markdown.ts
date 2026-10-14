import { mathMatches } from "@lingo-sofa/translation-core/math";

export interface InlineMarkdown {
  markdown: string;
  links: Record<string, string>;
  protectedParts: string[];
}

// Keep source link destinations local. Only labels and opaque destination
// markers cross the model boundary; hrefs are restored by the page renderer.
export function inlineMarkdown(
  root: HTMLElement,
  include: (element: HTMLElement) => boolean,
): InlineMarkdown {
  let prefix = "⟦LS-WEB-LINK:";
  while (root.textContent?.includes(prefix)) prefix += ":";
  const links: Record<string, string> = {};
  const protectedParts: string[] = [];
  const escape = (text: string) => text.replace(/[\\`*_[\]<>~]/g, "\\$&");
  function prose(text: string): string {
    // HTML source line wrapping is whitespace, not a reading line break.
    const normalize = (value: string) => value.replace(/[\t\r\n ]+/g, " ");
    let offset = 0;
    let result = "";
    const preserved = [
      ...mathMatches(text),
      ...[...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((match) => ({
        start: match.index,
        raw: match[0],
      })),
    ].sort((a, b) => a.start - b.start);
    for (const match of preserved) {
      if (match.start < offset) continue;
      result += escape(normalize(text.slice(offset, match.start))) + match.raw;
      offset = match.start + match.raw.length;
    }
    return result + escape(normalize(text.slice(offset)));
  }
  function visit(node: Node): string {
    if (node.nodeType === 3) return prose(node.textContent ?? "");
    if (!(node instanceof HTMLElement) || !include(node)) return "";
    if (node.tagName === "BR") return "  \n";
    if (node.tagName === "CODE") {
      function codeText(part: Node): string {
        if (part.nodeType === 3) return part.textContent ?? "";
        if (!(part instanceof HTMLElement) || !include(part)) return "";
        return [...part.childNodes].map(codeText).join("");
      }
      const code = [...node.childNodes].map(codeText).join("");
      const size =
        Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length)) + 1;
      const fence = "`".repeat(size);
      const wrapped = `${fence} ${code} ${fence}`;
      protectedParts.push(wrapped);
      return wrapped;
    }
    const content = [...node.childNodes].map(visit).join("");
    if (!content.trim()) return content;
    // Spaces belong outside emphasis delimiters for valid Markdown syntax.
    function wrap(delimiter: string) {
      return content.replace(
        /^(\s*)([\s\S]*?)(\s*)$/,
        (_, before, body, after) =>
          `${before}${delimiter}${body}${delimiter}${after}`,
      );
    }
    if (["STRONG", "B"].includes(node.tagName)) return wrap("**");
    if (["EM", "I"].includes(node.tagName)) return wrap("*");
    if (["DEL", "S"].includes(node.tagName)) return wrap("~~");
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (!href) return content;
      let url: URL;
      try {
        url = new URL(href, root.ownerDocument.baseURI);
      } catch {
        return content;
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol))
        return content;
      const marker = `${prefix}${Object.keys(links).length}⟧`;
      links[marker] = url.href;
      protectedParts.push(marker);
      return `[${content}](${marker})`;
    }
    return content;
  }
  return {
    markdown: [...root.childNodes].map(visit).join("").trim(),
    links,
    protectedParts,
  };
}
