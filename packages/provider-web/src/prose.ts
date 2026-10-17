import { Lexer, type Token } from "marked";
import { protect } from "@lingo-sofa/translation-core";

/** Keep markup and protected fragments local; only prose goes to the service. */
export function proseTemplate(
  source: string,
  parts: readonly string[],
  terms: readonly { source: string; target: string }[],
) {
  const destinations: string[] = [];
  function links(tokens: Token[]) {
    for (const token of tokens) {
      if ("href" in token && typeof token.href === "string")
        destinations.push(token.href);
      if ("tokens" in token && token.tokens) links(token.tokens);
    }
  }
  links(Lexer.lexInline(source));
  const protectedText = protect(source, [...parts, ...destinations]);
  let prefix = "LS_PROTECTED_";
  while (source.includes(prefix)) prefix += "_";
  let prepared = protectedText.text;
  const fragments = new Map<string, string>();
  for (const [marker, fragment] of protectedText.fragments) {
    const replacement = `${prefix}${fragments.size}_END`;
    prepared = prepared.split(marker).join(replacement);
    fragments.set(replacement, fragment);
  }
  const values: string[] = [];
  const translated: { index: number }[] = [];
  const literal = (text: string) => {
    values.push(text);
  };
  const termList = [...terms]
    .filter((term) => term.source)
    .sort((a, b) => b.source.length - a.source.length);
  function prose(text: string) {
    // Split literals locally so machine translation cannot rewrite protection markers.
    const literals = [
      ...fragments,
      ...termList.map((term) => [term.source, term.target] as const),
    ];
    let cursor = 0;
    while (cursor < text.length) {
      let next: { at: number; source: string; target: string } | undefined;
      for (const [source, target] of literals) {
        const at = text.indexOf(source, cursor);
        if (
          at >= 0 &&
          (!next ||
            at < next.at ||
            (at === next.at && source.length > next.source.length))
        )
          next = { at, source, target };
      }
      const end = next?.at ?? text.length;
      const raw = text.slice(cursor, end);
      const leading = raw.match(/^\s*/u)![0];
      const trailing = raw.slice(leading.length).match(/\s*$/u)![0];
      literal(leading);
      const body = raw.slice(leading.length, raw.length - trailing.length);
      if (body && /[\p{L}\p{N}]/u.test(body)) {
        // Bound requests without cutting surrogate pairs.
        const characters = Array.from(body);
        for (let offset = 0; offset < characters.length; offset += 1500) {
          translated.push({ index: values.length });
          values.push(characters.slice(offset, offset + 1500).join(""));
        }
      } else literal(body);
      literal(trailing);
      if (!next) break;
      literal(next.target);
      cursor = next.at + next.source.length;
    }
  }
  function inline(tokens: Token[]) {
    for (const token of tokens) {
      if (
        ["strong", "em", "del", "link"].includes(token.type) &&
        "tokens" in token &&
        token.tokens &&
        "text" in token
      ) {
        const at = token.raw.indexOf(token.text);
        if (at < 0) throw new Error("无法安全保留原文格式");
        literal(token.raw.slice(0, at));
        inline(token.tokens);
        literal(token.raw.slice(at + token.text.length));
      } else if (token.type === "text") prose(token.raw);
      else literal(token.raw);
    }
  }
  const lines = prepared.split(/(\r?\n)/u);
  for (const line of lines) {
    const prefix = line.match(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)*/u)![0];
    literal(prefix);
    inline(Lexer.lexInline(line.slice(prefix.length)));
  }
  return {
    texts: translated.map(({ index }) => values[index]!),
    combine(texts: readonly string[]) {
      if (texts.length !== translated.length)
        throw new Error("翻译结果数量不匹配");
      const result = [...values];
      translated.forEach(({ index }, i) => {
        result[index] = texts[i]!;
      });
      let output = result.join("");
      for (const [marker, fragment] of fragments)
        output = output.split(marker).join(fragment);
      return output;
    },
  };
}
