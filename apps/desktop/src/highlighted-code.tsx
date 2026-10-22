import React, { useMemo } from "react";
import { common, createLowlight } from "lowlight";

const highlighter = createLowlight(common);
type Token = { value: string; classes: string };
// Bound synchronous highlighting while keeping every source character readable.
const MAX_HIGHLIGHT_LENGTH = 100_000;
export function codeTokens(text: string, language: string) {
  const lines: Token[][] = [[]];
  const append = (value: string, classes: string) => {
    const parts = value.split("\n");
    parts.forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines.at(-1)!.push({ value: part, classes });
    });
  };
  const plain = () => {
    lines.splice(0, lines.length, []);
    append(text, "");
  };
  let highlighted = false;
  if (text.length <= MAX_HIGHLIGHT_LENGTH && highlighter.registered(language)) {
    try {
      const tree = highlighter.highlight(language, text);
      const walk = (node: (typeof tree.children)[number], classes = "") => {
        if (node.type === "text") append(node.value, classes);
        else if (node.type === "element") {
          const own = node.properties.className;
          const next = [classes, Array.isArray(own) ? own.join(" ") : ""]
            .filter(Boolean)
            .join(" ");
          for (const child of node.children) walk(child, next);
        }
      };
      tree.children.forEach((node) => walk(node));
      highlighted = true;
    } catch {
      plain();
    }
  } else plain();
  if (text.endsWith("\n")) lines.pop();
  return { lines, highlighted };
}
export function HighlightedCode({
  text,
  language,
  numbers,
  targetLine = 0,
}: {
  text: string;
  language: string;
  numbers: boolean;
  targetLine?: number;
}) {
  const result = useMemo(() => codeTokens(text, language), [text, language]);
  return (
    <code
      className={`highlighted-code${numbers ? " has-line-numbers" : ""}`}
      style={
        {
          "--line-digits": String(result.lines.length).length,
        } as React.CSSProperties
      }
    >
      {result.lines.map((tokens, index) => (
        <span
          className={`code-line${targetLine === index + 1 ? " is-target-line" : ""}`}
          data-line={index + 1}
          key={index}
        >
          {tokens.map((token, i) => (
            <span className={token.classes || undefined} key={i}>
              {token.value}
            </span>
          ))}
          {index < result.lines.length - 1 || text.endsWith("\n") ? "\n" : ""}
        </span>
      ))}
    </code>
  );
}
