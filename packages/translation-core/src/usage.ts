import type { UsageRecord } from "@lingo-sofa/protocol";
export function period(
  timestamp: number,
  timeZone: string,
): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const month = `${get("year")}-${get("month")}`;
  return { day: `${month}-${get("day")}`, month };
}
export class UsageLedger {
  private records = new Map<string, UsageRecord>();
  private inFlight = new Set<string>();
  restore(records: readonly UsageRecord[]): void {
    for (const record of records) this.records.set(record.requestId, record);
  }
  list(): UsageRecord[] {
    return [...this.records.values()];
  }
  clear(): void {
    this.records.clear();
  }
  clearScope(scope: string): void {
    for (const [id, record] of this.records)
      if (record.scope === scope) this.records.delete(id);
  }
  prune(now: number, days: number): void {
    for (const [id, record] of this.records)
      if (record.timestamp < now - days * 86_400_000) this.records.delete(id);
  }
  begin(id: string): void {
    if (this.inFlight.has(id) || this.records.has(id))
      throw new Error("Request already accounted for");
    this.inFlight.add(id);
  }
  settle(record: UsageRecord): void {
    this.inFlight.delete(record.requestId);
    this.records.set(record.requestId, record);
  }
  release(id: string): void {
    this.inFlight.delete(id);
  }
}
export function summarize(records: readonly UsageRecord[]) {
  const unique = [
    ...new Map(records.map((record) => [record.requestId, record])).values(),
  ];
  const speed = unique.filter(
    (record) =>
      record.tps !== null &&
      record.generationMs !== null &&
      record.usage !== null,
  );
  const duration = speed.reduce((sum, record) => sum + record.generationMs!, 0);
  return {
    requests: unique.length,
    input: unique.reduce(
      (sum, record) =>
        sum +
        (record.usage
          ? record.usage.input +
            record.usage.cacheRead +
            record.usage.cacheWrite
          : 0),
      0,
    ),
    output: unique.reduce(
      (sum, record) => sum + (record.usage?.output ?? 0),
      0,
    ),
    tokens: unique.reduce(
      (sum, record) => sum + (record.usage?.totalTokens ?? 0),
      0,
    ),
    cost: unique.every((record) => record.costKnown && record.usage !== null)
      ? unique.reduce((sum, record) => sum + record.usage!.cost.total, 0)
      : null,
    tps:
      duration > 0
        ? speed.reduce((sum, record) => sum + record.usage!.output, 0) /
          (duration / 1_000)
        : null,
    unknown: unique.filter((record) => record.usage === null).length,
  };
}
