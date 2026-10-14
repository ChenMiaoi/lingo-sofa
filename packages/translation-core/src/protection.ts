import { codeFragments } from "./code.js";
export interface ProtectedText {
  text: string;
  fragments: ReadonlyMap<string, string>;
}
export function protect(
  text: string,
  parts: readonly string[] = [],
): ProtectedText {
  let prefix = "⟦LS:";
  while (text.includes(prefix)) prefix += ":";
  const fragments = new Map<string, string>();
  const replace = (value: string): string => {
    const marker = `${prefix}${fragments.size}⟧`;
    fragments.set(marker, value);
    return marker;
  };
  const explicit = [...new Set([...codeFragments(text), ...parts])].sort(
    (a, b) => b.length - a.length,
  );
  let result = text;
  for (const part of explicit) {
    if (part) result = result.split(part).join(replace(part));
  }
  result = result.replace(
    /`[^`\n]+`|https?:\/\/[^\s<>⟦⟧]+|<[@#][!&]?\d+>|<a?:\w+:\d+>/g,
    replace,
  );
  return { text: result, fragments };
}
export function restore(translated: string, original: ProtectedText): string {
  let result = translated;
  for (const [marker, fragment] of original.fragments) {
    const expected = original.text.split(marker).length - 1;
    if (result.split(marker).length - 1 !== expected)
      throw new Error("Protected content was altered by the model");
    result = result.split(marker).join(fragment);
  }
  if (/⟦LS:+\d+⟧/.test(result)) throw new Error("Unexpected protection marker");
  return result;
}
