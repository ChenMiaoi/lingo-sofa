import type { Settings, UsageRecord } from "@lingo-sofa/protocol";
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
  private reservations = new Map<
    string,
    { tokens: number; cost: number | null }
  >();
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
  reserve(
    id: string,
    tokens: number,
    cost: number | null,
    settings: Settings,
    now = Date.now(),
  ): void {
    if (this.reservations.has(id) || this.records.has(id))
      throw new Error("Request already accounted for");
    const current = period(now, settings.timeZone);
    const inMonth = this.list().filter(
      (record) =>
        period(record.timestamp, settings.timeZone).month === current.month,
    );
    const inDay = inMonth.filter(
      (record) =>
        period(record.timestamp, settings.timeZone).day === current.day,
    );
    const reservedTokens = [...this.reservations.values()].reduce(
      (sum, item) => sum + item.tokens,
      0,
    );
    const reservedCost = [...this.reservations.values()].reduce(
      (sum, item) => sum + (item.cost ?? 0),
      0,
    );
    const limits = [
      [inDay, settings.dailyTokens, settings.dailyCost],
      [inMonth, settings.monthlyTokens, settings.monthlyCost],
    ] as const;
    for (const [records, tokenLimit, costLimit] of limits) {
      if (
        settings.strictBudget &&
        (tokenLimit !== null || costLimit !== null) &&
        records.some(
          (record) =>
            record.usage === null || (costLimit !== null && !record.costKnown),
        )
      )
        throw new Error("Budget paused: previous consumption is unknown");
      if (
        tokenLimit !== null &&
        records.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0) +
          reservedTokens +
          tokens >
          tokenLimit
      )
        throw new Error("Token budget exceeded");
      if (costLimit !== null) {
        if (
          settings.strictBudget &&
          (cost === null ||
            [...this.reservations.values()].some((item) => item.cost === null))
        )
          throw new Error("Budget paused: price is unknown");
        if (
          records.reduce(
            (sum, item) => sum + (item.usage?.cost.total ?? 0),
            0,
          ) +
            reservedCost +
            (cost ?? 0) >
          costLimit
        )
          throw new Error("Cost budget exceeded");
      }
    }
    this.reservations.set(id, { tokens, cost });
  }
  settle(record: UsageRecord): void {
    this.reservations.delete(record.requestId);
    this.records.set(record.requestId, record);
  }
  release(id: string): void {
    this.reservations.delete(id);
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

export function budgetStatus(
  records: readonly UsageRecord[],
  settings: Settings,
  now = Date.now(),
) {
  const current = period(now, settings.timeZone);
  return (["day", "month"] as const).flatMap((window) => {
    const matching = records.filter(
      (record) =>
        period(record.timestamp, settings.timeZone)[window] === current[window],
    );
    const total = summarize(matching);
    const tokens =
      window === "day" ? settings.dailyTokens : settings.monthlyTokens;
    const cost = window === "day" ? settings.dailyCost : settings.monthlyCost;
    return [
      {
        metric: "tokens" as const,
        used: total.unknown ? null : total.tokens,
        limit: tokens,
      },
      { metric: "cost" as const, used: total.cost, limit: cost },
    ]
      .filter((item) => item.limit !== null)
      .map((item) => ({
        ...item,
        window,
        ratio: item.used === null ? null : item.used / item.limit!,
        warning:
          item.used === null
            ? settings.strictBudget
            : item.used / item.limit! >= settings.warningRatio,
      }));
  });
}
