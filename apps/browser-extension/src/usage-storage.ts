import {
  usageRecordSchema,
  type Settings,
  type UsageRecord,
} from "@lingo-sofa/protocol";

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

/** Serialize checkpoints and migrations so a finishing request follows the new preference. */
export class UsageStorage {
  private writes: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, UsageRecord>();
  constructor(
    private readonly storage: { local: StorageArea; session: StorageArea },
    private readonly readSettings: () => Promise<Settings>,
  ) {}
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => undefined);
    return result;
  }
  write(snapshot: () => UsageRecord[]): Promise<void> {
    return this.serialize(() => this.checkpoint(snapshot));
  }
  private async checkpoint(snapshot: () => UsageRecord[], finished?: string) {
    const settings = await this.readSettings();
    const usage = snapshot();
    const completed = new Set(usage.map((record) => record.requestId));
    if (finished) completed.add(finished);
    const inFlight = [...this.pending.values()].filter(
      (record) => !completed.has(record.requestId),
    );
    await this.storage[settings.persistUsage ? "local" : "session"].set({
      usage,
      inFlight,
    });
    for (const id of completed) this.pending.delete(id);
  }
  begin(record: UsageRecord): Promise<void> {
    return this.serialize(async () => {
      const settings = await this.readSettings();
      await this.storage[settings.persistUsage ? "local" : "session"].set({
        inFlight: [...this.pending.values(), record],
      });
      this.pending.set(record.requestId, record);
    });
  }
  finish(id: string, snapshot: () => UsageRecord[]): Promise<void> {
    return this.serialize(async () => {
      if (this.pending.has(id)) await this.checkpoint(snapshot, id);
    });
  }
  readPending(): Promise<UsageRecord[]> {
    return this.serialize(async () => {
      const settings = await this.readSettings();
      const saved =
        await this.storage[settings.persistUsage ? "local" : "session"].get(
          "inFlight",
        );
      // Older versions kept all pending requests in session storage.
      const legacy = settings.persistUsage
        ? await this.storage.session.get("inFlight")
        : {};
      const pending = usageRecordSchema
        .array()
        .parse([
          ...(Array.isArray(legacy.inFlight) ? legacy.inFlight : []),
          ...(Array.isArray(saved.inFlight) ? saved.inFlight : []),
        ]);
      return [
        ...new Map(
          pending.map((record) => [record.requestId, record]),
        ).values(),
      ];
    });
  }
  clearPending(): Promise<void> {
    return this.serialize(async () => {
      await this.storage.local.remove("inFlight");
      await this.storage.session.remove("inFlight");
      this.pending.clear();
    });
  }
  saveSettings(next: Settings, snapshot: () => UsageRecord[]): Promise<void> {
    return this.serialize(async () => {
      const previous = await this.readSettings();
      if (previous.persistUsage === next.persistUsage) {
        await this.storage.local.set({ settings: next });
        return;
      }
      if (next.persistUsage) {
        // Commit the destination and its selector together; the source stays intact on failure.
        await this.storage.local.set({
          settings: next,
          usage: snapshot(),
          inFlight: [...this.pending.values()],
        });
        await this.storage.session
          .remove(["usage", "inFlight"])
          .catch(() => undefined);
      } else {
        const backup = await this.storage.session.get("usage");
        const pendingBackup = await this.storage.session.get("inFlight");
        await this.storage.session.set({
          usage: snapshot(),
          inFlight: [...this.pending.values()],
        });
        try {
          // Empty persistent records in the same commit that disables persistence.
          await this.storage.local.set({
            settings: next,
            usage: [],
            inFlight: [],
          });
        } catch (error) {
          await (
            backup.usage === undefined
              ? this.storage.session.remove("usage")
              : this.storage.session.set(backup)
          ).catch(() => undefined);
          await (
            pendingBackup.inFlight === undefined
              ? this.storage.session.remove("inFlight")
              : this.storage.session.set(pendingBackup)
          ).catch(() => undefined);
          throw error;
        }
      }
    });
  }
  clear(): Promise<void> {
    return this.serialize(async () => {
      await this.storage.local.remove(["usage", "inFlight"]);
      await this.storage.session.remove(["usage", "inFlight"]);
      this.pending.clear();
    });
  }
}
