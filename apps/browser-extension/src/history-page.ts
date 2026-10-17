import type { UsageRecord } from "@lingo-sofa/protocol";
import { period } from "@lingo-sofa/translation-core";
export const historyPageSize = 50;
export interface HistoryQuery {
  offset: number;
  range: string;
  source: string;
  provider: string;
  model: string;
  scope: string;
  status: string;
}
export function historyPage(
  records: UsageRecord[],
  value: unknown,
  timeZone: string,
  now = Date.now(),
) {
  if (!value || typeof value !== "object") throw new Error("无效的历史查询");
  const query = value as HistoryQuery;
  if (
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 10000 ||
    !["all", "day", "month"].includes(query.range) ||
    [query.source, query.provider, query.model, query.scope, query.status].some(
      (item) => typeof item !== "string" || item.length > 2000,
    )
  )
    throw new Error("无效的历史查询");
  const today = period(now, timeZone);
  const matching = records
    .filter((record) => {
      const date =
        query.range === "all" ? undefined : period(record.timestamp, timeZone);
      return (
        (query.range === "all" ||
          (query.range === "day"
            ? date?.day === today.day
            : date?.month === today.month)) &&
        (!query.source || record.sourceKind === query.source) &&
        (!query.provider || record.provider === query.provider) &&
        (!query.model || record.model === query.model) &&
        (!query.scope || record.scope === query.scope) &&
        (!query.status || record.status === query.status)
      );
    })
    .sort(
      (a, b) =>
        b.timestamp - a.timestamp || a.requestId.localeCompare(b.requestId),
    );
  const offset = Math.min(
    query.offset,
    Math.max(0, Math.ceil(matching.length / historyPageSize) - 1) *
      historyPageSize,
  );
  return {
    records: matching.slice(offset, offset + historyPageSize),
    total: matching.length,
    allCount: records.length,
    offset,
    providers: [...new Set(records.map((record) => record.provider))],
    models: [...new Set(records.map((record) => record.model))],
    scopes: [...new Set(records.map((record) => record.scope))],
  };
}
export type HistoryPage = ReturnType<typeof historyPage>;
