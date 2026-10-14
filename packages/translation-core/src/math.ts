import { codeFragments } from "./code.js";
export interface MathFragment {
  start: number;
  raw: string;
  body: string;
  display: boolean;
}
const delimiters = [
  ["$$", "$$", true],
  ["\\[", "\\]", true],
  ["\\(", "\\)", false],
  ["$", "$", false],
] as const;
function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at--) slashes++;
  return slashes % 2 === 1;
}
function mathAt(text: string, start = 0): MathFragment | undefined {
  if (escaped(text, start)) return;
  for (const [open, close, display] of delimiters) {
    if (!text.startsWith(open, start)) continue;
    let end = text.indexOf(close, start + open.length);
    while (end >= 0 && escaped(text, end))
      end = text.indexOf(close, end + close.length);
    if (end < 0) return;
    const body = text.slice(start + open.length, end);
    // A dollar amount followed by another amount is not an inline formula.
    if (
      !body.trim() ||
      (open === "$" &&
        (/^\s|\s$|\n/.test(body) || /\d/.test(text[end + 1] ?? "")))
    )
      return;
    if (open === "$" && /^\d[\d.,]*(?:\s+[A-Za-z]|[;:])/.test(body)) return;
    return { start, raw: text.slice(start, end + close.length), body, display };
  }
}
function firstMath(text: string): MathFragment | undefined {
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== "$" && text[at] !== "\\") continue;
    if (text[at] === "$" && text[at - 1] === "$") continue;
    const match = mathAt(text, at);
    if (match) return match;
  }
}
export function mathMatches(text: string): MathFragment[] {
  let masked = text;
  for (const part of codeFragments(text))
    masked = masked.split(part).join(" ".repeat(part.length));
  const parts: MathFragment[] = [];
  let offset = 0;
  while (offset < masked.length) {
    const match = firstMath(masked.slice(offset));
    if (!match) break;
    const start = offset + match.start;
    const raw = text.slice(start, start + match.raw.length);
    const width = (match.raw.length - match.body.length) / 2;
    parts.push({
      start,
      raw,
      body: raw.slice(width, -width),
      display: match.display,
    });
    offset = start + match.raw.length;
  }
  return parts;
}

export function mathFragments(text: string): string[] {
  return mathMatches(text).map((match) => match.raw);
}
