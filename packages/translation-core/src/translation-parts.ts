import { Lexer } from "marked";
import type { TranslationUnit, TranslationResult } from "@lingo-sofa/protocol";
import { protect, restore } from "./protection.js";
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Split prose without cutting code, formulas, Markdown links or emphasis tokens. */
export function translationParts(unit: TranslationUnit, limit: number) {
  const original = protect(unit.text, unit.protectedParts);
  let prefix = "⟦LS-PART:";
  while (unit.text.includes(prefix)) prefix += ":";
  const fragments = new Map<string, string>();
  let text = original.text;
  for (const [marker, fragment] of original.fragments) {
    const next = `${prefix}${fragments.size}⟧`;
    text = text.split(marker).join(next);
    fragments.set(next, fragment);
  }
  const protectedText = { text, fragments };
  if (bytes(protectedText.text) <= limit) return;
  const atoms = Lexer.lexInline(protectedText.text).flatMap((token) => {
    if (token.type !== "text") return [token.raw];
    return (token.raw.match(/⟦LS-PART:+\d+⟧|\s+|[^\s⟦]+|⟦/gu) ?? []).flatMap(
      (atom) => {
        if (/^⟦LS-PART:+\d+⟧$/.test(atom) || bytes(atom) <= limit)
          return [atom];
        const pieces: string[] = [];
        let piece = "";
        for (const character of atom) {
          if (piece && bytes(piece + character) > limit) {
            pieces.push(piece);
            piece = "";
          }
          piece += character;
        }
        if (piece) pieces.push(piece);
        return pieces;
      },
    );
  });
  const chunks: { text: string; prefix: string; separator: string }[] = [];
  let current = "";
  const flush = () => {
    if (current.trim())
      chunks.push({
        text: current.trim(),
        prefix: current.match(/^\s*/u)![0],
        separator: current.match(/\s*$/u)![0],
      });
    current = "";
  };
  for (const atom of atoms) {
    if (current.trim() && bytes(current + atom) > limit) flush();
    current += atom;
  }
  flush();
  if (chunks.length < 2) return;
  return {
    chunks,
    markers: [...protectedText.fragments.keys()],
    combine(results: TranslationResult[]): TranslationResult {
      const text = restore(
        results
          .map(
            (result, index) =>
              chunks[index]!.prefix + result.text + chunks[index]!.separator,
          )
          .join(""),
        protectedText,
      );
      const bills = results.map((result) => result.billing);
      const billing = bills.every((bill) => bill !== undefined)
        ? {
            source: bills.every((bill) => bill!.source === "cache")
              ? ("cache" as const)
              : ("request" as const),
            batchSize: 1,
            tokens: bills.some((bill) => bill!.tokens === null)
              ? null
              : bills.reduce((sum, bill) => sum + bill!.tokens!, 0),
            cost: bills.some((bill) => bill!.cost === null)
              ? null
              : bills.reduce((sum, bill) => sum + bill!.cost!, 0),
            billingMode: bills.every(
              (bill) => bill!.billingMode === bills[0]!.billingMode,
            )
              ? bills[0]!.billingMode
              : undefined,
            pricing: bills.every(
              (bill) =>
                JSON.stringify(bill!.pricing) ===
                JSON.stringify(bills[0]!.pricing),
            )
              ? bills[0]!.pricing
              : undefined,
          }
        : undefined;
      return { id: unit.id, revision: unit.revision, text, billing };
    },
  };
}
