import type {
  Settings,
  TranslationResult,
  TranslationUnit,
} from "@lingo-sofa/protocol";
import { cacheKey } from "@lingo-sofa/translation-core";

export interface CachePreferences {
  enabled: boolean;
  days: number;
}
export function cachePreferences(value: unknown): CachePreferences {
  const saved = value as Partial<CachePreferences> | null;
  return {
    enabled: saved?.enabled !== false,
    days: [1, 7, 30].includes(saved?.days ?? 0) ? saved!.days! : 7,
  };
}
interface Entry {
  key: string;
  text: string;
  createdAt: number;
  usedAt: number;
}
export class LocalTranslationCache {
  private entries: Entry[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private hits = 0;
  private lookups = 0;
  get version() {
    return this.revision;
  }
  constructor(
    private storage: {
      read: () => Promise<unknown>;
      write: (entries: Entry[]) => Promise<void>;
    },
    private now = Date.now,
    private maxBytes = 2_000_000,
  ) {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    const work = this.queue.then(action);
    this.queue = work.catch(() => undefined);
    return work;
  }
  private async read(days: number) {
    if (!this.entries) {
      let saved: unknown;
      try {
        saved = await this.storage.read();
      } catch {
        saved = [];
      }
      this.entries = Array.isArray(saved)
        ? saved
            .slice(-1000)
            .filter(
              (entry): entry is Entry =>
                entry &&
                typeof entry.key === "string" &&
                /^[a-f0-9]{64}$/.test(entry.key) &&
                typeof entry.text === "string" &&
                entry.text.length <= 64_000 &&
                Number.isFinite(entry.createdAt) &&
                Number.isFinite(entry.usedAt),
            )
        : [];
    }
    const oldest = this.now() - days * 86_400_000;
    const kept = this.entries.filter(
      (entry) => entry.createdAt > oldest && entry.createdAt <= this.now(),
    );
    if (kept.length !== this.entries.length) await this.storage.write(kept);
    this.entries = kept;
    return this.entries;
  }
  async lookup(
    units: readonly TranslationUnit[],
    namespace: string,
    settings: Settings,
    preferences: CachePreferences,
    revision = this.revision,
  ) {
    const keys = await Promise.all(
      units.map(async (unit) => {
        const input = cacheKey(
          namespace,
          unit,
          JSON.stringify({
            engine: settings.translationEngine,
            model: settings.model,
          }),
          settings.glossary,
        );
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input),
        );
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      }),
    );
    return this.run(async () => {
      const entries = preferences.enabled
        ? await this.read(preferences.days)
        : [];
      const cached = keys.map((key) =>
        entries.find((entry) => entry.key === key),
      );
      for (const entry of cached) if (entry) entry.usedAt = this.now();
      this.lookups += units.length;
      this.hits += cached.filter(Boolean).length;
      return {
        keys,
        texts: cached.map((entry) => entry?.text),
        revision,
      };
    });
  }
  async store(
    lookup: Awaited<ReturnType<LocalTranslationCache["lookup"]>>,
    units: readonly TranslationUnit[],
    results: readonly TranslationResult[],
    preferences: CachePreferences,
  ) {
    if (!preferences.enabled) return;
    await this.run(async () => {
      if (lookup.revision !== this.revision) return;
      const entries = await this.read(preferences.days);
      for (const result of results) {
        if (result.billing?.source === "cache") continue;
        const index = units.findIndex(
          (unit) => unit.id === result.id && unit.revision === result.revision,
        );
        const key = lookup.keys[index];
        if (!key || !result.text || result.text.length > 64_000) continue;
        const old = entries.findIndex((entry) => entry.key === key);
        if (old >= 0) entries.splice(old, 1);
        entries.push({
          key,
          text: result.text,
          createdAt: this.now(),
          usedAt: this.now(),
        });
      }
      entries.sort((a, b) => a.usedAt - b.usedAt);
      while (
        entries.length &&
        (entries.length > 1000 ||
          new TextEncoder().encode(JSON.stringify(entries)).byteLength >
            this.maxBytes)
      )
        entries.shift();
      await this.storage.write(entries);
    });
  }
  async clear() {
    this.revision++;
    await this.run(async () => {
      this.entries = [];
      this.hits = this.lookups = 0;
      await this.storage.write([]);
    });
  }
  async prune(days: number) {
    await this.run(async () => {
      const entries = await this.read(days);
      await this.storage.write(entries);
    });
  }
  stats() {
    return {
      hits: this.hits,
      lookups: this.lookups,
      ratio: this.lookups ? this.hits / this.lookups : null,
    };
  }
}
