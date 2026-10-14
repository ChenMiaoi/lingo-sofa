import { Marked } from "marked";
const markdown = new Marked();

export function codeFragments(text: string, blocksOnly = false): string[] {
  const fragments: string[] = [];
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "code" || (!blocksOnly && token.type === "codespan"))
      fragments.push(token.raw);
  });
  return fragments;
}

export function withoutCode(text: string, blocksOnly = false): string {
  for (const fragment of codeFragments(text, blocksOnly))
    text = text.split(fragment).join(blocksOnly ? "\n" : "");
  return text.trim();
}
