import { settingsSchema } from "@lingo-sofa/protocol";
export type GlossaryTerm = { source: string; target: string };
export function validateGlossary(value: unknown): GlossaryTerm[] {
  if (!Array.isArray(value))
    throw new Error("请使用术语数组 JSON，或每行两列的 TSV 文件。");
  const normalized = value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("source" in item) ||
      !("target" in item)
    )
      return item;
    return {
      ...item,
      source:
        typeof item.source === "string" ? item.source.trim() : item.source,
      target:
        typeof item.target === "string" ? item.target.trim() : item.target,
    };
  });
  const parsed = settingsSchema.shape.glossary.safeParse(normalized);
  if (!parsed.success)
    throw new Error("术语最多 200 项，每项原词和译词须为 1–100 字符。");
  if (
    new Set(parsed.data.map((term) => term.source)).size !== parsed.data.length
  )
    throw new Error("原词不能重复，请先合并重复项。");
  return parsed.data;
}
export function importGlossary(
  text: string,
  current: GlossaryTerm[],
): GlossaryTerm[] {
  if (text.length > 100_000) throw new Error("文件过大，请限制在 100 KB 内。");
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("文件中没有术语。");
  let decoded: unknown;
  if (source.startsWith("[") || source.startsWith("{")) {
    try {
      decoded = JSON.parse(source);
    } catch {
      throw new Error("JSON 格式不正确，请检查文件。");
    }
  } else {
    decoded = source
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split("\t");
        if (parts.length !== 2)
          throw new Error("TSV 每行应为原词、制表符、译词，不含标题行。");
        return { source: parts[0], target: parts[1] };
      });
  }
  const incoming = validateGlossary(decoded);
  if (!incoming.length) throw new Error("文件中没有术语。");
  const merged = new Map(
    validateGlossary(current).map((term) => [term.source, term]),
  );
  for (const term of incoming) {
    const previous = merged.get(term.source);
    if (previous && previous.target !== term.target)
      throw new Error(`原词「${term.source}」已有不同译法，请先解决冲突。`);
    merged.set(term.source, term);
  }
  return validateGlossary([...merged.values()]);
}
export function exportGlossary(terms: GlossaryTerm[]): string {
  return JSON.stringify(validateGlossary(terms), null, 2) + "\n";
}
