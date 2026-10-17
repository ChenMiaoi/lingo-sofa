import type { UsageRecord, UsageSummary } from "@lingo-sofa/protocol";

/** Freeze each request's API price; changing today's model never reprices history. */
export function apiCost(record: UsageRecord): number | null {
  if (record.billingMode === "free") return 0;
  if (!record.usage) return null;
  const prices = record.pricing?.prices;
  if (prices) {
    const usage = record.usage;
    return (
      (usage.input * prices.input +
        usage.output * prices.output +
        usage.cacheRead * prices.cacheRead +
        usage.cacheWrite * prices.cacheWrite) /
      1_000_000
    );
  }
  return record.costKnown ? record.usage.cost.total : null;
}
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
  private summaries = new Map<string, UsageSummary>();
  restore(records: readonly UsageRecord[]): void {
    for (const record of records) this.records.set(record.requestId, record);
    if (records.length) this.summaries.clear();
  }
  list(): UsageRecord[] {
    return [...this.records.values()];
  }
  summary(mode?: UsageRecord["mode"]): UsageSummary {
    const key = mode ?? "all";
    let summary = this.summaries.get(key);
    if (!summary) {
      summary = summarizeModels(
        this.list().filter((record) => !mode || record.mode === mode),
      );
      this.summaries.set(key, summary);
    }
    // Callers own their snapshot; editing one must not poison the cached totals.
    return {
      totals: { ...summary.totals },
      models: summary.models.map((model) => ({ ...model })),
    };
  }
  clear(): void {
    this.records.clear();
    this.summaries.clear();
  }
  clearScope(scope: string): void {
    for (const [id, record] of this.records)
      if (record.scope === scope) {
        this.records.delete(id);
        this.summaries.clear();
      }
  }
  prune(now: number, days: number): void {
    for (const [id, record] of this.records)
      if (record.timestamp < now - days * 86_400_000) {
        this.records.delete(id);
        this.summaries.clear();
      }
  }
  begin(id: string): void {
    if (this.inFlight.has(id) || this.records.has(id))
      throw new Error("Request already accounted for");
    this.inFlight.add(id);
  }
  settle(record: UsageRecord): void {
    this.inFlight.delete(record.requestId);
    this.records.set(record.requestId, record);
    this.summaries.clear();
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
  const costs = unique.map(apiCost);
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
    cost: costs.every((cost) => cost !== null)
      ? costs.reduce<number>((sum, cost) => sum + cost!, 0)
      : null,
    knownCost: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    unpriced: unique.filter(
      (record) => record.usage !== null && apiCost(record) === null,
    ).length,
    tps:
      duration > 0
        ? speed.reduce((sum, record) => sum + record.usage!.output, 0) /
          (duration / 1_000)
        : null,
    unknown: unique.filter(
      (record) => record.usage === null && record.billingMode !== "free",
    ).length,
  };
}

export function summarizeModels(records: readonly UsageRecord[]): UsageSummary {
  const groups = new Map<string, UsageRecord[]>();
  const unique = new Map(records.map((record) => [record.requestId, record]));
  for (const record of unique.values()) {
    const key = JSON.stringify([record.provider, record.model]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const totals = (items: readonly UsageRecord[]) => {
    const {
      requests,
      input,
      output,
      tokens,
      cost,
      knownCost,
      unknown,
      unpriced,
    } = summarize(items);
    return {
      requests,
      input,
      output,
      tokens,
      cost,
      knownCost,
      unknown,
      unpriced,
    };
  };
  return {
    totals: totals([...unique.values()]),
    models: [...groups.values()]
      .map((items) => ({
        provider: items[0]!.provider,
        model: items[0]!.model,
        ...totals(items),
      }))
      .sort(
        (a, b) =>
          b.tokens - a.tokens ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      ),
  };
}

export function mergeUsageSummaries(
  ...summaries: UsageSummary[]
): UsageSummary {
  const models = new Map<string, UsageSummary["models"][number]>();
  const add = (a: UsageSummary["totals"], b: UsageSummary["totals"]) => ({
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    tokens: a.tokens + b.tokens,
    cost: a.cost === null || b.cost === null ? null : a.cost + b.cost,
    knownCost: a.knownCost + b.knownCost,
    unknown: a.unknown + b.unknown,
    unpriced: a.unpriced + b.unpriced,
  });
  let totals = summarizeModels([]).totals;
  for (const summary of summaries) {
    totals = add(totals, summary.totals);
    for (const item of summary.models) {
      const key = JSON.stringify([item.provider, item.model]);
      const previous = models.get(key);
      models.set(
        key,
        previous ? { ...item, ...add(previous, item) } : { ...item },
      );
    }
  }
  return {
    totals,
    models: [...models.values()].sort(
      (a, b) =>
        b.tokens - a.tokens ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    ),
  };
}
