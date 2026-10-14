import { it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageHistory } from "../apps/pi-bridge/src/history.js";
import type { UsageRecord } from "@lingo-sofa/protocol";
it("checkpoints unknown consumption, restores without replay and deletes opted-out history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-history-"));
  const record: UsageRecord = {
    requestId: crypto.randomUUID(),
    scope: "web:fixture",
    provider: "fixture",
    model: "fixture",
    mode: "bridge",
    sourceKind: "web",
    status: "unknown",
    timestamp: Date.now(),
    usage: null,
    costKnown: false,
    durationMs: 0,
    firstOutputMs: null,
    firstTextMs: null,
    generationMs: null,
    tps: null,
  };
  try {
    const history = new UsageHistory(directory, true);
    await history.save([record]);
    expect(new UsageHistory(directory, true).read()).toEqual([record]);
    await Promise.all([
      history.save([{ ...record, status: "failed" }]),
      history.save([{ ...record, status: "cancelled" }]),
    ]);
    expect(history.read()[0]?.status).toBe("cancelled");
    const raw = await readFile(join(directory, "usage.json"), "utf8");
    expect(raw).not.toMatch(/apiKey|context|question|text/);
    if (process.platform !== "win32")
      expect((await stat(join(directory, "usage.json"))).mode & 0o777).toBe(
        0o600,
      );
    expect(new UsageHistory(directory, false).read()).toEqual([]);
    await expect(readFile(join(directory, "usage.json"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
