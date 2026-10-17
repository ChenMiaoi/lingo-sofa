import { describe, expect, it } from "vitest";
import { settingsSchema, usageRecordSchema } from "@lingo-sofa/protocol";
import { UsageStorage } from "../apps/browser-extension/src/usage-storage.js";

const record = usageRecordSchema.parse({
  requestId: "00000000-0000-4000-8000-000000000001",
  scope: "web:fixture",
  provider: "fixture",
  model: "fixture",
  sourceKind: "web",
  mode: "direct",
  status: "success",
  timestamp: Date.now(),
  usage: null,
  costKnown: false,
  durationMs: 1,
  firstOutputMs: null,
  firstTextMs: null,
  generationMs: null,
  tps: null,
});
function area(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  return {
    data,
    fail: false,
    async get(key: string) {
      return { [key]: data[key] };
    },
    async set(value: Record<string, unknown>) {
      if (this.fail) throw new Error("Storage full");
      Object.assign(data, structuredClone(value));
    },
    async remove(key: string | string[]) {
      for (const name of [key].flat()) delete data[name];
    },
  };
}
function fixture(persistUsage = false) {
  const settings = settingsSchema.parse({ mode: "direct", persistUsage });
  const local = area({
    settings,
    ...(persistUsage ? { usage: [record] } : {}),
  });
  const session = area(persistUsage ? {} : { usage: [record] });
  const storage = new UsageStorage({ local, session }, async () =>
    settingsSchema.parse(local.data.settings),
  );
  return { settings, local, session, storage };
}
describe("usage storage migration", () => {
  it("prefers the current durable checkpoint when an older session copy remains after migration", async () => {
    const { storage, local, session } = fixture(true);
    const pending = { ...record, status: "unknown" as const };
    local.data.inFlight = [{ ...pending, durationMs: 50 }];
    session.data.inFlight = [{ ...pending, durationMs: 0 }];
    expect(await storage.readPending()).toEqual([
      { ...pending, durationMs: 50 },
    ]);
  });
  it.each([false, true])(
    "checkpoints pending requests in the selected area and recovers them after a restart (persistent=%s)",
    async (persistUsage) => {
      const { storage, local, session } = fixture(persistUsage);
      const pending = {
        ...record,
        requestId: crypto.randomUUID(),
        status: "unknown" as const,
      };
      await storage.begin(pending);
      expect((persistUsage ? local : session).data.inFlight).toEqual([pending]);
      expect((persistUsage ? session : local).data.inFlight).toBeUndefined();
      const restarted = new UsageStorage({ local, session }, async () =>
        settingsSchema.parse(local.data.settings),
      );
      expect(await restarted.readPending()).toEqual([pending]);
      await restarted.write(() => [record, pending]);
      await restarted.clearPending();
      expect(await restarted.readPending()).toEqual([]);
      expect((persistUsage ? local : session).data.usage).toEqual([
        record,
        pending,
      ]);
    },
  );
  it("moves pending requests with the preference and atomically replaces a pending checkpoint with its final record", async () => {
    const { storage, settings, local, session } = fixture();
    const pending = {
      ...record,
      requestId: crypto.randomUUID(),
      status: "unknown" as const,
    };
    await storage.begin(pending);
    await storage.saveSettings({ ...settings, persistUsage: true }, () => [
      record,
    ]);
    expect(local.data.inFlight).toEqual([pending]);
    expect(session.data.inFlight).toBeUndefined();
    await storage.saveSettings(settings, () => [record]);
    expect(local.data.inFlight).toEqual([]);
    expect(session.data.inFlight).toEqual([pending]);
    const completed = { ...pending, status: "success" as const };
    await storage.write(() => [record, completed]);
    expect(session.data.usage).toEqual([record, completed]);
    expect(session.data.inFlight).toEqual([]);
    await storage.finish(pending.requestId, () => [record, completed]);
    expect(session.data.usage).toEqual([record, completed]);
  });
  it("leaves a durable pending checkpoint when recording a result fails and can finish it without replaying a request", async () => {
    const { storage, local } = fixture(true);
    const pending = {
      ...record,
      requestId: crypto.randomUUID(),
      status: "unknown" as const,
    };
    await storage.begin(pending);
    local.fail = true;
    const completed = { ...pending, status: "success" as const };
    await expect(storage.write(() => [record, completed])).rejects.toThrow(
      "Storage full",
    );
    expect(local.data.inFlight).toEqual([pending]);
    local.fail = false;
    await storage.finish(pending.requestId, () => [record, completed]);
    expect(local.data.inFlight).toEqual([]);
    expect(local.data.usage).toEqual([record, completed]);
  });
  it("keeps pending checkpoints in the original area when a preference migration fails", async () => {
    const { storage, settings, local, session } = fixture(true);
    const pending = {
      ...record,
      requestId: crypto.randomUUID(),
      status: "unknown" as const,
    };
    await storage.begin(pending);
    local.fail = true;
    await expect(
      storage.saveSettings({ ...settings, persistUsage: false }, () => [
        record,
      ]),
    ).rejects.toThrow("Storage full");
    expect(local.data.inFlight).toEqual([pending]);
    expect(session.data.inFlight).toBeUndefined();
    expect((local.data.settings as typeof settings).persistUsage).toBe(true);
  });
  it("retains records when moving in either direction and writes subsequent completions to the destination", async () => {
    const { storage, settings, local, session } = fixture();
    await storage.saveSettings({ ...settings, persistUsage: true }, () => [
      record,
    ]);
    expect(local.data.usage).toEqual([record]);
    expect(session.data.usage).toBeUndefined();
    await storage.saveSettings(settings, () => [record]);
    expect(local.data.usage).toEqual([]);
    expect(session.data.usage).toEqual([record]);
    const completed = { ...record, requestId: crypto.randomUUID() };
    await storage.write(() => [record, completed]);
    expect(session.data.usage).toEqual([record, completed]);
    expect(local.data.usage).toEqual([]);
  });
  it.each([false, true])(
    "keeps the original settings and records when a migration fails from persistent=%s",
    async (persistUsage) => {
      const { storage, settings, local, session } = fixture(persistUsage);
      local.fail = true;
      await expect(
        storage.saveSettings(
          { ...settings, persistUsage: !persistUsage },
          () => [record],
        ),
      ).rejects.toThrow("Storage full");
      expect(local.data.settings).toEqual(settings);
      expect((persistUsage ? local : session).data.usage).toEqual([record]);
      expect((persistUsage ? session : local).data.usage).toBeUndefined();
      local.fail = false;
      await storage.write(() => [record]);
      expect((persistUsage ? local : session).data.usage).toEqual([record]);
    },
  );
  it("serializes completion checkpoints behind a preference change", async () => {
    const { storage, settings, local, session } = fixture();
    const newer = { ...record, requestId: crypto.randomUUID() };
    await Promise.all([
      storage.saveSettings({ ...settings, persistUsage: true }, () => [record]),
      storage.write(() => [record, newer]),
    ]);
    expect(local.data.usage).toEqual([record, newer]);
    expect(session.data.usage).toBeUndefined();
  });
  it("keeps persistence enabled if the destination session storage cannot be written", async () => {
    const { storage, settings, local, session } = fixture(true);
    session.fail = true;
    await expect(
      storage.saveSettings({ ...settings, persistUsage: false }, () => [
        record,
      ]),
    ).rejects.toThrow("Storage full");
    expect(local.data.settings).toEqual(settings);
    expect(local.data.usage).toEqual([record]);
    session.fail = false;
    await storage.saveSettings({ ...settings, persistUsage: false }, () => [
      record,
    ]);
    expect(session.data.usage).toEqual([record]);
    expect(local.data.usage).toEqual([]);
  });
});
