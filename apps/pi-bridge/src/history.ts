import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { usageRecordSchema, type UsageRecord } from "@lingo-sofa/protocol";
/** Atomic, metadata-only checkpoints; sent requests recover as unknown, never replay. */
export class UsageHistory {
  private readonly path: string;
  private writes = Promise.resolve();
  constructor(
    directory: string,
    private readonly enabled: boolean,
  ) {
    this.path = join(directory, "usage.json");
    if (!enabled) rmSync(this.path, { force: true });
  }
  read(): UsageRecord[] {
    if (!this.enabled || !existsSync(this.path)) return [];
    return usageRecordSchema
      .array()
      .max(10_000)
      .parse(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
  }
  save(records: UsageRecord[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const snapshot = JSON.stringify(
      usageRecordSchema.array().max(10_000).parse(records),
    );
    const write = this.writes.then(async () => {
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
