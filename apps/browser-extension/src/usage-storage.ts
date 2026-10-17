import type { Settings, UsageRecord } from "@lingo-sofa/protocol";

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

/** Serialize checkpoints and migrations so a finishing request follows the new preference. */
export class UsageStorage {
  private writes: Promise<unknown> = Promise.resolve();
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
    return this.serialize(async () => {
      const settings = await this.readSettings();
      await this.storage[settings.persistUsage ? "local" : "session"].set({
        usage: snapshot(),
      });
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
        await this.storage.local.set({ settings: next, usage: snapshot() });
        await this.storage.session.remove("usage").catch(() => undefined);
      } else {
        const backup = await this.storage.session.get("usage");
        await this.storage.session.set({ usage: snapshot() });
        try {
          // Empty persistent records in the same commit that disables persistence.
          await this.storage.local.set({ settings: next, usage: [] });
        } catch (error) {
          await (
            backup.usage === undefined
              ? this.storage.session.remove("usage")
              : this.storage.session.set(backup)
          ).catch(() => undefined);
          throw error;
        }
      }
    });
  }
  clear(): Promise<void> {
    return this.serialize(async () => {
      await this.storage.local.remove("usage");
      await this.storage.session.remove(["usage", "inFlight"]);
    });
  }
}
