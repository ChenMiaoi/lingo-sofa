import { expect, it } from "vitest";
import {
  runDataCleanup,
  type CleanupTarget,
} from "../apps/browser-extension/src/data-cleanup.js";
it("reports partial cleanup and retries only failed targets", async () => {
  const calls: CleanupTarget[] = [];
  let fail = true;
  const steps = {
    "browser-data": async () => {
      calls.push("browser-data");
    },
    "translation-cache": async () => {
      calls.push("translation-cache");
    },
    "assistant-data": async () => {
      calls.push("assistant-data");
      if (fail) throw new Error("Assistant unavailable");
    },
  };
  const results = await runDataCleanup(steps);
  expect(results).toEqual([
    { target: "browser-data", ok: true },
    { target: "translation-cache", ok: true },
    { target: "assistant-data", ok: false, error: "Assistant unavailable" },
  ]);
  fail = false;
  const retry = results.filter((item) => !item.ok).map((item) => item.target);
  expect(await runDataCleanup(steps, retry)).toEqual([
    { target: "assistant-data", ok: true },
  ]);
  expect(calls).toEqual([
    "browser-data",
    "translation-cache",
    "assistant-data",
    "assistant-data",
  ]);
});
it("validates all targets before deleting anything", async () => {
  let called = false;
  const steps = {
    "browser-data": async () => {
      called = true;
    },
  };
  for (const targets of [
    [],
    ["browser-data", "unexpected"],
    "browser-data",
    [null],
  ])
    await expect(runDataCleanup(steps, targets)).rejects.toThrow(
      "无效的清理项目",
    );
  expect(called).toBe(false);
});
